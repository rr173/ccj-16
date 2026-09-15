'use strict';
/**
 * 多版本字幕盲审对照：数据层。
 *
 * - 创建轮次时冻结 2~3 个历史版本的内容，按「稳定编号 + 时间接近度 + 文本相似度」
 *   组成对照项；无法可靠对应的新增/删除/一对多内容单列，不硬配成一组。
 * - 盲审：每位审阅人看到由服务端确定性生成的、彼此独立的匿名候选顺序（A/B/C），
 *   审阅/进度/导出接口在达到最少有效提交人数前均不含版本来源；
 *   选择以槽位落库（服务端解码匿名标签），审计与事件只记数量不记票向，避免经审计泄露来源。
 * - 保存：乐观锁（baseVersion 条件更新），并发修改同一审阅人的进度返回 409 + 当前结果；
 *   clientToken 唯一索引保证同一保存/提交请求重复发送不产生重复记录。
 * - 门槛：有效提交（submitted 且未被拒绝）达到 min_submitters 前，揭示来源与关闭均 403；
 *   达到后可揭示来源（幂等）、可关闭并生成冻结结果（平票保留为平票，重复关闭返回同一结果）。
 */
const crypto = require('crypto');
const { db } = require('../db');
const store = require('../store');
const match = require('./match');

const now = () => Date.now();
const brid = () => 'br_' + crypto.randomBytes(9).toString('hex');
const sid = () => 'bs_' + crypto.randomBytes(9).toString('hex');

class BlindError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const CHOICES = ['better', 'equal', 'unknown'];

/* ================================ 行解析 ================================ */

function getRoundRow(roundId) {
  return db.prepare('SELECT * FROM blind_rounds WHERE id = ?').get(roundId);
}

function mustRound(roundId) {
  const row = getRoundRow(roundId);
  if (!row) throw new BlindError(404, '盲审轮次不存在');
  return row;
}

function getSubmissionRow(roundId, reviewer) {
  return db.prepare('SELECT * FROM blind_submissions WHERE round_id = ? AND reviewer = ?').get(roundId, reviewer);
}

function listSubmissionRows(roundId) {
  return db.prepare('SELECT * FROM blind_submissions WHERE round_id = ? ORDER BY created_at ASC, reviewer ASC').all(roundId);
}

/** 有效提交人数：已提交且未被拒绝 */
function validCount(roundId) {
  return db.prepare(`SELECT COUNT(*) n FROM blind_submissions WHERE round_id = ? AND status = 'submitted'`).get(roundId).n;
}

/* ================================ 事件与审计 ================================ */

function insertEvent(roundId, projectId, action, actor, detail, clientToken) {
  db.prepare(
    `INSERT INTO blind_events (project_id, round_id, action, actor, detail, client_token, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(projectId, roundId, action, actor, detail ? JSON.stringify(detail) : null, clientToken || null, now());
}

function findEventByToken(roundId, token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM blind_events WHERE round_id = ? AND client_token = ?').get(roundId, token);
}

function audit(round, action, newValue, actor) {
  store.writeAudit(round.project_id, store.getProject(round.project_id).head_id, [
    { field: `blind:${round.id}`, action, oldValue: null, newValue: typeof newValue === 'string' ? newValue : JSON.stringify(newValue) },
  ], actor);
}

/* ================================ 创建 ================================ */

/**
 * 创建盲审轮次。revisionIds 为同一项目的 2~3 个历史版本；创建时冻结内容与对照分组。
 */
function createRound(projectId, { revisionIds, minSubmitters, title }, author) {
  const project = store.getProject(projectId);
  if (!project) throw new BlindError(404, '项目不存在');
  if (!Array.isArray(revisionIds)) throw new BlindError(400, 'revisionIds 应为版本 id 数组');
  const ids = [...new Set(revisionIds.map((x) => String(x || '')))];
  if (ids.length < 2 || ids.length > 3) throw new BlindError(400, '盲审需要选择 2~3 个不同的历史版本');
  const min = Number(minSubmitters);
  if (!Number.isInteger(min) || min < 1) throw new BlindError(400, '最少有效提交人数应为 ≥1 的整数');

  const versions = ids.map((revId, slot) => {
    const rev = store.getRevision(revId);
    if (!rev) throw new BlindError(404, `版本不存在：${revId}`);
    if (rev.project_id !== projectId) throw new BlindError(400, '所选版本必须属于同一项目');
    return {
      slot,
      revisionId: rev.id,
      label: `版本 ${rev.id.slice(0, 10)}（${(rev.message || rev.kind).slice(0, 30)}）`,
      author: rev.author,
      message: rev.message || '',
      createdAt: rev.created_at,
      snapshot: { tracks: rev.snapshot.tracks || [], cues: rev.snapshot.cues || [] },
    };
  });

  // 冻结分组：对照项 + 单列内容（创建后项目继续编辑不影响本轮）
  const { items, unmatched } = match.buildComparison(
    versions.map((v) => ({ slot: v.slot, tracks: v.snapshot.tracks, cues: v.snapshot.cues })),
  );

  const id = brid();
  const t = now();
  const actor = String(author || '匿名');
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO blind_rounds
         (id, project_id, title, min_submitters, status, versions, items, unmatched,
          version_count, item_count, unmatched_count, created_by, created_at)
       VALUES (?,?,?,?, 'open', ?,?,?, ?,?,?, ?,?)`,
    ).run(
      id, projectId, String(title || '').trim().slice(0, 200), min,
      JSON.stringify(versions), JSON.stringify(items), JSON.stringify(unmatched),
      versions.length, items.length, unmatched.length, actor, t,
    );
    insertEvent(id, projectId, 'create', actor, {
      title: String(title || '').trim().slice(0, 200),
      // revisionIds 落库但在 listEvents 按盲态动态抹除（达到门槛、组织者揭示前不返回来源）
      revisionIds: ids,
      versionCount: ids.length,
      minSubmitters: min,
      itemCount: items.length,
      unmatchedCount: unmatched.length,
    }, null);
  });
  txn();
  const row = getRoundRow(id);
  // 审计同样只记数量（揭示后可经操作记录查看来源；审计表不承载版本来源）
  audit(row, 'blind-create', {
    title: row.title, versionCount: ids.length, minSubmitters: min,
    itemCount: items.length, unmatchedCount: unmatched.length,
  }, actor);
  return { round: roundDetail(row, { withSources: true }) };
}

/* ================================ 展示组装 ================================ */

function roundMeta(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    status: row.status,
    min_submitters: row.min_submitters,
    version_count: row.version_count,
    item_count: row.item_count,
    unmatched_count: row.unmatched_count,
    created_by: row.created_by,
    created_at: row.created_at,
    revealed_by: row.revealed_by,
    revealed_at: row.revealed_at,
    closed_by: row.closed_by,
    closed_at: row.closed_at,
  };
}

/** 来源信息：仅在已揭示/已关闭后随接口返回 */
function sourcesOf(row) {
  const versions = JSON.parse(row.versions);
  return {
    versions: versions.map((v) => ({
      slot: v.slot, revisionId: v.revisionId, label: v.label, author: v.author, message: v.message,
    })),
    items: JSON.parse(row.items),
    unmatched: JSON.parse(row.unmatched),
  };
}

function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 1000) / 10; // 保留一位小数的百分数
}

function progressOf(row) {
  const submissions = listSubmissionRows(row.id);
  const items = JSON.parse(row.items);
  const valid = submissions.filter((s) => s.status === 'submitted');
  // 逐项分歧程度（只统计有效提交；只给匿名聚合，不给候选/版本归属）
  const perItem = items.map((it) => {
    let better = 0, equal = 0, unknown = 0;
    const bySlot = {};
    for (const s of valid) {
      const a = JSON.parse(s.answers)[it.key];
      if (!a) continue;
      if (a.choice === 'better') { better++; bySlot[a.slot] = (bySlot[a.slot] || 0) + 1; }
      else if (a.choice === 'equal') equal++;
      else if (a.choice === 'unknown') unknown++;
    }
    const counts = Object.values(bySlot).sort((x, y) => y - x);
    const level = better === 0 ? 'none' : counts.length <= 1 ? 'unanimous' : 'split';
    return { key: it.key, better, equal, unknown, distribution: counts, level };
  });
  return {
    totalReviewers: submissions.length,
    validSubmitters: valid.length,
    minSubmitters: row.min_submitters,
    thresholdMet: valid.length >= row.min_submitters,
    // 完成比例：有效提交相对门槛（门槛达成率），封顶 100%
    thresholdCompletionPct: pct(Math.min(valid.length, row.min_submitters), row.min_submitters),
    reviewers: submissions.map((s) => {
      const answered = Object.keys(JSON.parse(s.answers)).length;
      return {
        reviewer: s.reviewer,
        status: s.status,
        answered,
        total: row.item_count,
        // 个人作答完成比例（草稿/被拒绝也展示进度）
        completionPct: pct(answered, row.item_count),
        submitted_at: s.submitted_at,
        rejected_by: s.rejected_by,
        rejected_at: s.rejected_at,
        reject_reason: s.reject_reason,
      };
    }),
    perItem,
  };
}

function roundDetail(row, { withSources = false } = {}) {
  const revealed = Boolean(row.revealed_at) || row.status === 'closed';
  const out = { ...roundMeta(row), progress: progressOf(row), revealed };
  if (revealed || withSources) Object.assign(out, sourcesOf(row));
  if (row.status === 'closed' && row.result) out.result = JSON.parse(row.result);
  return out;
}

function listRounds(projectId) {
  const rows = db.prepare('SELECT * FROM blind_rounds WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(projectId);
  return rows.map((row) => {
    const p = progressOf(row);
    const meta = { ...roundMeta(row), progress: p, revealed: Boolean(row.revealed_at) || row.status === 'closed' };
    if (meta.revealed) meta.versions = sourcesOf(row).versions;
    return meta;
  });
}

function getRoundDetail(projectId, roundId) {
  const row = mustRound(roundId);
  if (row.project_id !== projectId) throw new BlindError(404, '盲审轮次不存在');
  return roundDetail(row);
}

/* ================================ 审阅人视图（匿名） ================================ */

function reviewerNameOf(v) {
  const name = String(v || '').trim();
  if (!name) throw new BlindError(400, '缺少审阅人署名（reviewer）');
  return name.slice(0, 80);
}

/** 审阅人载荷：匿名候选（A/B/C），不含任何版本来源信息 */
function reviewPayload(roundId, reviewer) {
  const row = mustRound(roundId);
  const name = reviewerNameOf(reviewer);
  const items = JSON.parse(row.items);
  const unmatched = JSON.parse(row.unmatched);
  const sub = getSubmissionRow(roundId, name);
  const answers = sub ? JSON.parse(sub.answers) : {};

  const viewItems = items.map((it) => {
    const labeled = match.labelOrder(row.id, name, it);
    const my = answers[it.key];
    return {
      key: it.key,
      matchedBy: it.matchedBy,
      candidates: labeled.map(({ label, candidate }) => ({
        label,
        trackName: candidate.trackName,
        start: candidate.start,
        end: candidate.end,
        text: candidate.text,
        locked: candidate.locked,
      })),
      myAnswer: my
        ? {
            choice: my.choice,
            candidate: my.choice === 'better' ? match.encodeSlot(row.id, name, it.key, it.candidates.map((c) => c.slot), my.slot) : null,
            comment: my.comment || '',
          }
        : null,
    };
  });

  return {
    round: {
      id: row.id,
      project_id: row.project_id,
      title: row.title,
      status: row.status,
      itemCount: row.item_count,
      versionCount: row.version_count,
      minSubmitters: row.min_submitters,
    },
    reviewer: name,
    items: viewItems,
    // 无法可靠配对的内容：单列展示（不参与对照），同样不含版本来源
    unmatched: unmatched.map((u) => ({
      trackName: u.trackName, start: u.start, end: u.end, text: u.text, reason: u.reason,
    })),
    submission: sub
      ? {
          status: sub.status,
          version: sub.version,
          answered: Object.keys(answers).length,
          total: row.item_count,
          submitted_at: sub.submitted_at,
          reject_reason: sub.reject_reason,
        }
      : { status: 'none', version: 0, answered: 0, total: row.item_count },
  };
}

/* ================================ 保存（乐观锁 + 令牌幂等） ================================ */

function validateAnswers(row, reviewer, rawAnswers) {
  if (rawAnswers == null || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
    throw new BlindError(400, 'answers 应为以对照项 key 为键的对象');
  }
  const items = JSON.parse(row.items);
  const byKey = new Map(items.map((it) => [it.key, it]));
  const clean = {};
  for (const [key, a] of Object.entries(rawAnswers)) {
    const item = byKey.get(key);
    if (!item) throw new BlindError(400, `对照项不存在：${key}`);
    if (!a || typeof a !== 'object') throw new BlindError(400, `对照项 ${key} 的选择无效`);
    if (!CHOICES.includes(a.choice)) throw new BlindError(400, `对照项 ${key} 的判定无效（better/equal/unknown）`);
    const comment = String(a.comment ?? '').slice(0, 2000);
    if (a.choice === 'better') {
      const slots = item.candidates.map((c) => c.slot);
      const slot = match.decodeLabel(row.id, reviewer, key, slots, String(a.candidate || ''));
      if (slot == null) throw new BlindError(400, `对照项 ${key} 的候选标签无效：${a.candidate ?? ''}`);
      clean[key] = { choice: 'better', slot, comment };
    } else {
      clean[key] = { choice: a.choice, slot: null, comment };
    }
  }
  return clean;
}

function submissionView(row, sub) {
  return {
    reviewer: sub.reviewer,
    status: sub.status,
    version: sub.version,
    answered: Object.keys(JSON.parse(sub.answers)).length,
    total: row.item_count,
    submitted_at: sub.submitted_at,
    reject_reason: sub.reject_reason,
  };
}

/**
 * 保存审阅进度。baseVersion 为审阅人当前看到的服务端版本（乐观锁）：
 * 失配返回 409 + 服务端当前结果，绝不静默覆盖；clientToken 重复请求幂等返回。
 */
function saveResponses(roundId, { reviewer, baseVersion, answers, clientToken }) {
  const row = mustRound(roundId);
  const name = reviewerNameOf(reviewer);
  if (row.status !== 'open') throw new BlindError(409, '轮次已关闭，不再接受新选择', { code: 'round-closed' });
  const token = clientToken ? String(clientToken) : null;

  // 同一保存请求重复发送：直接返回当前结果，不产生重复记录
  if (token && findEventByToken(row.id, token)) {
    const cur = getSubmissionRow(row.id, name);
    return { submission: cur ? submissionView(row, cur) : null, deduplicated: true };
  }

  const clean = validateAnswers(row, name, answers);
  const existing = getSubmissionRow(row.id, name);
  if (existing && existing.status === 'submitted') {
    throw new BlindError(409, '已提交，不能再修改；如需改判请联系组织者拒绝本次提交', {
      code: 'already-submitted', current: submissionView(row, existing),
    });
  }
  const base = Number.isInteger(baseVersion) ? baseVersion : null;
  if (existing && base !== existing.version) {
    throw new BlindError(409, '该轮次已有新的保存（可能来自另一标签页），请基于当前结果继续', {
      code: 'version-conflict', current: submissionView(row, existing),
    });
  }
  if (!existing && base !== null && base !== 0) {
    throw new BlindError(409, '该轮次已有新的保存（可能来自另一标签页），请基于当前结果继续', {
      code: 'version-conflict', current: null,
    });
  }

  const t = now();
  try {
    const txn = db.transaction(() => {
      if (!existing) {
        db.prepare(
          `INSERT INTO blind_submissions (id, round_id, project_id, reviewer, status, answers, version, created_at, updated_at)
           VALUES (?,?,?,?, 'draft', ?, 1, ?, ?)`,
        ).run(sid(), row.id, row.project_id, name, JSON.stringify(clean), t, t);
      } else {
        const res = db.prepare(
          `UPDATE blind_submissions
           SET answers = ?, version = version + 1, status = 'draft', updated_at = ?
           WHERE id = ? AND version = ? AND status IN ('draft','rejected')`,
        ).run(JSON.stringify(clean), t, existing.id, existing.version);
        if (res.changes === 0) {
          throw new BlindError(409, '该轮次已有新的保存（可能来自另一标签页），请基于当前结果继续', {
            code: 'version-conflict', current: submissionView(row, getSubmissionRow(row.id, name)),
          });
        }
      }
      insertEvent(row.id, row.project_id, 'save', name, { answered: Object.keys(clean).length, total: row.item_count }, token);
    });
    txn();
  } catch (e) {
    if (String(e.message || '').includes('uq_blindevent_token')) {
      const cur = getSubmissionRow(row.id, name);
      return { submission: cur ? submissionView(row, cur) : null, deduplicated: true };
    }
    if (String(e.message || '').includes('uq_blindsub_reviewer')) {
      throw new BlindError(409, '该轮次已有新的保存（可能来自另一标签页），请基于当前结果继续', {
        code: 'version-conflict', current: submissionView(row, getSubmissionRow(row.id, name)),
      });
    }
    throw e;
  }
  const sub = getSubmissionRow(row.id, name);
  audit(row, 'blind-save', { reviewer: name, answered: Object.keys(clean).length, total: row.item_count }, name);
  return { submission: submissionView(row, sub), deduplicated: false };
}

/* ================================ 提交 ================================ */

/**
 * 提交（定稿）：要求全部对照项均已作答。
 * 重复提交（含同令牌重发）幂等返回；expectedVersion 防止基于过期进度提交。
 */
function submit(roundId, { reviewer, expectedVersion, clientToken }) {
  const row = mustRound(roundId);
  const name = reviewerNameOf(reviewer);
  if (row.status !== 'open') throw new BlindError(409, '轮次已关闭，不再接受提交', { code: 'round-closed' });
  const token = clientToken ? String(clientToken) : null;
  if (token && findEventByToken(row.id, token)) {
    return { submission: submissionView(row, getSubmissionRow(row.id, name)), deduplicated: true };
  }

  const sub = getSubmissionRow(row.id, name);
  if (!sub) throw new BlindError(400, '还没有保存任何选择，无法提交');
  if (sub.status === 'submitted') {
    // 重复提交：不产生重复记录，返回当前结果
    return { submission: submissionView(row, sub), deduplicated: true };
  }
  if (Number.isInteger(expectedVersion) && expectedVersion !== sub.version) {
    throw new BlindError(409, '提交前进度已有更新，请刷新确认后再提交', {
      code: 'version-conflict', current: submissionView(row, sub),
    });
  }
  const answers = JSON.parse(sub.answers);
  const items = JSON.parse(row.items);
  const missing = items.filter((it) => !answers[it.key]);
  if (missing.length) {
    throw new BlindError(400, `还有 ${missing.length} 个对照项未作答，全部作答后才能提交`, {
      code: 'incomplete', missing: missing.length,
    });
  }

  const t = now();
  try {
    const txn = db.transaction(() => {
      const res = db.prepare(
        `UPDATE blind_submissions
         SET status = 'submitted', submitted_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status IN ('draft','rejected')`,
      ).run(t, t, sub.id, sub.version);
      if (res.changes === 0) {
        throw new BlindError(409, '提交状态已被更新，请刷新后重试', {
          code: 'version-conflict', current: submissionView(row, getSubmissionRow(row.id, name)),
        });
      }
      insertEvent(row.id, row.project_id, 'submit', name, { total: row.item_count }, token);
    });
    txn();
  } catch (e) {
    if (String(e.message || '').includes('uq_blindevent_token')) {
      return { submission: submissionView(row, getSubmissionRow(row.id, name)), deduplicated: true };
    }
    throw e;
  }
  audit(row, 'blind-submit', { reviewer: name, total: row.item_count }, name);
  return { submission: submissionView(row, getSubmissionRow(row.id, name)), deduplicated: false };
}

/* ================================ 组织者拒绝提交 ================================ */

/** 拒绝某位审阅人的提交（必填理由）：不计入有效人数；其可修改后重新提交。 */
function rejectSubmission(roundId, reviewer, { reason }, author) {
  const row = mustRound(roundId);
  if (row.status !== 'open') throw new BlindError(409, '轮次已关闭，不能再拒绝提交', { code: 'round-closed' });
  const name = reviewerNameOf(reviewer);
  const why = String(reason || '').trim();
  if (!why) throw new BlindError(400, '拒绝必须填写理由');
  const actor = String(author || '匿名');

  const sub = getSubmissionRow(row.id, name);
  if (!sub || sub.status !== 'submitted') {
    throw new BlindError(409, '该审阅人当前没有已提交的记录可拒绝', {
      code: 'not-submitted', current: sub ? submissionView(row, sub) : null,
    });
  }
  const t = now();
  const txn = db.transaction(() => {
    const res = db.prepare(
      `UPDATE blind_submissions
       SET status = 'rejected', rejected_by = ?, rejected_at = ?, reject_reason = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'submitted'`,
    ).run(actor, t, why, t, sub.id);
    if (res.changes === 0) {
      throw new BlindError(409, '该提交状态已被更新，请刷新后重试', {
        code: 'version-conflict', current: submissionView(row, getSubmissionRow(row.id, name)),
      });
    }
    insertEvent(row.id, row.project_id, 'reject', actor, { reviewer: name, reason: why }, null);
  });
  txn();
  audit(row, 'blind-reject', { reviewer: name, reason: why }, actor);
  return { submission: submissionView(row, getSubmissionRow(row.id, name)) };
}

/* ================================ 揭示来源 / 关闭 ================================ */

function ensureThreshold(row) {
  const valid = validCount(row.id);
  if (valid < row.min_submitters && row.status !== 'closed') {
    throw new BlindError(403, `未达到最少有效提交人数（${valid}/${row.min_submitters}），不能揭示来源或关闭轮次`, {
      code: 'threshold-not-met', validSubmitters: valid, minSubmitters: row.min_submitters,
    });
  }
}

/** 揭示来源：达到最少有效提交人数后才允许；重复揭示返回同一映射（幂等）。 */
function reveal(roundId, author) {
  const row = mustRound(roundId);
  const actor = String(author || '匿名');
  if (row.revealed_at) {
    return { revealed: true, deduplicated: true, ...sourcesOf(row) };
  }
  ensureThreshold(row);
  const t = now();
  let transitioned = false;
  const txn = db.transaction(() => {
    const res = db.prepare('UPDATE blind_rounds SET revealed_by = ?, revealed_at = ? WHERE id = ? AND revealed_at IS NULL')
      .run(actor, t, row.id);
    if (res.changes === 0) return; // 并发揭示：已有人完成，幂等
    transitioned = true;
    insertEvent(row.id, row.project_id, 'reveal', actor, { validSubmitters: validCount(row.id) }, null);
  });
  txn();
  const after = getRoundRow(row.id);
  if (transitioned) audit(after, 'blind-reveal', { validSubmitters: validCount(row.id) }, actor);
  return { revealed: true, deduplicated: !transitioned, ...sourcesOf(after) };
}

/**
 * 关闭轮次并生成冻结结果：每项票数（按版本）、意见、胜出版本与单列内容；
 * 平票明确保留为平票。重复关闭返回同一份结果，不产生重复记录。
 */
function close(roundId, author) {
  const row = mustRound(roundId);
  const actor = String(author || '匿名');
  if (row.status === 'closed') {
    return { round: roundDetail(row), deduplicated: true };
  }
  ensureThreshold(row);

  const versions = JSON.parse(row.versions);
  const items = JSON.parse(row.items);
  const unmatched = JSON.parse(row.unmatched);
  const valid = listSubmissionRows(row.id).filter((s) => s.status === 'submitted');

  // 汇总：票数以候选槽位统计（提交时已由匿名标签解码），结果中槽位映射回真实版本
  const resultItems = items.map((it) => {
    const votesBySlot = Object.fromEntries(versions.map((v) => [v.slot, 0]));
    let equal = 0, unknown = 0;
    const opinions = [];
    for (const s of valid) {
      const a = JSON.parse(s.answers)[it.key];
      if (!a) continue;
      if (a.choice === 'better') votesBySlot[a.slot] = (votesBySlot[a.slot] || 0) + 1;
      else if (a.choice === 'equal') equal++;
      else if (a.choice === 'unknown') unknown++;
      opinions.push({
        reviewer: s.reviewer,
        choice: a.choice,
        candidateSlot: a.choice === 'better' ? a.slot : null,
        comment: a.comment || '',
      });
    }
    const max = Math.max(...Object.values(votesBySlot));
    const topSlots = Object.keys(votesBySlot).filter((k) => votesBySlot[k] === max).map(Number);
    // 平票明确保留为平票（包括无人投「更好」的情形）
    const outcome = max > 0 && topSlots.length === 1 ? 'winner' : 'tie';
    return {
      key: it.key,
      matchedBy: it.matchedBy,
      similarity: it.similarity,
      candidates: it.candidates,
      votes: { bySlot: votesBySlot, equal, unknown },
      outcome,
      winnerSlot: outcome === 'winner' ? topSlots[0] : null,
      opinions,
    };
  });

  const winsBySlot = Object.fromEntries(versions.map((v) => [v.slot, 0]));
  let tieCount = 0;
  for (const it of resultItems) {
    if (it.outcome === 'winner') winsBySlot[it.winnerSlot]++;
    else tieCount++;
  }

  const result = {
    generatedAt: now(),
    generatedBy: actor,
    minSubmitters: row.min_submitters,
    validSubmitters: valid.length,
    versions: versions.map((v) => ({
      slot: v.slot, revisionId: v.revisionId, label: v.label, author: v.author, message: v.message,
    })),
    // 候选/单列内容都带上来源版本，结果自包含
    items: resultItems.map((it) => ({
      ...it,
      candidates: it.candidates.map((c) => ({
        ...c, revisionId: versions[c.slot].revisionId, versionLabel: versions[c.slot].label,
      })),
    })),
    unmatched: unmatched.map((u) => ({
      ...u, revisionId: versions[u.slot].revisionId, versionLabel: versions[u.slot].label,
    })),
    summary: {
      itemCount: items.length,
      tieCount,
      winnerCount: items.length - tieCount,
      winsBySlot,
      unmatchedCount: unmatched.length,
    },
  };

  const t = now();
  let transitioned = false;
  const txn = db.transaction(() => {
    const res = db.prepare(
      `UPDATE blind_rounds SET status = 'closed', result = ?, closed_by = ?, closed_at = ?,
              revealed_by = COALESCE(revealed_by, ?), revealed_at = COALESCE(revealed_at, ?)
       WHERE id = ? AND status = 'open'`,
    ).run(JSON.stringify(result), actor, t, actor, t, row.id);
    if (res.changes === 0) return; // 并发关闭：已有人完成，返回既有结果
    transitioned = true;
    insertEvent(row.id, row.project_id, 'close', actor, {
      validSubmitters: valid.length, itemCount: items.length, tieCount,
    }, null);
  });
  txn();
  const after = getRoundRow(row.id);
  if (transitioned) {
    audit(after, 'blind-close', { validSubmitters: valid.length, itemCount: items.length, tieCount }, actor);
  }
  return { round: roundDetail(after), deduplicated: !transitioned };
}

/** 冻结结果：仅关闭后可读 */
function getResult(roundId) {
  const row = mustRound(roundId);
  if (row.status !== 'closed' || !row.result) {
    throw new BlindError(409, '轮次尚未关闭，结果未生成', { code: 'not-closed' });
  }
  return { result: JSON.parse(row.result), round: roundMeta(row) };
}

// 盲态（未揭示且未关闭）下必须从操作记录抹掉的来源字段：
// revisionIds 等版本标识在达到门槛、组织者揭示来源前不得透露
const SOURCE_KEYS = ['revisionIds', 'revisionId', 'slot'];

function listEvents(roundId) {
  const row = mustRound(roundId);
  const revealed = Boolean(row.revealed_at) || row.status === 'closed';
  return db.prepare('SELECT * FROM blind_events WHERE round_id = ? ORDER BY id ASC').all(row.id)
    .map((e) => {
      let detail = e.detail ? JSON.parse(e.detail) : null;
      if (!revealed && detail && typeof detail === 'object') {
        detail = { ...detail };
        for (const k of SOURCE_KEYS) if (k in detail) delete detail[k];
      }
      return { ...e, detail, client_token: undefined };
    });
}

module.exports = {
  BlindError,
  createRound,
  listRounds,
  getRoundDetail,
  reviewPayload,
  saveResponses,
  submit,
  rejectSubmission,
  reveal,
  close,
  getResult,
  listEvents,
};
