'use strict';
/**
 * 讨论串存储与并发控制。
 *
 * - 讨论可挂在单句（cue）或时间范围（range）上；
 * - 提交新版本时由提交钩子统一做跨版本跟随（match.js）：
 *   能唯一对应原字幕内容的自动跟随，删除/拆分/无法唯一匹配的进入 orphan（待重新定位）；
 * - 成员重新定位时写入 relocate 事件，保留旧位置、新位置和操作者；
 * - 所有写操作在事务内以「条件更新 WHERE version=?」实现乐观锁：
 *   并发回复/解决/重新打开/重新定位不会覆盖更新后的状态（失配返回 409 + 服务端当前状态）；
 * - 回复与重新定位携带 clientToken（项目内唯一索引）：重复请求返回原结果，不生成重复回复。
 */
const crypto = require('crypto');
const { db } = require('../db');
const store = require('../store');
const { resolveCueAnchor } = require('./match');

const now = () => Date.now();
const tid = () => 'd_' + crypto.randomBytes(9).toString('hex');
const eid = () => 'de_' + crypto.randomBytes(9).toString('hex');

class DiscError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function roundMs(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new DiscError(400, '时间必须为非负整数毫秒');
  return n;
}

function parseThread(row) {
  if (!row) return null;
  return {
    ...row,
    orphan_detail: row.orphan_detail ? JSON.parse(row.orphan_detail) : null,
  };
}

function getThreadRow(id) {
  return db.prepare('SELECT * FROM discussions WHERE id = ?').get(id);
}
function getThread(id) {
  return parseThread(getThreadRow(id));
}

/* ============================ 创建 ============================ */

/**
 * 创建讨论串。锚点必须能在项目 HEAD 中校验通过：
 *   cue   —— cueId 必须存在于 HEAD 快照；
 *   range —— 起止为非负毫秒、start < end、轨存在（trackId='' 表示全部轨）。
 */
function createThread(projectId, body, author) {
  const anchorType = body.anchorType === 'range' ? 'range' : 'cue';
  const title = String(body.title || '').trim().slice(0, 200);
  const text = String(body.body || '').trim();
  if (!text) throw new DiscError(400, '讨论内容不能为空');
  const actor = String(author || '匿名');

  const project = store.getProject(projectId);
  if (!project) throw new DiscError(404, '项目不存在');
  const head = store.getRevision(project.head_id);
  if (!head) throw new DiscError(409, '项目还没有可用版本');
  const snap = head.snapshot;

  let anchor;
  if (anchorType === 'cue') {
    const cueId = String(body.cueId || '');
    const cue = (snap.cues || []).find((c) => c.id === cueId);
    if (!cue) throw new DiscError(400, '锚点句子不存在（可能已被他人删除，请刷新后重新选择）', { code: 'anchor-missing' });
    anchor = {
      anchor_type: 'cue', anchor_id: cue.id, anchor_track: cue.trackId,
      anchor_start: cue.start, anchor_end: cue.end,
    };
  } else {
    const start = roundMs(body.start);
    const end = roundMs(body.end);
    if (end <= start) throw new DiscError(400, '时间范围无效：结束必须晚于开始');
    const trackId = body.trackId == null ? '' : String(body.trackId);
    if (trackId && !(snap.tracks || []).some((t) => t.id === trackId)) {
      throw new DiscError(400, '时间范围所在轨道不存在', { code: 'anchor-missing' });
    }
    anchor = {
      anchor_type: 'range', anchor_id: null, anchor_track: trackId,
      anchor_start: start, anchor_end: end,
    };
  }

  // clientToken 幂等：同令牌重复创建直接返回原讨论
  const token = body.clientToken ? String(body.clientToken) : null;
  if (token) {
    const existing = db
      .prepare(`SELECT de.discussion_id AS id FROM discussion_events de
                JOIN discussions d ON d.id = de.discussion_id
                WHERE de.project_id = ? AND de.client_token = ? AND de.kind = 'create'`)
      .get(projectId, token);
    if (existing) {
      return { thread: detail(projectId, existing.id), deduplicated: true };
    }
  }

  const id = tid();
  const t = now();
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO discussions
        (id, project_id, anchor_type, anchor_id, anchor_track, anchor_start, anchor_end,
         anchor_status, title, status, created_by, created_at, updated_at, version)
       VALUES (?,?,?,?,?,?,?, 'anchored', ?, 'open', ?, ?, ?, 0)`,
    ).run(
      id, projectId, anchor.anchor_type, anchor.anchor_id, anchor.anchor_track,
      anchor.anchor_start, anchor.anchor_end, title, actor, t, t,
    );
    insertEvent(id, projectId, 'create', actor, text, {
      anchorType: anchor.anchor_type,
      anchor: { cueId: anchor.anchor_id, track: anchor.anchor_track, start: anchor.anchor_start, end: anchor.anchor_end },
      revisionId: head.id,
    }, token);
    store.writeAudit(projectId, head.id, [
      {
        field: `discussion:${id}`, action: 'disc-create', oldValue: null,
        newValue: JSON.stringify({ anchorType: anchor.anchor_type, cueId: anchor.anchor_id, start: anchor.anchor_start, end: anchor.anchor_end, title }),
      },
    ], actor);
  });
  txn();
  return { thread: detail(projectId, id), deduplicated: false };
}

/* ============================ 事件写入 ============================ */

function insertEvent(threadId, projectId, kind, actor, body, detail, clientToken) {
  // 每讨论串递增序号：本函数总是在调用方事务内执行（better-sqlite3 同连接事务），
  // 若随后令牌冲突抛错，序号与事件一起随事务回滚，时间线严格按插入顺序展示
  const seqRow = db
    .prepare(`INSERT INTO discussion_event_seq (discussion_id, seq) VALUES (?, 1)
              ON CONFLICT(discussion_id) DO UPDATE SET seq = seq + 1 RETURNING seq`)
    .get(threadId);
  const ins = db.prepare(
    `INSERT INTO discussion_events (id, seq, discussion_id, project_id, kind, actor, body, detail, client_token, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  try {
    ins.run(eid(), seqRow.seq, threadId, projectId, kind, actor, body || '', detail ? JSON.stringify(detail) : null, clientToken || null, now());
  } catch (e) {
    if (String(e.message || '').includes('uq_discevent_token')) {
      const dup = db.prepare('SELECT * FROM discussion_events WHERE project_id=? AND client_token=?').get(projectId, clientToken);
      throw new DiscError(409, '重复请求，已返回原结果', { code: 'duplicate-request', eventId: dup?.id, discussionId: dup?.discussion_id });
    }
    throw e;
  }
}

/* ============================ 回复（乐观锁 + 令牌幂等） ============================ */

function reply(projectId, threadId, body, author) {
  const text = String(body.body || '').trim();
  if (!text) throw new DiscError(400, '回复内容不能为空');
  const actor = String(author || '匿名');
  const expectedVersion = Number.isInteger(body.expectedVersion) ? body.expectedVersion : null;
  const token = body.clientToken ? String(body.clientToken) : null;

  const row = getThreadRow(threadId);
  if (!row || row.project_id !== projectId) throw new DiscError(404, '讨论不存在');

  if (token) {
    const dup = db.prepare('SELECT * FROM discussion_events WHERE project_id=? AND client_token=?').get(projectId, token);
    if (dup) {
      if (dup.discussion_id !== threadId) throw new DiscError(409, '该请求已用于另一条讨论', { code: 'duplicate-request' });
      return { thread: detail(projectId, threadId), deduplicated: true };
    }
  }
  if (expectedVersion != null && row.version !== expectedVersion) {
    throw new DiscError(409, '讨论已有新的更新，请刷新后重试', { code: 'version-conflict', current: getThread(threadId) });
  }

  const t = now();
  try {
    const txn = db.transaction(() => {
      const res = db.prepare(
        `UPDATE discussions SET version = version + 1, updated_at = ?
         WHERE id = ? AND project_id = ? AND version = ?`,
      ).run(t, threadId, projectId, row.version);
      if (res.changes === 0) {
        throw new DiscError(409, '讨论已有新的更新，请刷新后重试', { code: 'version-conflict', current: getThread(threadId) });
      }
      insertEvent(threadId, projectId, 'message', actor, text, null, token);
    });
    txn();
  } catch (e) {
    if (e instanceof DiscError && e.extra?.code === 'duplicate-request') {
      return { thread: detail(projectId, threadId), deduplicated: true };
    }
    throw e;
  }
  return { thread: detail(projectId, threadId), deduplicated: false };
}

/* ============================ 解决 / 重新打开 ============================ */

function changeStatus(projectId, threadId, to, body, author) {
  const actor = String(author || '匿名');
  const expectedVersion = Number.isInteger(body.expectedVersion) ? body.expectedVersion : null;
  const token = body.clientToken ? String(body.clientToken) : null;

  const row = getThreadRow(threadId);
  if (!row || row.project_id !== projectId) throw new DiscError(404, '讨论不存在');

  if (token) {
    const dup = db.prepare('SELECT * FROM discussion_events WHERE project_id=? AND client_token=?').get(projectId, token);
    if (dup && dup.discussion_id === threadId) return { thread: detail(projectId, threadId), deduplicated: true };
  }
  if (row.status === to) {
    // 状态已被并发请求改成目标值：不重复写事件，返回当前状态（重复/并发请求幂等）
    return { thread: detail(projectId, threadId), deduplicated: true, already: true };
  }
  if (expectedVersion != null && row.version !== expectedVersion) {
    throw new DiscError(409, '讨论状态已被他人更新，请刷新后重试', { code: 'version-conflict', current: getThread(threadId) });
  }

  const t = now();
  const kind = to === 'resolved' ? 'resolve' : 'reopen';
  const txn = db.transaction(() => {
    const res = db.prepare(
      `UPDATE discussions SET status = ?, resolved_by = ?, resolved_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND project_id = ? AND version = ?`,
    ).run(to, to === 'resolved' ? actor : null, to === 'resolved' ? t : null, t, threadId, projectId, row.version);
    if (res.changes === 0) {
      throw new DiscError(409, '讨论状态已被他人更新，请刷新后重试', { code: 'version-conflict', current: getThread(threadId) });
    }
    const detail = to === 'resolved'
      ? { note: String(body.note || '') }
      : { reason: String(body.reason || '') };
    insertEvent(threadId, projectId, kind, actor, String(body.note || body.reason || ''), detail, token);
    store.writeAudit(projectId, store.getProject(projectId).head_id, [
      { field: `discussion:${threadId}`, action: to === 'resolved' ? 'disc-resolve' : 'disc-reopen', oldValue: row.status, newValue: to },
    ], actor);
  });
  try {
    txn();
  } catch (e) {
    if (e instanceof DiscError && e.extra?.code === 'duplicate-request') {
      return { thread: detail(projectId, threadId), deduplicated: true };
    }
    throw e;
  }
  return { thread: detail(projectId, threadId), deduplicated: false };
}

const resolveThread = (projectId, threadId, body, author) => changeStatus(projectId, threadId, 'resolved', body, author);
const reopenThread = (projectId, threadId, body, author) => changeStatus(projectId, threadId, 'open', body, author);

/* ============================ 人工重新定位 ============================ */

/**
 * 成员把待重新定位的讨论挂到新位置（单句或时间范围）。
 * 只有 orphan 状态可以重新定位；目标必须在 HEAD 中存在；
 * relocate 事件保留旧位置（last_anchor + orphan_detail）、新位置与操作者。
 */
function relocate(projectId, threadId, body, author) {
  const actor = String(author || '匿名');
  const expectedVersion = Number.isInteger(body.expectedVersion) ? body.expectedVersion : null;
  const token = body.clientToken ? String(body.clientToken) : null;

  const row = getThreadRow(threadId);
  if (!row || row.project_id !== projectId) throw new DiscError(404, '讨论不存在');

  if (token) {
    const dup = db.prepare('SELECT * FROM discussion_events WHERE project_id=? AND client_token=?').get(projectId, token);
    if (dup && dup.discussion_id === threadId) return { thread: detail(projectId, threadId), deduplicated: true };
  }
  if (expectedVersion != null && row.version !== expectedVersion) {
    throw new DiscError(409, '讨论已有新的更新，请刷新后重试', { code: 'version-conflict', current: getThread(threadId) });
  }
  if (row.anchor_status !== 'orphan') {
    throw new DiscError(409, '讨论当前不在待重新定位状态，无需重新定位', { code: 'not-orphan', current: getThread(threadId) });
  }

  const project = store.getProject(projectId);
  const head = store.getRevision(project.head_id);
  const snap = head.snapshot;

  const targetType = body.targetType === 'range' ? 'range' : 'cue';
  let target;
  if (targetType === 'cue') {
    const cueId = String(body.cueId || '');
    const cue = (snap.cues || []).find((c) => c.id === cueId);
    if (!cue) throw new DiscError(400, '目标句子不存在，请在当前版本中重新选择', { code: 'target-missing' });
    target = { type: 'cue', cueId: cue.id, track: cue.trackId, start: cue.start, end: cue.end, text: cue.text };
  } else {
    const start = roundMs(body.start);
    const end = roundMs(body.end);
    if (end <= start) throw new DiscError(400, '时间范围无效：结束必须晚于开始');
    const trackId = body.trackId == null ? '' : String(body.trackId);
    if (trackId && !(snap.tracks || []).some((t) => t.id === trackId)) {
      throw new DiscError(400, '目标轨道不存在', { code: 'target-missing' });
    }
    target = { type: 'range', cueId: null, track: trackId, start, end };
  }

  const oldLocation = {
    anchorType: row.anchor_type,
    cueId: row.last_anchor_id ?? row.anchor_id,
    track: row.last_anchor_track ?? row.anchor_track,
    start: row.last_anchor_start ?? row.anchor_start,
    end: row.last_anchor_end ?? row.anchor_end,
    orphanReason: row.orphan_reason,
    orphanDetail: row.orphan_detail ? JSON.parse(row.orphan_detail) : null,
  };

  const t = now();
  try {
    const txn = db.transaction(() => {
      const res = db.prepare(
        `UPDATE discussions
         SET anchor_type=?, anchor_id=?, anchor_track=?, anchor_start=?, anchor_end=?,
             anchor_status='anchored', orphan_reason=NULL, orphan_since_rev=NULL, orphan_detail=NULL,
             last_anchor_id=?, last_anchor_track=?, last_anchor_start=?, last_anchor_end=?,
             version=version+1, updated_at=?
         WHERE id=? AND project_id=? AND anchor_status='orphan' AND version=?`,
      ).run(
        target.type, target.cueId, target.track, target.start, target.end,
        oldLocation.cueId, oldLocation.track, oldLocation.start, oldLocation.end,
        t, threadId, projectId, row.version,
      );
      if (res.changes === 0) {
        throw new DiscError(409, '讨论状态已被他人更新，请刷新后重试', { code: 'version-conflict', current: getThread(threadId) });
      }
      insertEvent(threadId, projectId, 'relocate', actor, String(body.note || ''), {
        old: oldLocation,
        new: target,
        revisionId: head.id,
      }, token);
      store.writeAudit(projectId, head.id, [
        {
          field: `discussion:${threadId}`, action: 'disc-relocate',
          oldValue: JSON.stringify(oldLocation), newValue: JSON.stringify(target),
        },
      ], actor);
    });
    txn();
  } catch (e) {
    if (e instanceof DiscError && e.extra?.code === 'duplicate-request') {
      return { thread: detail(projectId, threadId), deduplicated: true };
    }
    throw e;
  }
  return { thread: detail(projectId, threadId), deduplicated: false };
}

/* ============================ 查询 ============================ */

function listThreads(projectId, filter = {}) {
  let rows = db.prepare('SELECT * FROM discussions WHERE project_id=? ORDER BY updated_at DESC, id DESC').all(projectId).map(parseThread);
  if (filter.status === 'open' || filter.status === 'resolved') rows = rows.filter((r) => r.status === filter.status);
  if (filter.anchorStatus === 'orphan' || filter.anchorStatus === 'anchored') {
    rows = rows.filter((r) => r.anchor_status === filter.anchorStatus);
  }
  if (filter.cueId) rows = rows.filter((r) => r.anchor_id === filter.cueId);
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    rows = rows.filter((r) => (r.title || '').toLowerCase().includes(q));
  }
  // 附带回复数与首条内容摘要
  const counts = db.prepare(
    `SELECT discussion_id, COUNT(*) n FROM discussion_events
     WHERE project_id=? AND kind='message' GROUP BY discussion_id`,
  ).all(projectId);
  const countMap = new Map(counts.map((c) => [c.discussion_id, c.n]));
  return rows.map((r) => ({ ...r, messageCount: countMap.get(r.id) || 0 }));
}

/** 未解决汇总：未解决 = 未关闭的讨论（含待重新定位），另单列待重新定位数 */
function getSummary(projectId) {
  const rows = db.prepare('SELECT status, anchor_status FROM discussions WHERE project_id=?').all(projectId);
  return {
    total: rows.length,
    unresolved: rows.filter((r) => r.status === 'open').length,
    resolved: rows.filter((r) => r.status === 'resolved').length,
    orphan: rows.filter((r) => r.anchor_status === 'orphan').length,
    unresolvedOrphan: rows.filter((r) => r.status === 'open' && r.anchor_status === 'orphan').length,
  };
}

function summaryOf(row) {
  if (!row) return null;
  return { id: row.id, status: row.status, anchorStatus: row.anchor_status, version: row.version };
}

function listEvents(threadId) {
  return db.prepare('SELECT * FROM discussion_events WHERE discussion_id=? ORDER BY seq ASC').all(threadId)
    .map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null, client_token: undefined }));
}

function detail(projectId, threadId) {
  const row = getThreadRow(threadId);
  if (!row || row.project_id !== projectId) throw new DiscError(404, '讨论不存在');
  const thread = parseThread(row);
  const head = store.getRevision(store.getProject(projectId).head_id);
  // 供页面渲染锚点上下文：当前锚点句子在 HEAD 中是否仍存在、文本/时间是否已变化
  let anchorContext = null;
  if (thread.anchor_status === 'anchored' && thread.anchor_type === 'cue') {
    const cue = (head.snapshot.cues || []).find((c) => c.id === thread.anchor_id);
    anchorContext = cue
      ? { exists: true, cue: { id: cue.id, trackId: cue.trackId, start: cue.start, end: cue.end, text: cue.text } }
      : { exists: false };
  } else if (thread.anchor_status === 'anchored') {
    const track = thread.anchor_track ? (head.snapshot.tracks || []).some((t) => t.id === thread.anchor_track) : true;
    anchorContext = { exists: track };
  }
  return { thread, events: listEvents(threadId), anchorContext, headRevId: head.id };
}

/* ============================ 提交钩子：跨版本跟随 ============================ */

/**
 * 新版本产生后，把每条已定位讨论从上一版（主父）映射到新版本：
 * cue 锚点走 match.js 的唯一匹配；range 锚点检查轨道是否仍存在。
 * 跟随 / 孤儿 / 自动跟随都写入事件流与审计；孤儿保留旧位置。
 */
store.onCommit(({ projectId, revision }) => {
  const threads = db.prepare(`SELECT * FROM discussions WHERE project_id=? AND anchor_status='anchored'`).all(projectId);
  if (!threads.length) return;

  const parent = revision.parent1_id ? store.getRevision(revision.parent1_id) : null;
  const oldSnap = parent?.snapshot;
  const newSnap = revision.snapshot;
  if (!oldSnap) return; // 无父版本（create）无从映射

  const newTrackIds = new Set((newSnap.tracks || []).map((t) => t.id));
  const auditEntries = [];

  const followStmt = db.prepare(
    `UPDATE discussions
     SET anchor_id=?, anchor_track=?, anchor_start=?, anchor_end=?, version=version+1, updated_at=?
     WHERE id=?`,
  );
  const orphanStmt = db.prepare(
    `UPDATE discussions
     SET anchor_status='orphan', orphan_reason=?, orphan_since_rev=?, orphan_detail=?,
         last_anchor_id=anchor_id, last_anchor_track=anchor_track,
         last_anchor_start=anchor_start, last_anchor_end=anchor_end,
         anchor_id=NULL, version=version+1, updated_at=?
     WHERE id=?`,
  );
  const rangeOrphanStmt = db.prepare(
    `UPDATE discussions
     SET anchor_status='orphan', orphan_reason='track-deleted', orphan_since_rev=?, orphan_detail=?,
         last_anchor_id=anchor_id, last_anchor_track=anchor_track,
         last_anchor_start=anchor_start, last_anchor_end=anchor_end,
         anchor_id=NULL, version=version+1, updated_at=?
     WHERE id=?`,
  );

  const txn = db.transaction(() => {
    for (const row of threads) {
      if (row.anchor_type === 'range') {
        if (row.anchor_track && !newTrackIds.has(row.anchor_track)) {
          const detail = { old: { type: 'range', track: row.anchor_track, start: row.anchor_start, end: row.anchor_end } };
          rangeOrphanStmt.run(revision.id, JSON.stringify(detail), now(), row.id);
          insertEvent(row.id, projectId, 'orphan', '系统', '', { reason: 'track-deleted', ...detail, revisionId: revision.id }, null);
          auditEntries.push({ field: `discussion:${row.id}`, action: 'disc-orphan', oldValue: 'anchored', newValue: 'orphan:track-deleted' });
        }
        continue; // 时间范围坐标不随句子变化
      }

      // cue 锚点：先在上一版找到旧句子（它在提交瞬间必定存在），再向新版映射
      const oldCue = (oldSnap.cues || []).find((c) => c.id === row.anchor_id);
      if (!oldCue) continue; // 上一版已无此句（理论上不应发生），保持原样交人工处理
      const result = resolveCueAnchor(oldCue, newSnap);

      if (result.outcome === 'follow') {
        const newCue = newSnap.cues.find((c) => c.id === result.cueId);
        const unchanged =
          newCue.id === row.anchor_id && newCue.trackId === row.anchor_track &&
          newCue.start === row.anchor_start && newCue.end === row.anchor_end;
        if (unchanged && result.via === 'id') continue; // 编号与位置都没变：无需跟随
        followStmt.run(newCue.id, newCue.trackId, newCue.start, newCue.end, now(), row.id);
        if (result.via === 'content') {
          // 稳定编号消失但唯一强匹配：记录自动跟随定位历史，绝不静默
          insertEvent(row.id, projectId, 'auto-follow', '系统', '', {
            old: { cueId: oldCue.id, track: oldCue.trackId, start: oldCue.start, end: oldCue.end, text: oldCue.text },
            new: { cueId: newCue.id, track: newCue.trackId, start: newCue.start, end: newCue.end, text: newCue.text },
            via: 'content',
            candidates: (result.candidates || []).map((c) => ({ cueId: c.cueId, score: Math.round(c.score * 1000) / 1000 })),
            revisionId: revision.id,
          }, null);
          auditEntries.push({ field: `discussion:${row.id}`, action: 'disc-auto-follow', oldValue: oldCue.id, newValue: newCue.id });
        }
      } else {
        const detail = {
          reason: result.reason,
          old: { cueId: oldCue.id, track: oldCue.trackId, start: oldCue.start, end: oldCue.end, text: oldCue.text },
          candidates: (result.candidates || []).map((c) => ({
            cueId: c.cueId, trackId: c.trackId, start: c.start, end: c.end, text: c.text,
            score: Math.round(c.score * 1000) / 1000,
          })),
        };
        orphanStmt.run(result.reason, revision.id, JSON.stringify(detail), now(), row.id);
        insertEvent(row.id, projectId, 'orphan', '系统', '', { ...detail, revisionId: revision.id }, null);
        auditEntries.push({ field: `discussion:${row.id}`, action: 'disc-orphan', oldValue: oldCue.id, newValue: `orphan:${result.reason}` });
      }
    }
  });
  txn();
  if (auditEntries.length) store.writeAudit(projectId, revision.id, auditEntries, revision.author || '系统');
});

module.exports = {
  DiscError,
  createThread,
  reply,
  resolveThread,
  reopenThread,
  relocate,
  listThreads,
  getSummary,
  detail,
};
