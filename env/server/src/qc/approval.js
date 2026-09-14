'use strict';
/**
 * 多阶段会签与审批策略。
 *
 * 策略（approval_policies，每项目一份）：
 *   项目负责人配置有顺序的审批阶段，每阶段指定审核角色、最少同意人数、
 *   是否允许驳回后重新提交与审批有效期（毫秒，0=不限）。提交发布申请时
 *   策略随申请冻结（policy_snapshot + policy_hash）；审批过程中策略一旦
 *   修改/清除，进行中的申请立即失效（policy-changed），需重新提交。
 *
 * 阶段实例（relreq_stages）：
 *   提交申请时按冻结策略生成，逐阶段推进：waiting → active → approved /
 *   rejected / expired。未完成当前阶段不能进入下一阶段（只有 current_stage
 *   且 status='active' 的阶段接受会签）。阶段超过有效期标记 expired 并记录
 *   原因；负责人在版本/预检/门禁/策略指纹仍与冻结一致时可重新开启当前阶段。
 *
 * 会签意见（relreq_decisions）：
 *   每位审核人在每个阶段只有一条决定（stage_id+reviewer 唯一索引）——同一
 *   审核人重复同一操作幂等返回，重复不同操作 409；意见、署名、时间全部保留。
 *   并发会签时，阶段状态迁移用条件更新（WHERE status='active'）保证只有
 *   一个合法状态转换，请求级迁移同事务完成。
 *
 * 事件流（relreq_events）：
 *   提交/阶段激活/会签意见/阶段结论/过期/重新开启/失效/重新提交/发布，
 *   构成发布页展示的完整审计记录；同步写入项目审计表。
 *
 * 门禁事件冻结：提交申请时对每个订阅取该版本最新完成事件的结果指纹与豁免
 *   状态，生成 gate_fingerprint 随申请冻结；审批过程中门禁评估结果、豁免或
 *   订阅配置发生变化，申请立即失效（gate-changed）。
 */
const crypto = require('crypto');
const { db } = require('../db');
const store = require('../store');

const now = () => Date.now();
const sid = () => 'rs_' + crypto.randomBytes(9).toString('hex');
const did = () => 'rd_' + crypto.randomBytes(9).toString('hex');
const httpError = store.httpError;
// 延迟访问以规避循环依赖（qc/store 在提交申请/复检时调用本模块）
const qc = () => require('./store');

const MAX_STAGES = 10;
const MAX_TTL_MS = 90 * 24 * 3600 * 1000; // 90 天

/* ================================ 策略配置 ================================ */

function normalizeStages(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw httpError(400, 'stages 应为数组');
  if (raw.length > MAX_STAGES) throw httpError(400, `审批阶段最多 ${MAX_STAGES} 个`);
  return raw.map((s, i) => {
    const role = String(s?.role ?? '').trim().slice(0, 40);
    if (!role) throw httpError(400, `第 ${i + 1} 阶段缺少审核角色`);
    const minApprovals = Number(s?.minApprovals ?? 1);
    if (!Number.isInteger(minApprovals) || minApprovals < 1 || minApprovals > 99) {
      throw httpError(400, `第 ${i + 1} 阶段最少同意人数应为 1-99 的整数`);
    }
    const ttlMs = Math.round(Number(s?.ttlMs ?? 0));
    if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > MAX_TTL_MS) {
      throw httpError(400, `第 ${i + 1} 阶段审批有效期应为 0（不限）至 90 天`);
    }
    return { role, minApprovals, allowResubmit: s?.allowResubmit !== false, ttlMs };
  });
}

function stagesHash(stages) {
  return crypto.createHash('sha1').update(JSON.stringify(stages)).digest('hex').slice(0, 16);
}

/** 当前生效策略；未配置（或已清除）返回 null。 */
function getPolicy(projectId) {
  const row = db.prepare('SELECT * FROM approval_policies WHERE project_id = ?').get(projectId);
  if (!row) return null;
  const stages = JSON.parse(row.stages);
  if (!stages.length) return null;
  return { stages, hash: row.policy_hash, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

function getPolicyPayload(projectId) {
  const p = getPolicy(projectId);
  return { policy: p ? { stages: p.stages, hash: p.hash, updatedBy: p.updatedBy, updatedAt: p.updatedAt } : null };
}

/**
 * 保存审批策略（stages=[] 表示清除策略，恢复单步审批）。
 * 策略变化后，所有进行中（含已过期未重开）的申请立即失效：它们冻结的
 * 策略指纹与新策略不一致，必须重新提交。
 */
function putPolicy(projectId, { stages, author }) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const norm = normalizeStages(stages);
  const before = getPolicy(projectId);
  const t = now();
  const hash = norm.length ? stagesHash(norm) : null;

  const txn = db.transaction(() => {
    if (!norm.length) {
      db.prepare('DELETE FROM approval_policies WHERE project_id = ?').run(projectId);
    } else {
      db.prepare(
        `INSERT INTO approval_policies (project_id, stages, policy_hash, updated_by, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET
           stages=excluded.stages, policy_hash=excluded.policy_hash,
           updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      ).run(projectId, JSON.stringify(norm), hash, author, t);
    }
    // 策略变化 → 进行中/已过期申请立即失效（指纹不一致的才动，幂等）
    const active = db
      .prepare(`SELECT id, status, policy_hash FROM release_requests WHERE project_id=? AND status IN ('pending','approved','expired')`)
      .all(projectId);
    const invalidated = [];
    for (const rq of active) {
      if ((rq.policy_hash || null) === hash) continue;
      const res = db.prepare(
        `UPDATE release_requests SET status='invalidated', invalid_reason='policy-changed', invalidated_at=?
         WHERE id=? AND status IN ('pending','approved','expired')`,
      ).run(t, rq.id);
      if (res.changes) invalidated.push(rq);
    }
    return invalidated;
  });
  const invalidated = txn();

  store.writeAudit(projectId, project.head_id, [
    {
      field: 'relpolicy:stages', action: 'relpolicy-update',
      oldValue: before ? JSON.stringify(before.stages) : null,
      newValue: norm.length ? JSON.stringify(norm) : '已清除（恢复单步审批）',
    },
    ...invalidated.map((rq) => ({
      field: `relreq:${rq.id}`, action: 'relreq-invalidate', oldValue: rq.status,
      newValue: 'invalidated:policy-changed（审批策略发生变化）',
    })),
  ], author);
  for (const rq of invalidated) {
    addEvent(projectId, rq.id, null, 'invalidate', '系统', { reason: 'policy-changed', text: '审批策略发生变化' });
  }
  return getPolicyPayload(projectId);
}

/* ================================ 门禁事件指纹 ================================ */

/** 事件是否已有有效豁免（含同订阅同版本同结果指纹事件共享的豁免，与门禁判定一致）。 */
function eventExempted(evRow) {
  const direct = db.prepare('SELECT id FROM gate_exemptions WHERE event_id=? AND revoked_at IS NULL').get(evRow.id);
  if (direct) return true;
  if (!evRow.result_hash) return false;
  const shared = db.prepare(
    `SELECT x.id FROM gate_evaluations e
     JOIN gate_exemptions x ON x.event_id = e.id AND x.revoked_at IS NULL
     WHERE e.subscription_id=? AND e.target_revision_id=? AND e.result_hash=? LIMIT 1`,
  ).get(evRow.subscription_id, evRow.target_revision_id, evRow.result_hash);
  return !!shared;
}

/**
 * 门禁事件快照：每个订阅在该版本上的最新完成事件状态
 * （pass / hit / exempted / config-changed / unevaluated / none）。
 * 指纹只绑定结果与豁免状态——同结果的重跑不会改变指纹，结果或豁免变化才会。
 */
function gateSnapshot(projectId, revisionId) {
  const subs = db.prepare('SELECT * FROM gate_subscriptions WHERE project_id=? ORDER BY id').all(projectId);
  const items = subs.map((sub) => {
    const ev = db.prepare(
      `SELECT * FROM gate_evaluations WHERE subscription_id=? AND target_revision_id=? AND status='done'
       ORDER BY finished_at DESC, id DESC LIMIT 1`,
    ).get(sub.id, revisionId);
    if (!ev) return { sub: sub.id, cfg: sub.config_hash, state: sub.status === 'active' ? 'unevaluated' : 'none' };
    if (ev.config_hash !== sub.config_hash) return { sub: sub.id, cfg: sub.config_hash, state: 'config-changed' };
    if (!ev.gate_hit) return { sub: sub.id, cfg: sub.config_hash, state: 'pass', rh: ev.result_hash };
    return { sub: sub.id, cfg: sub.config_hash, state: eventExempted(ev) ? 'exempted' : 'hit', rh: ev.result_hash };
  });
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(items)).digest('hex').slice(0, 16);
  return { items, fingerprint };
}

/* ================================ 阶段与事件 ================================ */

function addEvent(projectId, requestId, stageIndex, action, actor, detail) {
  db.prepare(
    `INSERT INTO relreq_events (project_id, request_id, stage_index, action, actor, detail, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(projectId, requestId, stageIndex ?? null, action, actor, detail ? JSON.stringify(detail) : null, now());
}

function parseStage(row) {
  if (!row) return null;
  return { ...row, allow_resubmit: !!row.allow_resubmit };
}

function stagesOf(requestId) {
  return db.prepare('SELECT * FROM relreq_stages WHERE request_id=? ORDER BY stage_index').all(requestId).map(parseStage);
}

function decisionsOf(requestId) {
  return db.prepare('SELECT * FROM relreq_decisions WHERE request_id=? ORDER BY created_at, id').all(requestId);
}

/** 阶段实例 + 该阶段会签意见（署名/意见/时间），供列表与详情展示会签进度。 */
function stagesWithDecisions(requestId) {
  const decisions = decisionsOf(requestId);
  return stagesOf(requestId).map((s) => {
    const ds = decisions.filter((d) => d.stage_id === s.id);
    return {
      ...s,
      approvals: ds.filter((d) => d.action === 'approve').length,
      decisions: ds.map((d) => ({
        reviewer: d.reviewer, role: d.role, action: d.action, comment: d.comment, created_at: d.created_at,
      })),
    };
  });
}

/** 提交申请时按冻结策略生成阶段实例：第一阶段激活，其余等待。 */
function createStages(projectId, requestId, stages, actor, t) {
  const insert = db.prepare(
    `INSERT INTO relreq_stages
       (id, request_id, project_id, stage_index, role, min_approvals, allow_resubmit, ttl_ms,
        status, started_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  stages.forEach((s, i) => {
    insert.run(sid(), requestId, projectId, i, s.role, s.minApprovals, s.allowResubmit ? 1 : 0, s.ttlMs,
      i === 0 ? 'active' : 'waiting', i === 0 ? t : null, i === 0 && s.ttlMs ? t + s.ttlMs : null);
  });
  if (stages.length) {
    addEvent(projectId, requestId, 0, 'stage-activate', actor, { role: stages[0].role, minApprovals: stages[0].minApprovals });
  }
}

/* ================================ 阶段超时 ================================ */

function ttlText(ttlMs) {
  if (ttlMs % 86400000 === 0) return `${ttlMs / 86400000} 天`;
  if (ttlMs % 3600000 === 0) return `${ttlMs / 3600000} 小时`;
  return `${Math.round(ttlMs / 60000)} 分钟`;
}

/**
 * 阶段超时扫描：当前阶段已过有效期 → 阶段标记 expired 并记录原因，
 * 申请随之进入 expired（负责人在门禁仍满足时可重新开启）。
 * 返回被过期的申请 id 列表（调用方据此写审计）。
 */
function sweepExpiry(requestRow, t) {
  if (requestRow.status !== 'pending' || !requestRow.policy_snapshot) return null;
  const stage = db.prepare('SELECT * FROM relreq_stages WHERE request_id=? AND stage_index=?')
    .get(requestRow.id, requestRow.current_stage);
  if (!stage || stage.status !== 'active' || !stage.expires_at || stage.expires_at > t) return null;
  const reason = `阶段「${stage.role}」超过审批有效期（${ttlText(stage.ttl_ms)}）未完成会签`;
  const txn = db.transaction(() => {
    const r1 = db.prepare(`UPDATE relreq_stages SET status='expired', expire_reason=?, decided_at=? WHERE id=? AND status='active'`)
      .run(reason, t, stage.id);
    if (!r1.changes) return false;
    db.prepare(`UPDATE release_requests SET status='expired' WHERE id=? AND status='pending'`).run(requestRow.id);
    return true;
  });
  if (!txn()) return null;
  addEvent(requestRow.project_id, requestRow.id, stage.stage_index, 'stage-expired', '系统', { reason });
  return { stage, reason };
}

/* ================================ 会签决定 ================================ */

/**
 * 分阶段会签：对申请当前阶段投同意/驳回。
 * - 幂等：同一审核人在同一阶段重复同一操作返回已有决定（deduplicated）；
 *   同一审核人在同一阶段的不同操作 409；
 * - 并发：决定落库与阶段迁移在同一事务，阶段/请求迁移均为条件更新，
 *   并发同意或驳回只有一个合法状态转换；
 * - 驳回必填意见；达到最少同意人数阶段即通过并激活下一阶段，
 *   全部阶段通过后申请转为 approved。
 */
function decideStaged(projectId, requestRow, { action, comment, author }) {
  const stage = db.prepare('SELECT * FROM relreq_stages WHERE request_id=? AND stage_index=?')
    .get(requestRow.id, requestRow.current_stage);
  if (!stage || stage.status !== 'active') {
    throw httpError(409, '当前审批阶段不在会签中（可能已被其他审核人终结），请刷新');
  }
  const text = String(comment || '');
  const t = now();

  const txn = db.transaction(() => {
    // 幂等：同一审核人同一阶段的重复操作
    const dup = db.prepare('SELECT * FROM relreq_decisions WHERE stage_id=? AND reviewer=?').get(stage.id, author);
    if (dup) {
      if (dup.action === action) return { deduplicated: true };
      throw httpError(409, `${author} 在本阶段已${dup.action === 'approve' ? '同意' : '驳回'}，不能重复操作`);
    }
    // 并发守卫：阶段可能刚被其他审核人终结
    const cur = db.prepare('SELECT status FROM relreq_stages WHERE id=?').get(stage.id);
    if (!cur || cur.status !== 'active') {
      throw httpError(409, '当前审批阶段已由其他审核人终结，请刷新查看');
    }
    db.prepare(
      `INSERT INTO relreq_decisions (id, request_id, stage_id, stage_index, project_id, reviewer, role, action, comment, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(did(), requestRow.id, stage.id, stage.stage_index, projectId, author, stage.role, action, text, t);

    if (action === 'reject') {
      const r = db.prepare(
        `UPDATE relreq_stages SET status='rejected', decided_at=?, decided_by=?, decision_comment=? WHERE id=? AND status='active'`,
      ).run(t, author, text, stage.id);
      if (r.changes !== 1) throw httpError(409, '阶段状态并发变化，请刷新');
      const r2 = db.prepare(
        `UPDATE release_requests SET status='rejected', reviewer=?, review_comment=?, reviewed_at=? WHERE id=? AND status='pending'`,
      ).run(author, text, t, requestRow.id);
      if (r2.changes !== 1) throw httpError(409, '申请状态并发变化，请刷新');
      return { deduplicated: false, outcome: 'rejected', stage };
    }

    const approvals = db.prepare(`SELECT COUNT(*) AS c FROM relreq_decisions WHERE stage_id=? AND action='approve'`)
      .get(stage.id).c;
    if (approvals < stage.min_approvals) {
      return { deduplicated: false, outcome: 'collecting', approvals, stage };
    }
    const r = db.prepare(`UPDATE relreq_stages SET status='approved', decided_at=?, decided_by=? WHERE id=? AND status='active'`)
      .run(t, author, stage.id);
    if (r.changes !== 1) throw httpError(409, '阶段状态并发变化，请刷新');
    const next = db.prepare('SELECT * FROM relreq_stages WHERE request_id=? AND stage_index=?')
      .get(requestRow.id, stage.stage_index + 1);
    if (next) {
      const r2 = db.prepare(`UPDATE relreq_stages SET status='active', started_at=?, expires_at=? WHERE id=? AND status='waiting'`)
        .run(t, next.ttl_ms ? t + next.ttl_ms : null, next.id);
      if (r2.changes !== 1) throw httpError(409, '阶段状态并发变化，请刷新');
      const r3 = db.prepare(`UPDATE release_requests SET current_stage=? WHERE id=? AND status='pending'`)
        .run(next.stage_index, requestRow.id);
      if (r3.changes !== 1) throw httpError(409, '申请状态并发变化，请刷新');
      return { deduplicated: false, outcome: 'stage-approved', approvals, stage, nextStage: parseStage(next) };
    }
    // 全部阶段通过
    const r3 = db.prepare(
      `UPDATE release_requests SET status='approved', reviewer=?, review_comment=?, reviewed_at=? WHERE id=? AND status='pending'`,
    ).run(author, text, t, requestRow.id);
    if (r3.changes !== 1) throw httpError(409, '申请状态并发变化，请刷新');
    return { deduplicated: false, outcome: 'all-approved', approvals, stage };
  });
  const out = txn();
  if (out.deduplicated) return { deduplicated: true };

  // 事件流 + 项目审计（决定、阶段结论、阶段激活、申请终态全部留痕）
  const stageIdx = out.stage.stage_index;
  addEvent(projectId, requestRow.id, stageIdx, 'decision', author, {
    action, comment: text, role: out.stage.role, approvals: out.approvals ?? null,
  });
  const auditEntries = [{
    field: `relreq:${requestRow.id}`, action: action === 'approve' ? 'relreq-approve' : 'relreq-reject',
    oldValue: `stage${stageIdx + 1}:${out.stage.role}`,
    newValue: JSON.stringify({ action, comment: text, stage: stageIdx + 1, role: out.stage.role }),
  }];
  if (out.outcome === 'rejected') {
    addEvent(projectId, requestRow.id, stageIdx, 'stage-rejected', author, { comment: text });
    addEvent(projectId, requestRow.id, null, 'request-rejected', author, { stage: stageIdx + 1 });
  } else if (out.outcome === 'stage-approved') {
    addEvent(projectId, requestRow.id, stageIdx, 'stage-approved', author, { approvals: out.approvals });
    addEvent(projectId, requestRow.id, out.nextStage.stage_index, 'stage-activate', author, {
      role: out.nextStage.role, minApprovals: out.nextStage.min_approvals,
    });
    auditEntries.push({
      field: `relreq:${requestRow.id}`, action: 'relreq-stage', oldValue: `stage${stageIdx + 1}`,
      newValue: `阶段 ${stageIdx + 1} 通过（${out.approvals}/${out.stage.min_approvals}），进入阶段 ${out.nextStage.stage_index + 1}「${out.nextStage.role}」`,
    });
  } else if (out.outcome === 'all-approved') {
    addEvent(projectId, requestRow.id, stageIdx, 'stage-approved', author, { approvals: out.approvals });
    addEvent(projectId, requestRow.id, null, 'request-approved', author, { approvals: out.approvals });
    auditEntries.push({
      field: `relreq:${requestRow.id}`, action: 'relreq-stage', oldValue: 'pending',
      newValue: `全部 ${stageIdx + 1} 个阶段会签通过，申请批准`,
    });
  }
  store.writeAudit(projectId, requestRow.revision_id, auditEntries, author);
  return { deduplicated: false, outcome: out.outcome, approvals: out.approvals };
}

/* ================================ 过期阶段重新开启 ================================ */

/**
 * 负责人在门禁仍满足时重新开启已过期阶段：
 * 预检指纹、策略指纹、门禁事件指纹必须与申请冻结值一致（否则改为失效并 409），
 * 且同版本没有其他进行中的申请。重开后阶段获得新的有效期窗口。
 */
function reopenStage(projectId, requestId, author) {
  const row = db.prepare('SELECT * FROM release_requests WHERE id=?').get(requestId);
  if (!row || row.project_id !== projectId) throw httpError(404, '发布申请不存在');
  if (row.status !== 'expired') throw httpError(400, '只有已过期（阶段超时）的申请可以重新开启');

  // 仍满足门禁：三类冻结指纹逐项复核，不一致则失效而不是重开
  const pre = qc().preflight(projectId, row.revision_id);
  if (!pre.canPublish || pre.fingerprint !== row.fingerprint) {
    qc().revalidateRequests(projectId, row.revision_id);
    throw httpError(409, '预检结果已变化，申请已失效，请重新预检并提交新申请', { invalidated: true });
  }
  const policy = getPolicy(projectId);
  if ((row.policy_hash || null) !== (policy ? policy.hash : null)) {
    qc().revalidateRequests(projectId, row.revision_id);
    throw httpError(409, '审批策略已变化，申请已失效，请重新提交申请', { invalidated: true });
  }
  const gs = gateSnapshot(projectId, row.revision_id);
  if (row.gate_fingerprint && gs.fingerprint !== row.gate_fingerprint) {
    qc().revalidateRequests(projectId, row.revision_id);
    throw httpError(409, '门禁评估结果已变化，申请已失效，请重新提交申请', { invalidated: true });
  }
  const gateResult = require('../gate/store').checkGate(projectId, row.revision_id);
  if (gateResult.blocked) {
    throw httpError(409, '发布回归门禁当前未通过，不能重新开启阶段', { gateBlocked: true, blockers: gateResult.unexempted });
  }

  const t = now();
  const txn = db.transaction(() => {
    const other = db.prepare(
      `SELECT id FROM release_requests WHERE project_id=? AND revision_id=? AND status IN ('pending','approved') AND id<>?`,
    ).get(projectId, row.revision_id, requestId);
    if (other) throw httpError(409, '该版本已存在其他进行中的申请，不能重新开启本申请');
    const stage = db.prepare('SELECT * FROM relreq_stages WHERE request_id=? AND stage_index=?')
      .get(requestId, row.current_stage);
    if (!stage || stage.status !== 'expired') throw httpError(409, '当前阶段不在已过期状态，请刷新');
    const r1 = db.prepare(
      `UPDATE relreq_stages SET status='active', started_at=?, expires_at=?, expire_reason=NULL,
         reopened_count=reopened_count+1 WHERE id=? AND status='expired'`,
    ).run(t, stage.ttl_ms ? t + stage.ttl_ms : null, stage.id);
    if (r1.changes !== 1) throw httpError(409, '阶段状态并发变化，请刷新');
    const r2 = db.prepare(`UPDATE release_requests SET status='pending' WHERE id=? AND status='expired'`).run(requestId);
    if (r2.changes !== 1) throw httpError(409, '申请状态并发变化，请刷新');
    return parseStage(stage);
  });
  const stage = txn();

  addEvent(projectId, requestId, stage.stage_index, 'stage-reopened', author, {
    role: stage.role, reopenedCount: stage.reopened_count + 1, newExpiresAt: stage.ttl_ms ? t + stage.ttl_ms : null,
  });
  store.writeAudit(projectId, row.revision_id, [
    {
      field: `relreq:${requestId}`, action: 'relreq-reopen', oldValue: 'expired',
      newValue: JSON.stringify({ stage: stage.stage_index + 1, role: stage.role, reopenedCount: stage.reopened_count + 1 }),
    },
  ], author);
  return { request: qc().getRequest(requestId) };
}

/* ================================ 详情（完整审计记录） ================================ */

function getRequestDetail(projectId, requestId) {
  const row = db.prepare('SELECT * FROM release_requests WHERE id=?').get(requestId);
  if (!row || row.project_id !== projectId) throw httpError(404, '发布申请不存在');
  const request = qc().getRequest(requestId);
  const events = db.prepare('SELECT * FROM relreq_events WHERE request_id=? ORDER BY id').all(requestId)
    .map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
  // 重新提交链：同一申请链的全部版本（保留前一申请的关联关系）
  const rootId = request.root_request_id || request.id;
  const chain = db.prepare(
    `SELECT id, version_no, status, applicant, created_at, invalid_reason FROM release_requests
     WHERE project_id=? AND (id=? OR root_request_id=?) ORDER BY version_no, created_at`,
  ).all(projectId, rootId, rootId);
  return {
    request: { ...request, stages: stagesWithDecisions(requestId) },
    events,
    chain,
  };
}

module.exports = {
  normalizeStages,
  getPolicy,
  getPolicyPayload,
  putPolicy,
  gateSnapshot,
  createStages,
  stagesWithDecisions,
  sweepExpiry,
  decideStaged,
  reopenStage,
  getRequestDetail,
  addEvent,
};
