'use strict';
/**
 * 分段协作校对：数据层。
 *
 * 不变量：
 *  - 批次从任意历史版本创建，创建时冻结基准快照与切片；此后项目继续编辑不影响批次。
 *  - 片段时间区间连续不重叠，跨轨交叠字幕必在同一片段；组织者可合并相邻片段/按句拆分。
 *  - 领取有明确到期时间（批次默认 ttl，可续期），条件 UPDATE 保证并发领取只有一方成功；
 *    过期在读取/写入时即时换算，不依赖后台扫描；claim_seq 每次易主 +1，
 *    旧领取人的迟到提交/保存一律拒绝（claim-seq 失配），不可能覆盖新人草稿。
 *  - 每人每片段一份草稿（proof_drafts），释放/过期/被改派后草稿保留，再次领取自动续作。
 *  - 提交冻结内容；client_token 在（批次,片段,动作）内唯一，重复请求不产生重复提交。
 *  - 退回附理由并给领取人新一轮有效期；可改后再次提交（新一行提交记录）。
 *  - 一次接受多个片段：逐片段三向合并，逐段报告可自动合入/需人工处理；任一冲突未解则
 *    整个事务不写入（不会部分写入）；接受成功生成一个新版本（kind=proof）。
 *  - 所有操作进 proof_events（自增 id 即审计顺序）；SQLite 落盘保证重启后期限、草稿、
 *    提交记录与审计顺序一致。
 */
const crypto = require('crypto');
const { db } = require('../db');
const store = require('../store');
const { planSegments } = require('./segments');
const { mergeSnapshots } = require('../merge');
const { normalizeSnapshot, validate } = require('../validation');

const now = () => Date.now();
const bid = () => 'pb_' + crypto.randomBytes(9).toString('hex');
const segId = () => 'ps_' + crypto.randomBytes(9).toString('hex');
const subId = () => 'pu_' + crypto.randomBytes(9).toString('hex');
const draftId = () => 'pd_' + crypto.randomBytes(9).toString('hex');

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 默认领取有效期 30 分钟
const MAX_TTL_MS = 7 * 24 * 3600 * 1000;

const SEG_FIELDS = ['start', 'end', 'text', 'locked'];

class ProofError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ================================ 基础读取 ================================ */

function getBatchRow(batchId) {
  return db.prepare('SELECT * FROM proof_batches WHERE id = ?').get(batchId);
}
function mustBatch(projectId, batchId) {
  const row = getBatchRow(batchId);
  if (!row || row.project_id !== projectId) throw new ProofError(404, '校对批次不存在');
  return row;
}
function getSegRow(segmentId) {
  return db.prepare('SELECT * FROM proof_segments WHERE id = ?').get(segmentId);
}
/** 以片段 id 为路径的路由：解析 (projectId, batchId)；片段不存在时 404。 */
function segContext(segmentId) {
  const row = getSegRow(segmentId);
  if (!row) throw new ProofError(404, '片段不存在');
  return { projectId: row.project_id, batchId: row.batch_id, row };
}
function mustSeg(batchId, segmentId) {
  const row = getSegRow(segmentId);
  if (!row || row.batch_id !== batchId) throw new ProofError(404, '片段不存在');
  return row;
}
function parseJson(v, fallback) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

/* ================================ 事件与审计 ================================ */

function addEvent(batchId, projectId, action, actor, detail, { segmentId = null, clientToken = null } = {}) {
  db.prepare(
    `INSERT INTO proof_events (project_id, batch_id, segment_id, action, actor, detail, client_token, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(projectId, batchId, segmentId, action, actor, detail ? JSON.stringify(detail) : null, clientToken || null, now());
}

function findTokenEvent(batchId, segmentId, action, token) {
  if (!token) return null;
  return db.prepare(
    'SELECT * FROM proof_events WHERE batch_id = ? AND segment_id IS ? AND action = ? AND client_token = ?',
  ).get(batchId, segmentId, action, token);
}

/** 关键操作同步进项目审计表（片段细节以 proof_events 为准）。 */
function projectAudit(projectId, action, newValue, actor) {
  const project = store.getProject(projectId);
  if (!project) return;
  store.writeAudit(projectId, project.head_id, [
    { field: `proof:${action}`, action: 'edit', oldValue: null, newValue: typeof newValue === 'string' ? newValue : JSON.stringify(newValue) },
  ], actor);
}

function isTokenDup(e) {
  return String(e?.message || '').includes('uq_pe_token');
}

/* ================================ 状态换算 ================================ */

/**
 * 有效状态：列状态 + 领取期限即时换算。
 * 返回 {status, claimActive, expiresAt}。过期领取在任何写入前都会被拒。
 */
function effectiveStatus(row, t = now()) {
  const active = Boolean(row.assignee && row.claim_expires_at && row.claim_expires_at > t);
  if (row.status === 'editing') return { status: active ? 'editing' : 'unclaimed', claimActive: active, expiresAt: row.claim_expires_at };
  if (row.status === 'returned') return { status: active ? 'returned' : 'unclaimed', claimActive: active, expiresAt: row.claim_expires_at };
  return { status: row.status, claimActive: active, expiresAt: row.claim_expires_at };
}

function segView(row, { viewer = '', t = now() } = {}) {
  const eff = effectiveStatus(row, t);
  const cueIds = parseJson(row.cue_ids, []);
  const base = parseJson(row.baseline, []);
  const draft = parseJson(row.draft_snapshot, null);
  return {
    id: row.id,
    batchId: row.batch_id,
    seq: row.seq,
    startMs: row.start_ms,
    endMs: row.end_ms,
    cueIds,
    cueCount: cueIds.length,
    trackNames: [...new Set(base.map((b) => b.trackName))],
    status: eff.status,
    claimActive: eff.claimActive,
    assignee: row.assignee,
    claimExpiresAt: eff.claimActive ? eff.expiresAt : null,
    hasDraft: Boolean(draft),
    draftUpdatedAt: row.draft_updated_at,
    draftVersion: row.draft_version,
    returnReason: row.return_reason,
    returnedBy: row.returned_by,
    returnedAt: row.returned_at,
    mergedRevId: row.merged_rev_id,
    mergedAt: row.merged_at,
    // 非领取人不回传草稿内容，只回传状态；本人详情接口才给内容
    mine: viewer ? row.assignee === viewer && eff.claimActive : false,
  };
}

/* ================================ 创建批次 ================================ */

function normalizeTtl(ttlMs) {
  const v = Math.round(Number(ttlMs ?? DEFAULT_TTL_MS));
  if (!Number.isFinite(v) || v < 60000 || v > MAX_TTL_MS) throw new ProofError(400, `领取有效期应在 1 分钟 ~ ${Math.round(MAX_TTL_MS / 60000)} 分钟之间`);
  return v;
}

/**
 * 从任意历史版本创建校对批次：冻结快照，按空隙与最大时长自动切成连续不重叠片段。
 */
function createBatch(projectId, { revisionId, title, gapMs, maxSegmentMs, trackIds, ttlMs }, author) {
  const project = store.getProject(projectId);
  if (!project) throw new ProofError(404, '项目不存在');
  const rev = store.getRevision(revisionId);
  if (!rev || rev.project_id !== projectId) throw new ProofError(400, '基准版本无效');
  const actor = String(author || '匿名');

  let planned;
  try {
    planned = planSegments(rev.snapshot, {
      gapMs, maxSegmentMs,
      trackIds: Array.isArray(trackIds) ? trackIds.map((x) => String(x || '')) : [],
    });
  } catch (e) {
    throw new ProofError(400, e.message);
  }
  if (!planned.segments.length) throw new ProofError(400, '所选版本/轨道没有可校对的字幕，无法创建批次');
  const ttl = normalizeTtl(ttlMs);

  const id = bid();
  const t = now();
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO proof_batches
         (id, project_id, title, base_rev_id, head_rev_id, status, frozen_snapshot,
          gap_ms, max_segment_ms, track_ids, ttl_ms, seg_count, created_by, created_at)
       VALUES (?,?,?,?,?, 'open', ?,?,?,?,?,?,?,?)`,
    ).run(
      id, projectId, String(title || '').trim().slice(0, 200), rev.id, project.head_id,
      JSON.stringify(rev.snapshot),
      planned.params.gapMs, planned.params.maxSegmentMs, JSON.stringify(planned.params.trackIds), ttl,
      planned.segments.length, actor, t,
    );
    const insertSeg = db.prepare(
      `INSERT INTO proof_segments
         (id, batch_id, project_id, seq, start_ms, end_ms, cue_ids, baseline,
          status, claim_seq, draft_version, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'unclaimed',0,0,?)`,
    );
    for (const s of planned.segments) {
      insertSeg.run(
        segId(), id, projectId, s.seq, s.startMs, s.endMs,
        JSON.stringify(s.cueIds), JSON.stringify(s.cues), t,
      );
    }
    addEvent(id, projectId, 'create', actor, {
      title: String(title || '').trim().slice(0, 200),
      baseRevId: rev.id, headRevId: project.head_id,
      gapMs: planned.params.gapMs, maxSegmentMs: planned.params.maxSegmentMs,
      trackIds: planned.params.trackIds, ttlMs: ttl,
      segmentCount: planned.segments.length,
    });
  });
  txn();
  projectAudit(projectId, 'batch-create', { batchId: id, segmentCount: planned.segments.length, baseRevId: rev.id }, actor);
  return { batch: batchDetail(getBatchRow(id), {}).batch };
}

/* ================================ 批次总览 ================================ */

function progressCounts(batchId) {
  const rows = db.prepare('SELECT status, assignee, claim_expires_at FROM proof_segments WHERE batch_id = ?').all(batchId);
  const c = { unclaimed: 0, editing: 0, review: 0, returned: 0, merged: 0 };
  const byAssignee = {};
  for (const r of rows) {
    const eff = effectiveStatus(r).status;
    c[eff] = (c[eff] || 0) + 1;
    if (r.assignee) {
      byAssignee[r.assignee] = byAssignee[r.assignee] || { editing: 0, review: 0, returned: 0, merged: 0 };
      if (eff in byAssignee[r.assignee]) byAssignee[r.assignee][eff]++;
    }
  }
  return { counts: c, byAssignee, total: rows.length };
}

function batchMeta(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    baseRevId: row.base_rev_id,
    headRevIdAtCreate: row.head_rev_id,
    headMoved: store.getProject(row.project_id)?.head_id !== row.head_rev_id,
    gapMs: row.gap_ms,
    maxSegmentMs: row.max_segment_ms,
    trackIds: parseJson(row.track_ids, []),
    ttlMs: row.ttl_ms,
    segCount: row.seg_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function batchDetail(row, { status = '', assignee = '', viewer = '' } = {}) {
  let segRows = db.prepare('SELECT * FROM proof_segments WHERE batch_id = ? ORDER BY seq ASC').all(row.id);
  const base = store.getRevision(row.base_rev_id);
  const headId = store.getProject(row.project_id)?.head_id;
  const baseChanged = headId !== row.base_rev_id;
  // 自批次创建后基准句是否已变化（HEAD 链上是否动过这些句子），逐段标注
  const changedCueIds = baseChanged ? cuesChangedBetween(row.project_id, row.base_rev_id, headId) : new Set();

  let segments = segRows.map((r) => {
    const v = segView(r, { viewer });
    v.baseChanged = parseJson(r.cue_ids, []).some((id) => changedCueIds.has(id));
    return v;
  });
  if (status) segments = segments.filter((s) => s.status === status);
  if (assignee) segments = segments.filter((s) => s.assignee === assignee);

  return {
    batch: {
      ...batchMeta(row),
      currentHeadRevId: headId,
      progress: progressCounts(row.id),
      baseRevision: base ? { id: base.id, author: base.author, message: base.message, createdAt: base.created_at } : null,
    },
    segments,
  };
}

function listBatches(projectId) {
  const rows = db.prepare('SELECT * FROM proof_batches WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(projectId);
  return { batches: rows.map((r) => ({ ...batchMeta(r), progress: progressCounts(r.id) })) };
}

/**
 * 基准版本到当前 HEAD 之间发生过变化（新增/修改/删除）的句子 id。
 * 取两版 cue id 集合并比较字段，供批次总览逐段提示「基准句已变化，合入时需关注冲突」。
 */
function cuesChangedBetween(projectId, fromRevId, toRevId) {
  const from = store.getRevision(fromRevId);
  const to = store.getRevision(toRevId);
  const changed = new Set();
  if (!from || !to) return changed;
  const a = new Map(from.snapshot.cues.map((c) => [c.id, c]));
  const b = new Map(to.snapshot.cues.map((c) => [c.id, c]));
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id);
    const y = b.get(id);
    if (!x || !y) { changed.add(id); continue; }
    if (SEG_FIELDS.some((f) => JSON.stringify(x[f]) !== JSON.stringify(y[f])) || x.trackId !== y.trackId) changed.add(id);
  }
  return changed;
}

/* ================================ 片段详情 / 个人待办 ================================ */

function listSubmissions(segmentId) {
  return db.prepare('SELECT * FROM proof_submissions WHERE segment_id = ? ORDER BY seq ASC').all(segmentId);
}

function submissionView(s) {
  return {
    id: s.id,
    seq: s.seq,
    reviewer: s.reviewer,
    status: s.status,
    submittedAt: s.submitted_at,
    draftVersion: s.draft_version,
    decidedBy: s.decided_by,
    decidedAt: s.decided_at,
    returnReason: s.return_reason,
    mergedRevId: s.merged_rev_id,
  };
}

/** 片段详情：基准内容、当前草稿（仅有效领取人本人给内容）、本人历史草稿、提交记录。 */
function segmentDetail(projectId, batchId, segmentId, viewer = '') {
  const batch = mustBatch(projectId, batchId);
  const row = mustSeg(batchId, segmentId);
  const view = segView(row, { viewer });
  view.baseChanged = batch.status === 'open'
    && parseJson(row.cue_ids, []).some((id) => cuesChangedBetween(projectId, batch.base_rev_id, store.getProject(projectId).head_id).has(id));

  const myDraftRow = viewer
    ? db.prepare('SELECT * FROM proof_drafts WHERE segment_id = ? AND reviewer = ?').get(segmentId, viewer)
    : null;
  const currentDraft = view.mine ? parseJson(row.draft_snapshot, null) : null;

  return {
    batch: batchMeta(batch),
    segment: {
      ...view,
      baseline: parseJson(row.baseline, []),
      currentDraft,
      myDraft: myDraftRow
        ? { content: parseJson(myDraftRow.content, []), version: myDraftRow.version, updatedAt: myDraftRow.updated_at }
        : null,
      submissions: listSubmissions(segmentId).map(submissionView),
    },
  };
}

/**
 * 个人待办：我持有效领取的片段（编辑中/退回）、我提交待审核的片段、可领取的空闲片段。
 */
function myTodos(reviewer, projectId = '') {
  const name = reviewerName(reviewer);
  const sql = `
    SELECT s.* FROM proof_segments s JOIN proof_batches b ON b.id = s.batch_id
    WHERE b.status = 'open' AND s.status != 'merged'
      ${projectId ? 'AND s.project_id = ?' : ''}
    ORDER BY s.updated_at DESC`;
  const rows = projectId ? db.prepare(sql).all(projectId) : db.prepare(sql).all();
  const held = [], returned = [], pending = [], claimable = [];
  for (const r of rows) {
    const eff = effectiveStatus(r);
    if (r.assignee === name && (eff.status === 'editing' || eff.status === 'returned')) {
      const v = segView(r, { viewer: name });
      (eff.status === 'returned' ? returned : held).push(v);
    } else if (r.status === 'review') {
      const last = db.prepare('SELECT reviewer FROM proof_submissions WHERE segment_id = ? ORDER BY seq DESC LIMIT 1').get(r.id);
      if (last && last.reviewer === name) pending.push(segView(r, { viewer: name }));
    } else if (eff.status === 'unclaimed') {
      claimable.push(segView(r));
    }
  }
  return { reviewer: name, todos: { editing: held, returned, pendingReview: pending, claimable } };
}

/* ================================ 领取 / 续期 / 释放 ================================ */

function reviewerName(v) {
  const name = String(v || '').trim();
  if (!name) throw new ProofError(400, '缺少审校人署名');
  return name.slice(0, 80);
}

function tokenDupResponse(batchId, segmentId, action, token, viewer) {
  const ev = findTokenEvent(batchId, segmentId, action, token);
  if (!ev) return null;
  return { deduplicated: true, segment: segView(mustSeg(batchId, segmentId), { viewer }) };
}

/**
 * 领取空闲片段。条件 UPDATE 保证并发只有一方成功；领取时恢复本人历史草稿。
 */
function claim(projectId, batchId, segmentId, reviewer, { clientToken } = {}) {
  const batch = mustBatch(projectId, batchId);
  if (batch.status !== 'open') throw new ProofError(409, '批次已结束，不能再领取', { code: 'batch-closed' });
  const row = mustSeg(batchId, segmentId);
  const name = reviewerName(reviewer);
  const token = clientToken ? String(clientToken) : null;
  if (token) {
    const dup = tokenDupResponse(batchId, segmentId, 'claim', token, name);
    if (dup) return dup;
  }
  const eff = effectiveStatus(row);
  if (row.status === 'merged') throw new ProofError(409, '片段已合入，不能领取', { code: 'merged' });
  if (row.status === 'review') throw new ProofError(409, '片段正在审核中，不能领取', { code: 'in-review' });
  if (eff.claimActive) {
    if (row.assignee === name) {
      // 本人重复领取：幂等返回当前状态，不续期（续期走 renew）
      return { deduplicated: true, segment: segView(row, { viewer: name }) };
    }
    throw new ProofError(409, `片段已被 ${row.assignee} 领取，到期后可再试`, {
      code: 'already-claimed', assignee: row.assignee, expiresAt: row.claim_expires_at,
    });
  }

  const t = now();
  const expiresAt = t + batch.ttl_ms;
  try {
    const txn = db.transaction(() => {
      // 条件更新：未领取或领取已过期才可能成功；并发时只有一方 changes=1
      const res = db.prepare(
        `UPDATE proof_segments
         SET status='editing', assignee=?, claim_expires_at=?, claim_seq=claim_seq+1,
             return_reason=NULL, returned_by=NULL, returned_at=NULL, updated_at=?
         WHERE id=? AND status IN ('unclaimed','editing','returned')
           AND (assignee IS NULL OR claim_expires_at <= ?) AND status != 'review' AND status != 'merged'`,
      ).run(name, expiresAt, t, row.id, t);
      if (res.changes === 0) {
        const cur = getSegRow(row.id);
        throw new ProofError(409, `片段已被 ${cur?.assignee || '他人'} 抢先领取`, {
          code: 'already-claimed', assignee: cur?.assignee, expiresAt: cur?.claim_expires_at,
        });
      }
      // 恢复本人历史草稿（别人的草稿不受影响）；本人无草稿则清空工作草稿
      const myDraft = db.prepare('SELECT content, version, updated_at FROM proof_drafts WHERE segment_id = ? AND reviewer = ?')
        .get(row.id, name);
      if (myDraft) {
        db.prepare('UPDATE proof_segments SET draft_snapshot=?, draft_version=?, draft_updated_at=? WHERE id=?')
          .run(myDraft.content, myDraft.version, myDraft.updated_at, row.id);
      } else {
        db.prepare('UPDATE proof_segments SET draft_snapshot=NULL, draft_version=0, draft_updated_at=NULL WHERE id=?').run(row.id);
      }
      addEvent(batchId, projectId, 'claim', name, { expiresAt, resumedDraft: Boolean(myDraft) }, { segmentId: row.id, clientToken: token });
    });
    txn();
  } catch (e) {
    if (isTokenDup(e)) {
      const after = getSegRow(row.id);
      return { deduplicated: true, segment: segView(after, { viewer: name }) };
    }
    throw e;
  }
  projectAudit(projectId, 'claim', { batchId, segmentId, reviewer: name }, name);
  return { deduplicated: false, segment: segView(getSegRow(row.id), { viewer: name }), expiresAt };
}

/** 续期：只有当前有效领取人本人可以续；重复请求幂等。 */
function renew(projectId, batchId, segmentId, reviewer, { clientToken } = {}) {
  const batch = mustBatch(projectId, batchId);
  const row = mustSeg(batchId, segmentId);
  const name = reviewerName(reviewer);
  const token = clientToken ? String(clientToken) : null;
  if (token) {
    const dup = tokenDupResponse(batchId, segmentId, 'renew', token, name);
    if (dup) return dup;
  }
  const t = now();
  const eff = effectiveStatus(row, t);
  if (!eff.claimActive) throw new ProofError(410, '领取已过期或不存在，请重新领取后再续期', { code: 'claim-expired' });
  if (row.assignee !== name) throw new ProofError(403, '只有当前领取人可以续期', { code: 'not-claimant' });

  const expiresAt = t + batch.ttl_ms;
  try {
    const txn = db.transaction(() => {
      const res = db.prepare(
        'UPDATE proof_segments SET claim_expires_at=?, updated_at=? WHERE id=? AND assignee=? AND claim_expires_at > ?',
      ).run(expiresAt, t, row.id, name, t);
      if (res.changes === 0) throw new ProofError(409, '领取状态已变化，请刷新后重试', { code: 'claim-changed' });
      addEvent(batchId, projectId, 'renew', name, { expiresAt }, { segmentId: row.id, clientToken: token });
    });
    txn();
  } catch (e) {
    if (isTokenDup(e)) return { deduplicated: true, segment: segView(getSegRow(row.id), { viewer: name }) };
    throw e;
  }
  return { deduplicated: false, segment: segView(getSegRow(row.id), { viewer: name }), expiresAt };
}

/** 主动释放：仅当前有效领取人；草稿保留，片段回到空闲。 */
function release(projectId, batchId, segmentId, reviewer, { clientToken } = {}) {
  const batch = mustBatch(projectId, batchId);
  const row = mustSeg(batchId, segmentId);
  const name = reviewerName(reviewer);
  const token = clientToken ? String(clientToken) : null;
  if (token) {
    const dup = tokenDupResponse(batchId, segmentId, 'release', token, name);
    if (dup) return dup;
  }
  const t = now();
  const eff = effectiveStatus(row, t);
  if (!eff.claimActive) {
    // 已过期：释放是幂等的（目标状态即空闲），但不写重复事件
    return { deduplicated: true, segment: segView(getSegRow(row.id), { viewer: name }) };
  }
  if (row.assignee !== name) throw new ProofError(403, '只有当前领取人可以释放', { code: 'not-claimant' });
  if (row.status === 'review') throw new ProofError(409, '已提交待审核的片段不能自行释放，请等待审核结果', { code: 'in-review' });

  try {
    const txn = db.transaction(() => {
      const res = db.prepare(
        `UPDATE proof_segments
         SET status='unclaimed', assignee=NULL, claim_expires_at=NULL, updated_at=?
         WHERE id=? AND assignee=? AND claim_expires_at > ? AND status IN ('editing','returned')`,
      ).run(t, row.id, name, t);
      if (res.changes === 0) throw new ProofError(409, '领取状态已变化，请刷新后重试', { code: 'claim-changed' });
      addEvent(batchId, projectId, 'release', name, {}, { segmentId: row.id, clientToken: token });
    });
    txn();
  } catch (e) {
    if (isTokenDup(e)) return { deduplicated: true, segment: segView(getSegRow(row.id), { viewer: name }) };
    throw e;
  }
  projectAudit(projectId, 'release', { batchId, segmentId, reviewer: name }, name);
  return { deduplicated: false, segment: segView(getSegRow(row.id), { viewer: name }) };
}

/* ================================ 组织者指派 / 重新指派 ================================ */

/**
 * 组织者直接指派。空闲片段 → assign；他人编辑中/退回片段 → reassign（保留原草稿，
 * 被指派人恢复其本人草稿并获得一整轮新有效期）；待审核/已合入片段必须先退回，不能指派。
 */
function assign(projectId, batchId, segmentId, { assignee }, author) {
  const batch = mustBatch(projectId, batchId);
  if (batch.status !== 'open') throw new ProofError(409, '批次已结束', { code: 'batch-closed' });
  const row = mustSeg(batchId, segmentId);
  const target = reviewerName(assignee);
  const actor = String(author || '匿名');
  const t = now();

  if (row.status === 'merged') throw new ProofError(409, '片段已合入，不能指派', { code: 'merged' });
  if (row.status === 'review') throw new ProofError(409, '片段待审核：请先退回再改派', { code: 'in-review' });
  const eff = effectiveStatus(row, t);
  const reassigned = eff.claimActive && row.assignee !== target;
  if (eff.claimActive && row.assignee === target) {
    throw new ProofError(409, `${target} 当前持有该片段，无需指派`, { code: 'already-claimant' });
  }

  const expiresAt = t + batch.ttl_ms;
  const txn = db.transaction(() => {
    const res = db.prepare(
      `UPDATE proof_segments
       SET status='editing', assignee=?, claim_expires_at=?, claim_seq=claim_seq+1,
           return_reason=NULL, returned_by=NULL, returned_at=NULL, updated_at=?
       WHERE id=? AND status IN ('unclaimed','editing','returned')`,
    ).run(target, expiresAt, t, row.id);
    if (res.changes === 0) throw new ProofError(409, '片段状态已变化，请刷新后重试', { code: 'status-changed' });
    const myDraft = db.prepare('SELECT content, version, updated_at FROM proof_drafts WHERE segment_id=? AND reviewer=?')
      .get(row.id, target);
    if (myDraft) {
      db.prepare('UPDATE proof_segments SET draft_snapshot=?, draft_version=?, draft_updated_at=? WHERE id=?')
        .run(myDraft.content, myDraft.version, myDraft.updated_at, row.id);
    } else {
      db.prepare('UPDATE proof_segments SET draft_snapshot=NULL, draft_version=0, draft_updated_at=NULL WHERE id=?').run(row.id);
    }
    addEvent(batchId, projectId, reassigned ? 'reassign' : 'assign', actor, {
      fromAssignee: row.assignee, toAssignee: target, resumedDraft: Boolean(myDraft), expiresAt,
    }, { segmentId: row.id });
  });
  txn();
  projectAudit(projectId, reassigned ? 'reassign' : 'assign',
    { batchId, segmentId, from: row.assignee, to: target }, actor);
  return { segment: segView(getSegRow(row.id), { viewer: target }), reassigned };
}

/* ================================ 草稿 ================================ */

/** 校验片段草稿：句子集合/顺序必须与基准一致，不允许增删句或改轨道，仅时间/文本/锁定可改。 */
function validateDraftContent(baselineArr, content) {
  if (!Array.isArray(content)) throw new ProofError(400, '草稿内容应为片段句子数组');
  const baseIds = baselineArr.map((b) => b.cue.id);
  const ids = content.map((c) => String(c?.id || ''));
  if (ids.length !== baseIds.length || ids.some((id, i) => id !== baseIds[i])) {
    throw new ProofError(400, '片段草稿的句子集合必须与基准完全一致（不能增删或重排句子）', {
      code: 'cue-set-mismatch', expected: baseIds, got: ids,
    });
  }
  const baseById = new Map(baselineArr.map((b) => [b.cue.id, b]));
  return content.map((c) => {
    const b = baseById.get(String(c.id));
    const start = Math.max(0, Math.round(Number(c.start) || 0));
    const end = Math.round(Number(c.end) || 0);
    if (end <= start) {
      throw new ProofError(400, `句子 ${c.id} 时间反向（结束 ${end} ≤ 开始 ${start}）`, { code: 'reverse' });
    }
    return {
      id: String(c.id),
      trackId: b.cue.trackId, // 轨道不可改
      start,
      end,
      text: String(c.text ?? ''),
      locked: Boolean(c.locked),
    };
  });
}

/** 把片段草稿 cues 覆盖回冻结快照，生成完整快照供规则校验与三向合并。 */
function overlayCues(frozenSnapshot, segmentCueIds, draftCues) {
  const byId = new Map(draftCues.map((c) => [c.id, c]));
  const snapshot = JSON.parse(JSON.stringify(frozenSnapshot));
  snapshot.cues = snapshot.cues.map((c) => (byId.has(c.id) ? { ...byId.get(c.id) } : c));
  return snapshot;
}

function requireActiveClaim(row, name) {
  const eff = effectiveStatus(row);
  if (row.status === 'merged') throw new ProofError(409, '片段已合入', { code: 'merged' });
  if (row.status === 'review') throw new ProofError(409, '片段已提交待审核，不能再编辑', { code: 'in-review' });
  if (!eff.claimActive) throw new ProofError(410, '领取已过期，请重新领取（你的草稿已保留）', { code: 'claim-expired' });
  if (row.assignee !== name) throw new ProofError(403, '只能编辑自己当前领取的片段', { code: 'not-claimant' });
}

/**
 * 保存草稿：乐观锁（baseVersion）+ 令牌幂等。过期/非本人一律拒绝；不触碰他人草稿。
 */
function saveDraft(projectId, batchId, segmentId, { reviewer, content, baseVersion, clientToken }) {
  mustBatch(projectId, batchId);
  const row = mustSeg(batchId, segmentId);
  const name = reviewerName(reviewer);
  const token = clientToken ? String(clientToken) : null;
  if (token) {
    const dup = tokenDupResponse(batchId, segmentId, 'draft-save', token, name);
    if (dup) return { deduplicated: true, ...draftSaveView(row.id, name) };
  }
  requireActiveClaim(row, name);
  const baseline = parseJson(row.baseline, []);
  const clean = validateDraftContent(baseline, content);

  // 完整快照校验：拒绝反向区间等硬错误（重叠等警告允许保存，与主编辑器一致）
  const batch = getBatchRow(batchId);
  const hard = validate(overlayCues(parseJson(batch.frozen_snapshot), parseJson(row.cue_ids, []), clean)).hardErrors;
  if (hard.length) throw new ProofError(400, '草稿存在硬错误（反向区间），无法保存', { code: 'hard-error', hardErrors: hard });

  const base = Number.isInteger(baseVersion) ? baseVersion : null;
  const existing = db.prepare('SELECT * FROM proof_drafts WHERE segment_id=? AND reviewer=?').get(segmentId, name);
  const expectedVersion = existing ? existing.version : 0;
  if (base !== null && base !== expectedVersion) {
    throw new ProofError(409, '草稿在别处已被更新，请刷新后基于最新草稿继续', {
      code: 'version-conflict', current: { version: expectedVersion },
    });
  }

  const t = now();
  const payload = JSON.stringify(clean);
  try {
    const txn = db.transaction(() => {
      if (!existing) {
        db.prepare(
          `INSERT INTO proof_drafts (id, segment_id, batch_id, project_id, reviewer, content, version, created_at, updated_at)
           VALUES (?,?,?,?,?,? ,1,?,?)`,
        ).run(draftId(), segmentId, batchId, projectId, name, payload, t, t);
        db.prepare(
          `UPDATE proof_segments SET draft_snapshot=?, draft_version=1, draft_updated_at=?, updated_at=? WHERE id=?`,
        ).run(payload, t, t, segmentId);
      } else {
        const r1 = db.prepare('UPDATE proof_drafts SET content=?, version=version+1, updated_at=? WHERE id=? AND version=?')
          .run(payload, t, existing.id, existing.version);
        if (r1.changes === 0) throw new ProofError(409, '草稿在别处已被更新，请刷新后重试', { code: 'version-conflict' });
        const r2 = db.prepare(
          `UPDATE proof_segments SET draft_snapshot=?, draft_version=draft_version+1, draft_updated_at=?, updated_at=?
           WHERE id=? AND assignee=? AND claim_expires_at > ?`,
        ).run(payload, t, t, segmentId, name, t);
        if (r2.changes === 0) {
          // 领取在此期间失效/易主：草稿（按人）已更新，但不能覆盖片段当前草稿
          throw new ProofError(410, '领取已失效，未写入片段工作草稿（你的草稿已保留，重新领取后续作）', {
            code: 'claim-expired',
          });
        }
      }
      addEvent(batchId, projectId, 'draft-save', name, { version: existing ? existing.version + 1 : 1 },
        { segmentId, clientToken: token });
    });
    txn();
  } catch (e) {
    if (isTokenDup(e)) return { deduplicated: true, ...draftSaveView(segmentId, name) };
    throw e;
  }
  return { deduplicated: false, ...draftSaveView(segmentId, name) };
}

function draftSaveView(segmentId, name) {
  const d = db.prepare('SELECT version, updated_at FROM proof_drafts WHERE segment_id=? AND reviewer=?').get(segmentId, name);
  return { draftVersion: d?.version || 0, draftUpdatedAt: d?.updated_at || null, segment: segView(getSegRow(segmentId), { viewer: name }) };
}

/* ================================ 提交 / 退回 / 再次提交 ================================ */

/**
 * 提交审核：冻结当前草稿为新一行提交记录。同令牌/已提交状态重复请求幂等返回原记录。
 * 过期领取的提交一律拒绝（claim-seq 失配），且不可能覆盖别人的草稿。
 */
function submit(projectId, batchId, segmentId, { reviewer, clientToken }) {
  const batch = mustBatch(projectId, batchId);
  const row = mustSeg(batchId, segmentId);
  const name = reviewerName(reviewer);
  const token = clientToken ? String(clientToken) : null;
  if (token) {
    const ev = findTokenEvent(batchId, segmentId, 'submit', token);
    if (ev) return { deduplicated: true, submission: lastSubmissionView(segmentId), segment: segView(getSegRow(segmentId), { viewer: name }) };
  }
  requireActiveClaim(row, name);

  const draft = db.prepare('SELECT * FROM proof_drafts WHERE segment_id=? AND reviewer=?').get(segmentId, name);
  if (!draft) throw new ProofError(400, '还没有保存过草稿，不能提交', { code: 'no-draft' });

  const t = now();
  let newSeq;
  try {
    const txn = db.transaction(() => {
      // 条件更新锁死：当前领取人、领取未过期、非审核态；并发/过期场景 changes=0
      const res = db.prepare(
        `UPDATE proof_segments SET status='review', updated_at=?
         WHERE id=? AND assignee=? AND claim_expires_at > ? AND status IN ('editing','returned')`,
      ).run(t, segmentId, name, t);
      if (res.changes === 0) {
        const cur = getSegRow(segmentId);
        if (effectiveStatus(cur).status === 'review') {
          throw new ProofError(409, '片段已提交，请勿重复提交', { code: 'already-submitted' });
        }
        throw new ProofError(410, '领取已过期或已易主，请重新领取后提交', { code: 'claim-expired' });
      }
      newSeq = (db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM proof_submissions WHERE segment_id=?').get(segmentId).n);
      db.prepare(
        `INSERT INTO proof_submissions
           (id, segment_id, batch_id, project_id, seq, reviewer, snapshot, draft_version,
            claim_seq, status, submitted_at)
         VALUES (?,?,?,?,?,?,?, ?,?,'submitted',?)`,
      ).run(subId(), segmentId, batchId, projectId, newSeq, name, draft.content, draft.version, row.claim_seq, t);
      addEvent(batchId, projectId, 'submit', name, { seq: newSeq, draftVersion: draft.version },
        { segmentId, clientToken: token });
    });
    txn();
  } catch (e) {
    if (isTokenDup(e)) {
      return { deduplicated: true, submission: lastSubmissionView(segmentId), segment: segView(getSegRow(segmentId), { viewer: name }) };
    }
    throw e;
  }
  projectAudit(projectId, 'submit', { batchId, segmentId, reviewer: name, seq: newSeq }, name);
  return { deduplicated: false, submission: lastSubmissionView(segmentId), segment: segView(getSegRow(segmentId), { viewer: name }) };
}

function lastSubmissionView(segmentId) {
  const s = db.prepare('SELECT * FROM proof_submissions WHERE segment_id=? ORDER BY seq DESC LIMIT 1').get(segmentId);
  return s ? submissionView(s) : null;
}

/** 组织者退回（必填理由）：片段回到退回人手中并给一整轮新有效期，可改后再次提交。 */
function returnSegment(projectId, batchId, segmentId, { reason }, author) {
  const batch = mustBatch(projectId, batchId);
  const row = mustSeg(batchId, segmentId);
  const why = String(reason || '').trim();
  if (!why) throw new ProofError(400, '退回必须填写理由');
  if (row.status !== 'review') throw new ProofError(409, '只有待审核片段可以退回', { code: 'not-in-review' });
  const actor = String(author || '匿名');
  const t = now();
  const expiresAt = t + batch.ttl_ms;

  const txn = db.transaction(() => {
    const last = db.prepare('SELECT * FROM proof_submissions WHERE segment_id=? ORDER BY seq DESC LIMIT 1').get(segmentId);
    if (!last || last.status !== 'submitted') throw new ProofError(409, '没有待处理的提交', { code: 'not-in-review' });
    db.prepare(
      `UPDATE proof_submissions SET status='returned', decided_by=?, decided_at=?, return_reason=? WHERE id=?`,
    ).run(actor, t, why, last.id);
    const res = db.prepare(
      `UPDATE proof_segments
       SET status='returned', assignee=?, claim_expires_at=?, claim_seq=claim_seq+1,
           return_reason=?, returned_by=?, returned_at=?, updated_at=?
       WHERE id=? AND status='review'`,
    ).run(last.reviewer, expiresAt, why, actor, t, t, segmentId);
    if (res.changes === 0) throw new ProofError(409, '片段状态已变化，请刷新后重试', { code: 'status-changed' });
    addEvent(batchId, projectId, 'return', actor, {
      seq: last.seq, reviewer: last.reviewer, reason: why, expiresAt,
    }, { segmentId });
  });
  txn();
  projectAudit(projectId, 'return', { batchId, segmentId, reason: why }, actor);
  return { segment: segView(getSegRow(segmentId), { viewer: row.assignee }), submission: lastSubmissionView(segmentId) };
}

/* ================================ 合并 / 拆分片段 ================================ */

function ensureUnclaimedUnworked(row) {
  if (row.status === 'merged') throw new ProofError(409, '片段已合入，不能调整', { code: 'merged' });
  if (effectiveStatus(row).claimActive) throw new ProofError(409, '片段在领取中：请先由领取人释放或改派为空闲后再调整', { code: 'claimed' });
  if (row.status === 'review') throw new ProofError(409, '片段待审核：请先退回并释放后再调整', { code: 'in-review' });
  const used = db.prepare('SELECT COUNT(*) AS n FROM proof_drafts WHERE segment_id=?').get(row.id).n
    + db.prepare('SELECT COUNT(*) AS n FROM proof_submissions WHERE segment_id=?').get(row.id).n;
  if (used) throw new ProofError(409, '片段已有草稿或提交历史，不能再合并/拆分（避免内容丢失）', { code: 'has-work' });
}

function renumber(batchId) {
  // 两阶段：先全部偏移到负序号避开唯一索引，再按时间顺序重排为 1..N
  const rows = db.prepare('SELECT id FROM proof_segments WHERE batch_id=? ORDER BY start_ms ASC, end_ms ASC, id ASC').all(batchId);
  rows.forEach((r, i) => db.prepare('UPDATE proof_segments SET seq = ? WHERE id = ?').run(-(i + 100000), r.id));
  const upd = db.prepare('UPDATE proof_segments SET seq=? WHERE id=?');
  rows.forEach((r, i) => upd.run(i + 1, r.id));
}

/**
 * 合并相邻两个片段：默认把 seq 与下一个空闲片段合并（只允许无草稿/提交的空闲片段）。
 */
function mergeAdjacent(projectId, batchId, segmentId, author) {
  const batch = mustBatch(projectId, batchId);
  if (batch.status !== 'open') throw new ProofError(409, '批次已结束', { code: 'batch-closed' });
  const row = mustSeg(batchId, segmentId);
  ensureUnclaimedUnworked(row);
  const next = db.prepare('SELECT * FROM proof_segments WHERE batch_id=? AND seq > ? ORDER BY seq ASC LIMIT 1')
    .get(batchId, row.seq);
  if (!next) throw new ProofError(400, '该片段后面没有可合并的相邻片段');
  ensureUnclaimedUnworked(next);

  const actor = String(author || '匿名');
  const txn = db.transaction(() => {
    const baseA = parseJson(row.baseline, []);
    const baseB = parseJson(next.baseline, []);
    const mergedBase = [...baseA, ...baseB];
    const ids = [...parseJson(row.cue_ids, []), ...parseJson(next.cue_ids, [])];
    db.prepare(
      `UPDATE proof_segments SET end_ms=?, cue_ids=?, baseline=?, updated_at=? WHERE id=?`,
    ).run(Math.max(row.end_ms, next.end_ms), JSON.stringify(ids), JSON.stringify(mergedBase), now(), row.id);
    db.prepare('DELETE FROM proof_segments WHERE id=?').run(next.id);
    renumber(batchId);
    addEvent(batchId, projectId, 'merge', actor, {
      keptSegmentId: row.id, mergedAwaySegmentId: next.id, cueIds: ids,
    }, { segmentId: row.id });
  });
  txn();
  return batchDetail(getBatchRow(batchId), {});
}

/**
 * 按句拆分：cueIdsFirst 为前半段包含的基准句 id（必须是基准顺序的一个非空前缀切片）。
 */
function splitSegment(projectId, batchId, segmentId, { cueIdsFirst }, author) {
  const batch = mustBatch(projectId, batchId);
  if (batch.status !== 'open') throw new ProofError(409, '批次已结束', { code: 'batch-closed' });
  const row = mustSeg(batchId, segmentId);
  ensureUnclaimedUnworked(row);
  const wanted = new Set((Array.isArray(cueIdsFirst) ? cueIdsFirst : []).map((x) => String(x || '')));
  if (!wanted.size) throw new ProofError(400, '缺少 cueIdsFirst（前半段句子）');
  const baseline = parseJson(row.baseline, []);
  const cut = baseline.findIndex((b) => !wanted.has(b.cue.id));
  const firstPart = cut === -1 ? baseline : baseline.slice(0, cut);
  const secondPart = cut === -1 ? [] : baseline.slice(cut);
  if (!firstPart.length || !secondPart.length || firstPart.length + secondPart.length !== baseline.length) {
    throw new ProofError(400, 'cueIdsFirst 必须是基准句子顺序的一个非空前缀（从前到后连续的若干句）');
  }
  if (secondPart.some((b) => wanted.has(b.cue.id))) {
    throw new ProofError(400, '前半段必须连续，不能跳过中间句子');
  }

  const actor = String(author || '匿名');
  const t = now();
  const txn = db.transaction(() => {
    const endA = Math.max(...firstPart.map((b) => b.cue.end));
    const startB = Math.min(...secondPart.map((b) => b.cue.start));
    db.prepare(
      'UPDATE proof_segments SET end_ms=?, cue_ids=?, baseline=?, updated_at=? WHERE id=?',
    ).run(endA, JSON.stringify(firstPart.map((b) => b.cue.id)), JSON.stringify(firstPart), t, row.id);
    // 新片段插到 row 之后：临时 seq 取 -1，再统一重排
    db.prepare(
      `INSERT INTO proof_segments
         (id, batch_id, project_id, seq, start_ms, end_ms, cue_ids, baseline, status, claim_seq, draft_version, updated_at)
       VALUES (?,?,?, -1, ?,?,?,?,'unclaimed',0,0,?)`,
    ).run(segId(), batchId, projectId, startB, Math.max(...secondPart.map((b) => b.cue.end)),
      JSON.stringify(secondPart.map((b) => b.cue.id)), JSON.stringify(secondPart), t);
    renumber(batchId);
    addEvent(batchId, projectId, 'split', actor, {
      segmentId: row.id, newSegmentStartMs: startB,
      firstCueIds: firstPart.map((b) => b.cue.id), secondCueIds: secondPart.map((b) => b.cue.id),
    }, { segmentId: row.id });
  });
  txn();
  return batchDetail(getBatchRow(batchId), {});
}

/* ================================ 接受合入（多片段 → 一个新版本） ================================ */

/** 以基准为共同祖先，把单个片段的提交内容与当前 HEAD 三向合并，返回逐 cue 结果。 */
function mergeSegmentCues(batch, segRow, submission, headRev) {
  const frozen = parseJson(batch.frozen_snapshot);
  const submittedCues = parseJson(submission.snapshot, []);
  const segCueIds = parseJson(segRow.cue_ids, []);
  const mineSnap = overlayCues(frozen, segCueIds, submittedCues);
  const result = mergeSnapshots(frozen, mineSnap, headRev.snapshot);
  const idSet = new Set(segCueIds);

  // 三向合并产出的 cue 映射（冲突处为占位值，最终值由人工选择决定）
  const mergedById = new Map(result.snapshot.cues.map((c) => [c.id, c]));
  const baseById = new Map(frozen.cues.map((c) => [c.id, c]));
  const mineById = new Map(mineSnap.cues.map((c) => [c.id, c]));
  const headById = new Map(headRev.snapshot.cues.map((c) => [c.id, c]));

  const cueConflicts = [];
  for (const cf of result.conflicts) {
    if (cf.entity !== 'cue' || !idSet.has(cf.id)) continue;
    cueConflicts.push({
      cueId: cf.id,
      kind: cf.kind,
      fields: (cf.fields || []).map((f) => ({
        field: f.field, base: f.base, mine: f.mine, theirs: f.theirs,
      })),
      base: cf.base ? cueBrief(cf.base) : null,
      mine: cf.mine ? cueBrief(cf.mine) : null,
      theirs: cf.theirs ? cueBrief(cf.theirs) : null,
      merged: mergedById.has(cf.id) ? cueBrief(mergedById.get(cf.id)) : null,
    });
  }
  // 该片段修改过的 cue（mine 相对基准），用于统计与未变化判断
  const changedCueIds = [];
  for (const c of submittedCues) {
    const b = baseById.get(c.id);
    if (b && SEG_FIELDS.some((f) => JSON.stringify(b[f]) !== JSON.stringify(c[f]))) changedCueIds.push(c.id);
  }
  return { cueConflicts, changedCueIds, baseById, mineById, headById, mergedById };
}

function cueBrief(c) {
  if (!c) return null;
  return { id: c.id, trackId: c.trackId, start: c.start, end: c.end, text: c.text, locked: c.locked };
}

/**
 * 把单个片段的合并结果（含人工选择）应用到工作快照，只触碰该片段 cue 集合。
 * 选择：
 *   edit-edit      mine（以审校稿逐字段覆盖占位）| theirs（保留 HEAD）
 *   edit-delete    mine（恢复审校稿）| delete（接受 HEAD 的删除）
 *   delete-edit    固定 theirs（片段不允许删句，实际不会出现）
 *   orphan-cue     theirs（丢弃失去轨道的 cue）
 */
function applySegmentMerge(working, segCueIds, m, conflicts, resMap, segmentId) {
  const out = JSON.parse(JSON.stringify(working));
  const ids = new Set(segCueIds);
  const cfById = new Map(conflicts.map((cf) => [cf.cueId, cf]));
  const drop = new Set();
  // 先移除该片段在工作快照中的现有 cue（它们来自 HEAD 或前一片段，片段间不相交）
  out.cues = out.cues.filter((c) => !ids.has(c.id));
  const appended = [];
  for (const id of segCueIds) {
    const cf = cfById.get(id);
    if (!cf) {
      // 无冲突：三向合并结果（可能因 HEAD 删除而不存在）
      if (m.mergedById.has(id)) appended.push({ ...m.mergedById.get(id) });
      continue;
    }
    const choice = resMap.get(resolutionKey(segmentId, id));
    if ((cf.kind === 'edit-delete' && choice === 'delete') || (cf.kind === 'orphan-cue' && choice === 'theirs')) {
      drop.add(id);
      continue;
    }
    if (choice === 'mine' && m.mineById.has(id)) {
      appended.push({ ...m.mineById.get(id) });
    } else if (choice === 'theirs' && m.headById.has(id)) {
      appended.push({ ...m.headById.get(id) });
    } else if (m.mergedById.has(id)) {
      appended.push({ ...m.mergedById.get(id) });
    }
  }
  out.cues = out.cues.concat(appended.filter((c) => !drop.has(c.id)));
  out.cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

function resolutionKey(segmentId, cueId) { return `${segmentId}::${cueId}`; }

/**
 * 一次接受多个片段：
 *  1) 逐片段取最新提交、与当前 HEAD 三向合并；
 *  2) 任一片段有未解决冲突 → 409 返回逐段报告，整体不写入；
 *  3) 全部自动合入/冲突已人工选择 → 单事务生成一个新版本并逐片段标记 merged。
 * resolutions：{ [segmentId]: { [cueId]: 'mine'|'theirs'|'delete' } }（也接受数组）。
 */
function accept(projectId, { batchId, segmentIds, resolutions, author, message, clientToken }) {
  const project = store.getProject(projectId);
  if (!project) throw new ProofError(404, '项目不存在');
  const batch = mustBatch(projectId, batchId);

  // 令牌幂等先于状态校验：批次在上次接受后可能已完成，重发仍返回同一版本而非报错
  if (clientToken) {
    const ev = db.prepare("SELECT * FROM proof_events WHERE batch_id=? AND action='accept' AND client_token=? LIMIT 1")
      .get(batchId, String(clientToken));
    if (ev) {
      return { deduplicated: true, revisionId: ev.detail ? parseJson(ev.detail).revisionId : null };
    }
  }

  if (batch.status !== 'open') throw new ProofError(409, '批次已结束', { code: 'batch-closed' });
  const ids = [...new Set((Array.isArray(segmentIds) ? segmentIds : []).map(String))];
  if (!ids.length) throw new ProofError(400, '请选择至少一个待审核片段');

  // 取片段与最新提交（必须处于待审核）
  const targets = [];
  for (const id of ids) {
    const seg = mustSeg(batchId, id);
    if (seg.status === 'merged') throw new ProofError(400, `片段 #${seg.seq} 已合入`, { code: 'already-merged', segmentId: id });
    if (seg.status !== 'review') throw new ProofError(400, `片段 #${seg.seq} 不在待审核状态，不能接受`, { code: 'not-in-review', segmentId: id });
    const sub = db.prepare('SELECT * FROM proof_submissions WHERE segment_id=? ORDER BY seq DESC LIMIT 1').get(id);
    if (!sub || sub.status !== 'submitted') throw new ProofError(400, `片段 #${seg.seq} 没有待处理的提交`, { segmentId: id });
    targets.push({ seg, sub });
  }

  // 规范化人工选择
  const resMap = new Map();
  if (resolutions && typeof resolutions === 'object') {
    if (Array.isArray(resolutions)) {
      for (const r of resolutions) resMap.set(resolutionKey(String(r.segmentId), String(r.cueId)), String(r.choice));
    } else {
      for (const [sid, m] of Object.entries(resolutions)) {
        for (const [cid, choice] of Object.entries(m || {})) resMap.set(resolutionKey(sid, cid), String(choice));
      }
    }
  }

  const headAtPlan = store.getRevision(project.head_id);
  // 依次把每个片段的合并结果叠加（片段的 cue 集合互不相交）
  let working = JSON.parse(JSON.stringify(headAtPlan.snapshot));
  const report = [];
  const allConflicts = [];

  for (const { seg, sub } of targets) {
    const m = mergeSegmentCues(batch, seg, sub, headAtPlan);
    const segCueIds = parseJson(seg.cue_ids, []);
    const unresolved = [];
    for (const cf of m.cueConflicts) {
      const choice = resMap.get(resolutionKey(seg.id, cf.cueId));
      const validChoices = cf.kind === 'edit-delete' ? ['mine', 'delete']
        : cf.kind === 'orphan-cue' ? ['theirs'] : ['mine', 'theirs'];
      if (!choice || !validChoices.includes(choice)) {
        unresolved.push({ ...cf, validChoices });
        continue;
      }
      allConflicts.push({ segmentId: seg.id, seq: seg.seq, cueId: cf.cueId, choice });
    }
    const baseChanged = segCueIds.some((cid) =>
      cuesChangedBetween(projectId, batch.base_rev_id, headAtPlan.id).has(cid));

    if (unresolved.length) {
      report.push({
        segmentId: seg.id, seq: seg.seq, reviewer: sub.reviewer, result: 'conflict',
        baseChanged, changedCueIds: m.changedCueIds,
        conflicts: m.cueConflicts, unresolvedCueIds: unresolved.map((c) => c.cueId),
      });
    } else {
      // 应用本片段（含人工选择）到工作快照
      working = applySegmentMerge(working, segCueIds, m, m.cueConflicts, resMap, seg.id);
      report.push({
        segmentId: seg.id, seq: seg.seq, reviewer: sub.reviewer,
        result: m.changedCueIds.length ? 'auto' : 'unchanged',
        baseChanged, changedCueIds: m.changedCueIds,
        conflictCount: m.cueConflicts.length, resolvedCueIds: m.cueConflicts.map((c) => c.cueId),
      });
    }
  }

  const conflictReports = report.filter((r) => r.result === 'conflict');
  if (conflictReports.length) {
    // 逐段报告可自动合入与需要人工处理；不产生任何写入
    const err = new ProofError(409, `${conflictReports.length} 个片段存在需人工处理的冲突，已暂停合入（未写入任何内容）`, {
      code: 'conflicts',
      report,
      headRevId: headAtPlan.id,
      hint: '请逐段选择后携带 resolutions 重新发起接受；自动合入的片段也在同一事务中，未提交前不会部分写入',
    });
    throw err;
  }

  const realReports = report.filter((r) => r.result !== 'unchanged');
  if (!realReports.length) {
    throw new ProofError(400, '所选片段内容与基准一致，没有可合入的修改', { code: 'no-changes', report });
  }

  // 硬错误校验（反向区间等），通过后进入单事务提交
  let finalSnapshot;
  try {
    finalSnapshot = normalizeSnapshot(working);
  } catch (e) {
    throw new ProofError(400, '合入结果无效：' + e.message, { code: 'invalid-snapshot' });
  }
  const hard = validate(finalSnapshot).hardErrors;
  if (hard.length) throw new ProofError(400, '合入结果存在反向区间，已拒绝', { code: 'hard-error', hardErrors: hard, report });

  const actor = String(author || '匿名');
  const t = now();
  let revision;
  const txn = db.transaction(() => {
    // 提交前最后一次 HEAD 守卫：规划期间他人已写入则放弃，要求重新发起（无部分写入）
    if (store.getProject(projectId).head_id !== headAtPlan.id) {
      throw new ProofError(409, '规划合入期间项目产生了新版本，请重新发起接受以获取最新冲突报告', {
        code: 'head-moved', headRevId: store.getProject(projectId).head_id,
      });
    }
    revision = store.commitRevision({
      projectId,
      parent1: headAtPlan.id,
      parent2: batch.base_rev_id,
      kind: 'proof',
      snapshot: finalSnapshot,
      author: actor,
      message: message || `协作校对合入：接受 ${realReports.length} 个片段（批次 ${batch.title || batchId}）`,
      auditAgainst: headAtPlan.snapshot,
      meta: {
        kind: 'proof',
        batchId,
        segmentIds: realReports.map((r) => r.segmentId),
        segmentSeqs: realReports.map((r) => r.seq),
        reviewers: [...new Set(realReports.map((r) => r.reviewer))],
        conflictCount: allConflicts.length,
      },
    });
    for (const { seg, sub } of targets) {
      const r = report.find((x) => x.segmentId === seg.id);
      if (r.result === 'unchanged') continue; // 与基准一致：不标记 merged，组织者可退回或再次提交
      db.prepare(
        `UPDATE proof_segments
         SET status='merged', merged_rev_id=?, merged_at=?, claim_expires_at=NULL, updated_at=?
         WHERE id=? AND status='review'`,
      ).run(revision.id, t, t, seg.id);
      db.prepare("UPDATE proof_submissions SET status='accepted', decided_by=?, decided_at=?, merged_rev_id=? WHERE id=?")
        .run(actor, t, revision.id, sub.id);
      addEvent(batchId, projectId, 'accept', actor, {
        revisionId: revision.id, seq: sub.seq, conflictCueIds: r.conflictCount ? r.resolvedCueIds : [],
        changedCueIds: r.changedCueIds,
      }, { segmentId: seg.id, clientToken: clientToken ? String(clientToken) : null });
    }
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM proof_segments WHERE batch_id=? AND status != 'merged'").get(batchId).n;
    if (remaining === 0) {
      db.prepare("UPDATE proof_batches SET status='completed', completed_at=? WHERE id=?").run(t, batchId);
      addEvent(batchId, projectId, 'batch-complete', actor, { revisionId: revision.id });
    }
  });
  txn();
  projectAudit(projectId, 'accept', {
    batchId, revisionId: revision.id, segmentCount: realReports.length, conflictCount: allConflicts.length,
  }, actor);
  return {
    status: 'committed',
    revision,
    report,
    batchCompleted: db.prepare('SELECT status FROM proof_batches WHERE id=?').get(batchId).status === 'completed',
  };
}

/* ================================ 事件流 ================================ */

function listEvents(projectId, { batchId = '', limit = 500 } = {}) {
  const where = ['project_id = ?'];
  const params = [projectId];
  if (batchId) { where.push('batch_id = ?'); params.push(batchId); }
  params.push(Math.min(Number(limit) || 500, 2000));
  return {
    events: db.prepare(
      `SELECT id, project_id, batch_id, segment_id, action, actor, detail, created_at
       FROM proof_events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`,
    ).all(...params).map((e) => ({ ...e, detail: parseJson(e.detail, null) })),
  };
}

module.exports = {
  ProofError,
  createBatch,
  listBatches,
  getBatchRow,
  batchDetail,
  segContext,
  segmentDetail,
  myTodos,
  claim,
  renew,
  release,
  assign,
  saveDraft,
  submit,
  returnSegment,
  mergeAdjacent,
  splitSegment,
  accept,
  listEvents,
  // 测试用
  effectiveStatus,
  cuesChangedBetween,
};
