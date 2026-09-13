'use strict';
/**
 * 交付质检与发布快照：数据层与任务执行器。
 *
 * - 质检任务异步分批执行（每批之间检查取消标记），任务冻结发起时的规则配置；
 *   同一版本 + 同一规则指纹有正在运行的任务时去重，不产生重复任务。
 * - 处理决定（忽略/修复/发布确认）必须基于当前 HEAD（baseRevId 校验）；
 *   项目一旦产生新版本，此前基于旧版本的「忽略」决定由提交钩子统一标记为 stale，
 *   要求用户重新选择，且过期决定不能覆盖新修改。
 * - 自动修复只作用于 suggestion.safe 的明确安全项；应用前校验句子基准值未被改动，
 *   应用后再次检查时间轴硬约束（反向区间）与规则约束（不得引入新的重叠/互斥）。
 * - 发布快照冻结句子/轨道/规则配置/质检摘要与渲染好的 SRT/VTT；
 *   同一版本重复发布命中唯一索引，返回已有快照而不产生重复。
 * - 发布审批：预检通过后先生成「发布申请」，冻结当时版本与预检结果（含指纹）；
 *   申请可被审核人批准/驳回（驳回须填意见），只有批准且版本与预检指纹均未变化时
 *   才能发布快照。重复提交命中进行中申请即幂等返回；版本产生新提交、阻断问题重新
 *   出现或警告确认项变化时，待处理/已批准申请自动失效（提交钩子 + 读取时复检），
 *   需重新申请。审核与申请状态流转全部写审计，所有条件更新在事务内完成以保证并发一致。
 */
const crypto = require('crypto');
const { db } = require('../db');
const store = require('../store');
const { normalizeSnapshot, validate } = require('../validation');
const rules = require('./rules');
const exporter = require('./exporter');
const differ = require('./diff');

const now = () => Date.now();
const qid = () => 'q_' + crypto.randomBytes(9).toString('hex');
const fid = () => 'f_' + crypto.randomBytes(9).toString('hex');
const relid = () => 'rel_' + crypto.randomBytes(9).toString('hex');
const rqid = () => 'rq_' + crypto.randomBytes(9).toString('hex');
const httpError = store.httpError;

/* ================================ 规则配置 ================================ */

function getScopedRules(projectId) {
  const rows = db.prepare('SELECT * FROM qc_rules WHERE project_id = ?').all(projectId);
  return rules.rulesFromRows(rows);
}

function getRulesPayload(projectId) {
  const scoped = getScopedRules(projectId);
  return { defs: rules.RULE_DEFS, rules: scoped };
}

function putRules(projectId, { trackId = '', rules: cfg, author }) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const scope = String(trackId || '');
  const norm = rules.normalizeRulesConfig(cfg || {}); // 非法参数在此抛 400
  const t = now();
  const upsert = db.prepare(
    `INSERT INTO qc_rules (project_id, track_id, rule_key, enabled, severity, params, updated_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(project_id, track_id, rule_key) DO UPDATE SET
       enabled=excluded.enabled, severity=excluded.severity, params=excluded.params,
       updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
  );
  const getOld = db.prepare('SELECT * FROM qc_rules WHERE project_id=? AND track_id=? AND rule_key=?');
  const auditEntries = [];
  const txn = db.transaction(() => {
    for (const key of rules.RULE_KEYS) {
      const c = norm[key];
      const old = getOld.get(projectId, scope, key);
      upsert.run(projectId, scope, key, c.enabled ? 1 : 0, c.severity, JSON.stringify(c.params), author, t);
      auditEntries.push({
        field: `qcrule:${scope || 'project'}:${key}`,
        action: 'qc-rule',
        oldValue: old ? JSON.stringify({ enabled: !!old.enabled, severity: old.severity, params: JSON.parse(old.params) }) : null,
        newValue: JSON.stringify(c),
      });
    }
  });
  txn();
  store.writeAudit(projectId, project.head_id, auditEntries, author);
  return getRulesPayload(projectId);
}

/* ================================ 质检任务 ================================ */

function rulesHash(frozenRules) {
  return crypto.createHash('sha1').update(JSON.stringify(frozenRules)).digest('hex').slice(0, 12);
}

function parseJob(row) {
  if (!row) return null;
  return {
    ...row,
    progress: JSON.parse(row.progress || '{}'),
    summary: row.summary ? JSON.parse(row.summary) : null,
    rules_snapshot: JSON.parse(row.rules_snapshot),
  };
}
function getJob(jobId) {
  return parseJob(db.prepare('SELECT * FROM qc_jobs WHERE id = ?').get(jobId));
}
function listJobs(projectId) {
  return db.prepare('SELECT * FROM qc_jobs WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(projectId).map(parseJob);
}

/**
 * 发起质检：同一版本 + 同一规则指纹已有运行中的任务时直接返回该任务（去重）。
 * 任务异步分批执行，返回后即可凭 id 轮询进度/取消。
 */
function startJob(projectId, { revisionId, author }) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const rev = store.getRevision(revisionId);
  if (!rev || rev.project_id !== projectId) throw httpError(400, '版本无效');

  const frozen = rules.expandRules(getScopedRules(projectId), rev.snapshot.tracks);
  const hash = rulesHash(frozen);
  const running = db
    .prepare(`SELECT * FROM qc_jobs WHERE project_id=? AND revision_id=? AND status='running' AND rules_hash=?`)
    .get(projectId, revisionId, hash);
  if (running) return { job: parseJob(running), deduplicated: true };

  const id = qid();
  db.prepare(
    `INSERT INTO qc_jobs (id, project_id, revision_id, rules_snapshot, rules_hash, status, progress, summary, author, created_at)
     VALUES (?,?,?,?,?,'running',?,NULL,?,?)`,
  ).run(id, projectId, revisionId, JSON.stringify(frozen), hash,
    JSON.stringify({ done: 0, total: rev.snapshot.cues.length }), author, now());
  store.writeAudit(projectId, revisionId, [
    { field: `qcjob:${id}`, action: 'qc-run', oldValue: null, newValue: JSON.stringify({ revisionId, rulesHash: hash }) },
  ], author);
  setTimeout(() => runJob(id), 5);
  return { job: getJob(id), deduplicated: false };
}

const JOB_BATCH = 30;

/** 分批执行：每批处理 JOB_BATCH 句的逐句规则，批间检查取消标记，最后算成对规则。 */
function runJob(jobId) {
  const row = db.prepare('SELECT * FROM qc_jobs WHERE id = ?').get(jobId);
  if (!row || row.status !== 'running') return;
  const rev = store.getRevision(row.revision_id);
  if (!rev) {
    db.prepare(`UPDATE qc_jobs SET status='failed', finished_at=? WHERE id=?`).run(now(), jobId);
    return;
  }
  const snap = rev.snapshot;
  const scoped = JSON.parse(row.rules_snapshot); // 已按轨道展开的生效配置
  const cues = snap.cues;
  const findings = [];
  let i = 0;

  const step = () => {
    const cur = db.prepare('SELECT status FROM qc_jobs WHERE id = ?').get(jobId);
    if (!cur || cur.status !== 'running') return; // 已取消：丢弃结果
    const end = Math.min(i + JOB_BATCH, cues.length);
    for (; i < end; i++) findings.push(...rules.perCueFindings(snap, scoped, cues[i]));
    db.prepare('UPDATE qc_jobs SET progress=? WHERE id=?').run(JSON.stringify({ done: i, total: cues.length }), jobId);
    if (i < cues.length) return setTimeout(step, 5);
    findings.push(...rules.gapFindings(snap, scoped));
    findings.push(...rules.alignFindings(snap, scoped));
    finishJob(row, findings, cues.length);
  };
  setTimeout(step, 5);
}

function finishJob(jobRow, findings, totalCues) {
  const t = now();
  const insertFinding = db.prepare(
    `INSERT INTO qc_findings (id, job_id, project_id, revision_id, cue_id, track_id, rule_key, severity,
                              actual, evidence, suggestion, basis, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO qc_events (project_id, finding_id, action, actor, reason, revision_id, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const summary = rules.summarize(findings);
  const txn = db.transaction(() => {
    const cur = db.prepare('SELECT status FROM qc_jobs WHERE id = ?').get(jobRow.id);
    if (!cur || cur.status !== 'running') return false; // 完成前一刻被取消
    for (const f of findings) {
      const id = fid();
      insertFinding.run(id, jobRow.id, jobRow.project_id, jobRow.revision_id, f.cueId, f.trackId, f.ruleKey,
        f.severity, JSON.stringify(f.actual), f.evidence, f.suggestion ? JSON.stringify(f.suggestion) : null,
        JSON.stringify(f.basis), t);
      insertEvent.run(jobRow.project_id, id, 'found', jobRow.author, null, jobRow.revision_id,
        JSON.stringify({ ruleKey: f.ruleKey, severity: f.severity }), t);
    }
    db.prepare(`UPDATE qc_jobs SET status='done', summary=?, progress=?, finished_at=? WHERE id=?`)
      .run(JSON.stringify(summary), JSON.stringify({ done: totalCues, total: totalCues }), t, jobRow.id);
    return true;
  });
  const done = txn();
  if (done) {
    store.writeAudit(jobRow.project_id, jobRow.revision_id, [
      { field: `qcjob:${jobRow.id}`, action: 'qc-done', oldValue: null, newValue: JSON.stringify(summary) },
    ], jobRow.author);
  }
}

function cancelJob(projectId, jobId, author) {
  const row = db.prepare('SELECT * FROM qc_jobs WHERE id = ?').get(jobId);
  if (!row || row.project_id !== projectId) throw httpError(404, '质检任务不存在');
  if (row.status !== 'running') throw httpError(400, `任务已${row.status === 'done' ? '完成' : '结束'}，不能取消`);
  db.prepare(`UPDATE qc_jobs SET status='cancelled', finished_at=? WHERE id=?`).run(now(), jobId);
  store.writeAudit(projectId, row.revision_id, [
    { field: `qcjob:${jobId}`, action: 'qc-cancel', oldValue: 'running', newValue: 'cancelled' },
  ], author);
  return getJob(jobId);
}

/* ================================ 质检结果 ================================ */

function parseFinding(row) {
  if (!row) return null;
  return {
    ...row,
    actual: JSON.parse(row.actual),
    suggestion: row.suggestion ? JSON.parse(row.suggestion) : null,
    basis: JSON.parse(row.basis),
  };
}
function getFinding(findingId) {
  return parseFinding(db.prepare('SELECT * FROM qc_findings WHERE id = ?').get(findingId));
}
function listFindings(projectId, jobId, { trackId, severity, status } = {}) {
  let sql = 'SELECT * FROM qc_findings WHERE project_id = ? AND job_id = ?';
  const args = [projectId, jobId];
  if (trackId) { sql += ' AND track_id = ?'; args.push(trackId); }
  if (severity) { sql += ' AND severity = ?'; args.push(severity); }
  if (status) { sql += ' AND status = ?'; args.push(status); }
  sql += ' ORDER BY created_at, id';
  return db.prepare(sql).all(...args).map(parseFinding);
}
function eventsOf(findingId) {
  return db.prepare('SELECT * FROM qc_events WHERE finding_id = ? ORDER BY id').all(findingId);
}
function findingDetail(projectId, findingId) {
  const f = getFinding(findingId);
  if (!f || f.project_id !== projectId) throw httpError(404, '质检结果不存在');
  return { finding: f, events: eventsOf(findingId) };
}
function cueHistory(projectId, cueId) {
  const rows = db.prepare('SELECT * FROM qc_findings WHERE project_id = ? AND cue_id = ? ORDER BY created_at, id').all(projectId, cueId);
  return rows.map((r) => ({ ...parseFinding(r), events: eventsOf(r.id) }));
}

function insertEvent(projectId, findingId, action, actor, reason, revisionId, detail) {
  db.prepare(
    `INSERT INTO qc_events (project_id, finding_id, action, actor, reason, revision_id, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(projectId, findingId, action, actor, reason || null, revisionId || null, detail ? JSON.stringify(detail) : null, now());
}

/**
 * 批量标记忽略。决定必须基于当前 HEAD（baseRevId），否则视为基于旧版本的处理，
 * 返回 409 要求重新选择——过期决定不能落到新版本上。
 */
function ignoreFindings(projectId, { findingIds, baseRevId, reason, author }) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  if (!Array.isArray(findingIds) || !findingIds.length) throw httpError(400, '缺少 findingIds');
  if (project.head_id !== baseRevId) {
    throw httpError(409, '项目已产生新版本，基于旧版本的处理已过期，请刷新后重新选择', { stale: true, headRevId: project.head_id });
  }
  const rows = findingIds.map((id) => db.prepare('SELECT * FROM qc_findings WHERE id = ?').get(id));
  for (const f of rows) {
    if (!f || f.project_id !== projectId) throw httpError(400, '质检结果不存在或不属于本项目');
    if (!['open', 'stale'].includes(f.status)) {
      throw httpError(400, `结果 ${f.id} 当前状态为 ${f.status}，不能标记忽略`);
    }
  }
  const t = now();
  const auditEntries = [];
  const txn = db.transaction(() => {
    for (const f of rows) {
      db.prepare(`UPDATE qc_findings SET status='ignored', decided_by=?, decided_at=?, decide_reason=?, decided_on_rev=? WHERE id=?`)
        .run(author, t, String(reason || ''), baseRevId, f.id);
      insertEvent(projectId, f.id, 'ignore', author, reason, baseRevId, { from: f.status });
      auditEntries.push({
        field: `qc:${f.id}`, action: 'qc-ignore', oldValue: f.status,
        newValue: JSON.stringify({ status: 'ignored', reason: String(reason || ''), rule: f.rule_key, cue: f.cue_id }),
      });
    }
  });
  txn();
  store.writeAudit(projectId, baseRevId, auditEntries, author);
  return { updated: rows.length };
}

/**
 * 批量接受建议修复（只接受 suggestion.safe 的明确安全项）：
 * 1) 要求 baseRevId == HEAD；
 * 2) 逐条校验句子基准值未被他人改动（防止覆盖新修改）；
 * 3) 应用补丁后再次检查时间轴约束：硬约束（反向区间）不得出现，
 *    且不得引入新的重叠/互斥；
 * 4) 全部通过才提交一个 qcfix 版本，并逐条留痕。
 */
function applyFixes(projectId, { findingIds, baseRevId, reason, author }) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  if (!Array.isArray(findingIds) || !findingIds.length) throw httpError(400, '缺少 findingIds');
  if (project.head_id !== baseRevId) {
    throw httpError(409, '项目已产生新版本，基于旧版本的修复已过期，请重新质检后再处理', { stale: true, headRevId: project.head_id });
  }
  const head = store.getRevision(baseRevId);
  const rows = findingIds.map((id) => db.prepare('SELECT * FROM qc_findings WHERE id = ?').get(id));

  const failures = [];
  const snap = JSON.parse(JSON.stringify(head.snapshot));
  for (const f of rows) {
    if (!f || f.project_id !== projectId) { failures.push({ id: f?.id || null, reason: '质检结果不存在' }); continue; }
    if (!['open', 'stale'].includes(f.status)) { failures.push({ id: f.id, reason: `当前状态为 ${f.status}，不可修复` }); continue; }
    const sug = f.suggestion ? JSON.parse(f.suggestion) : null;
    if (!sug || sug.kind !== 'set_times' || !sug.safe) { failures.push({ id: f.id, reason: '非明确安全项，不能自动修复' }); continue; }
    const cue = snap.cues.find((c) => c.id === f.cue_id);
    const basis = JSON.parse(f.basis);
    if (!cue) { failures.push({ id: f.id, reason: '句子已被删除' }); continue; }
    if (cue.locked) { failures.push({ id: f.id, reason: '句子已锁定' }); continue; }
    if (cue.start !== basis.start || cue.end !== basis.end || cue.text !== basis.text) {
      failures.push({ id: f.id, reason: '句子在质检后已被修改，自动修复会覆盖新修改，请重新质检' });
    }
  }
  if (failures.length) throw httpError(409, '部分结果不可自动修复', { failures });

  for (const f of rows) {
    const sug = JSON.parse(f.suggestion);
    const cue = snap.cues.find((c) => c.id === f.cue_id);
    Object.assign(cue, sug.patch);
  }
  const norm = normalizeSnapshot(snap);

  // 修复后再次检查时间轴约束：硬错误拒绝；不得引入新的重叠/互斥
  const hard = validate(norm).hardErrors;
  if (hard.length) throw httpError(400, '修复后存在反向区间，已放弃提交', { hardErrors: hard });
  const vKey = (v) => v.type + ':' + [...v.cueIds].sort().join('+');
  const beforeKeys = new Set(validate(head.snapshot).violations.map(vKey));
  const introduced = validate(norm).violations.filter((v) => !beforeKeys.has(vKey(v)));
  if (introduced.length) throw httpError(400, '修复会引入新的时间轴冲突（重叠/互斥），已放弃提交', { violations: introduced });

  const t = now();
  const rev = store.commitRevision({
    projectId,
    parent1: head.id,
    parent2: null,
    kind: 'qcfix',
    snapshot: norm,
    author,
    message: `质检自动修复 ${rows.length} 处（${[...new Set(rows.map((f) => f.rule_key))].join('/')}）`,
    auditAgainst: head.snapshot,
    extraAudit: rows.map((f) => ({
      field: `qc:${f.id}`, action: 'qc-fix', oldValue: f.status,
      newValue: JSON.stringify({ status: 'fixed', patch: JSON.parse(f.suggestion).patch, reason: String(reason || '') }),
    })),
    meta: { kind: 'qcfix', jobId: rows[0].job_id, findingIds: rows.map((f) => f.id), reason: String(reason || '') },
  });
  const txn = db.transaction(() => {
    for (const f of rows) {
      db.prepare(`UPDATE qc_findings SET status='fixed', decided_by=?, decided_at=?, decide_reason=?, decided_on_rev=?, fix_revision_id=? WHERE id=?`)
        .run(author, t, String(reason || ''), baseRevId, rev.id, f.id);
      insertEvent(projectId, f.id, 'fix', author, reason, rev.id, { patch: JSON.parse(f.suggestion).patch, baseRevId });
    }
  });
  txn();
  return { status: 'committed', revision: rev, fixed: rows.length };
}

/* --------- 提交钩子：新版本产生后，基于旧版本的「忽略」决定统一标记为过期 --------- */
store.onCommit(({ projectId, revision, author }) => {
  const stale = db
    .prepare(`SELECT id FROM qc_findings WHERE project_id=? AND status='ignored' AND decided_on_rev <> ?`)
    .all(projectId, revision.id);
  if (!stale.length) return;
  const upd = db.prepare(`UPDATE qc_findings SET status='stale' WHERE id=?`);
  const auditEntries = [];
  for (const f of stale) {
    upd.run(f.id);
    insertEvent(projectId, f.id, 'stale', author, '项目产生新版本，基于旧版本的处理决定过期，需重新选择', revision.id, null);
    auditEntries.push({ field: `qc:${f.id}`, action: 'qc-stale', oldValue: 'ignored', newValue: 'stale' });
  }
  store.writeAudit(projectId, revision.id, auditEntries, author);
});

/* --------- 提交钩子：项目产生新提交后，待处理/已批准的发布申请统一失效 --------- */
store.onCommit(({ projectId, revision, author }) => {
  const active = db
    .prepare(`SELECT id, revision_id, status FROM release_requests WHERE project_id=? AND status IN ('pending','approved')`)
    .all(projectId);
  if (!active.length) return;
  const t = now();
  const auditEntries = [];
  for (const rq of active) {
    db.prepare(
      `UPDATE release_requests SET status='invalidated', invalid_reason='new-revision', invalidated_at=? WHERE id=? AND status IN ('pending','approved')`,
    ).run(t, rq.id);
    auditEntries.push({
      field: `relreq:${rq.id}`, action: 'relreq-invalidate', oldValue: rq.status,
      newValue: `invalidated:new-revision（项目 HEAD 推进到 ${revision.id}）`,
    });
  }
  store.writeAudit(projectId, revision.id, auditEntries, author || '系统');
});

/* ================================ 发布快照 ================================ */

function parseRelease(row) {
  if (!row) return null;
  return {
    ...row,
    snapshot: JSON.parse(row.snapshot),
    rules_snapshot: JSON.parse(row.rules_snapshot),
    qc_summary: JSON.parse(row.qc_summary),
    files: JSON.parse(row.files),
  };
}
function getRelease(releaseId) {
  return parseRelease(db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId));
}
function listReleases(projectId) {
  return db.prepare('SELECT * FROM releases WHERE project_id = ? ORDER BY seq DESC').all(projectId).map((r) => {
    const full = parseRelease(r);
    // 列表不回传大字段
    const { snapshot, files, ...rest } = full;
    return { ...rest, cueCount: snapshot.cues.length, trackCount: snapshot.tracks.length };
  });
}

function latestDoneJob(projectId, revisionId) {
  return db
    .prepare(`SELECT * FROM qc_jobs WHERE project_id=? AND revision_id=? AND status='done' ORDER BY finished_at DESC, id DESC`)
    .get(projectId, revisionId);
}

function isHandled(f, headId) {
  return f.status === 'fixed' || (f.status === 'ignored' && f.decided_on_rev === headId);
}

/**
 * 发布预检：时间轴硬约束 + 阻断级全部处理 + 待逐项确认的警告清单。
 * 阻断级「已处理」= 已修复，或基于当前 HEAD 标记的忽略（过期忽略不算）。
 *
 * fingerprint 摘要绑定预检结果：项目 HEAD、硬约束、质检任务、阻断处理情况、
 * 待确认警告清单——任一变化（版本产生新提交、阻断问题重新出现、警告确认项变化等）
 * 都会改变指纹，据此将此前的发布申请自动失效。
 */
function preflightFingerprint(pre) {
  return crypto.createHash('sha1').update(JSON.stringify({
    head: pre.headRevId,
    hardErrors: pre.hardErrors.map((h) => `${h.type}:${(h.cueIds || []).slice().sort().join(',')}`),
    jobId: pre.job ? pre.job.id : null,
    jobFinishedAt: pre.job ? pre.job.finished_at : null,
    blockers: pre.blockerUnhandled.map((f) => `${f.id}:${f.status}`),
    warnings: pre.warningsPending.map((f) => f.id).sort(),
  })).digest('hex').slice(0, 16);
}

function preflight(projectId, revisionId) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const rev = store.getRevision(revisionId);
  if (!rev || rev.project_id !== projectId) throw httpError(400, '版本无效');
  const hardErrors = validate(rev.snapshot).hardErrors;
  const jobRow = latestDoneJob(projectId, revisionId);
  const findings = jobRow
    ? db.prepare('SELECT * FROM qc_findings WHERE job_id = ?').all(jobRow.id).map(parseFinding)
    : [];
  const headId = project.head_id;
  const blockerUnhandled = findings.filter((f) => f.severity === 'blocker' && !isHandled(f, headId));
  const warningsPending = findings.filter((f) => f.severity === 'warning' && ['open', 'stale'].includes(f.status));
  const result = {
    revisionId,
    headRevId: headId,
    hardErrors,
    job: jobRow ? parseJob(jobRow) : null,
    blockerUnhandled,
    warningsPending,
    canPublish: hardErrors.length === 0 && Boolean(jobRow) && blockerUnhandled.length === 0,
  };
  result.fingerprint = preflightFingerprint(result);
  return result;
}

/* ================================ 发布申请与审批 ================================ */

const ACTIVE_REQ = `status IN ('pending','approved')`;

function parseRequest(row) {
  if (!row) return null;
  return {
    ...row,
    preflight: JSON.parse(row.preflight),
    confirmations: JSON.parse(row.confirmations || '[]'),
  };
}
function getRequest(requestId) {
  return parseRequest(db.prepare('SELECT * FROM release_requests WHERE id = ?').get(requestId));
}
function listRequests(projectId) {
  revalidateRequests(projectId);
  return db
    .prepare('SELECT * FROM release_requests WHERE project_id = ? ORDER BY created_at DESC, id DESC')
    .all(projectId)
    .map((r) => {
      const full = parseRequest(r);
      // 列表不回传大字段
      const { preflight, ...rest } = full;
      return {
        ...rest,
        boundHeadRevId: preflight.headRevId,
        blockerCount: preflight.blockerUnhandled.length,
        warningCount: preflight.warningsPending.length,
        hasHardErrors: preflight.hardErrors.length > 0,
      };
    });
}

const INVALID_REASON_TEXT = {
  'new-revision': '版本产生新提交',
  'blockers-changed': '阻断问题重新出现或处理情况变化',
  'warnings-changed': '警告确认项发生变化',
  'hard-error': '时间轴硬约束不再通过',
  'qc-changed': '质检结果发生变化',
};

/**
 * 读取时复检：把预检指纹与当前不一致的待处理/已批准申请置为失效。
 * 与提交钩子互补——质检结果/处理决定/警告确认发生变化但未产生新版本时，
 * 由此路径懒失效，保证页面与审核接口看到的状态始终一致。
 */
function revalidateRequests(projectId, revisionId = null) {
  let rows = db
    .prepare(`SELECT * FROM release_requests WHERE project_id=? AND ${ACTIVE_REQ}`)
    .all(projectId);
  if (revisionId) rows = rows.filter((r) => r.revision_id === revisionId);
  if (!rows.length) return;
  const t = now();
  const auditEntries = [];
  const invalidate = db.prepare(
    `UPDATE release_requests SET status='invalidated', invalid_reason=?, invalidated_at=? WHERE id=? AND ${ACTIVE_REQ}`,
  );
  const txn = db.transaction(() => {
    for (const row of rows) {
      const bound = JSON.parse(row.preflight);
      let current;
      try {
        current = preflight(projectId, row.revision_id);
      } catch {
        continue; // 版本/项目异常：交给调用方报错
      }
      if (current.fingerprint === row.fingerprint) continue;
      const reason = current.headRevId !== row.head_rev_id
        ? 'new-revision'
        : JSON.stringify(current.blockerUnhandled.map((f) => f.id).sort()) !==
            JSON.stringify(bound.blockerUnhandled.map((f) => f.id).sort())
          ? 'blockers-changed'
          : JSON.stringify(current.warningsPending.map((f) => f.id).sort()) !==
              JSON.stringify(bound.warningsPending.map((f) => f.id).sort())
            ? 'warnings-changed'
            : 'qc-changed';
      const res = invalidate.run(reason, t, row.id);
      if (res.changes) {
        auditEntries.push({
          field: `relreq:${row.id}`, action: 'relreq-invalidate', oldValue: row.status,
          newValue: `invalidated:${reason}（${INVALID_REASON_TEXT[reason] || reason}）`,
        });
      }
    }
  });
  txn();
  if (auditEntries.length) {
    const headId = store.getProject(projectId).head_id;
    store.writeAudit(projectId, headId, auditEntries, '系统');
  }
}

/**
 * 创建发布申请。预检必须通过；警告项须随申请逐项确认（与申请一起冻结）。
 * 幂等：同版本已有待处理/已批准申请时直接返回已有申请（deduplicated=true），
 *       不产生重复记录；待处理/已批准申请若复检发现已失效则先失效再新建。
 */
function createRequest(projectId, { revisionId, confirmations = [], message = '', author }) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const rev = store.getRevision(revisionId);
  if (!rev || rev.project_id !== projectId) throw httpError(400, '版本无效');

  // 先做读取时复检：指纹已变化的旧申请在唯一索引上腾位
  revalidateRequests(projectId, revisionId);

  // 该版本已有有效发布快照：无需再申请（撤销发布后才允许重新申请）
  const published = db
    .prepare(`SELECT id,label FROM releases WHERE project_id=? AND revision_id=? AND status='published'`)
    .get(projectId, revisionId);
  if (published) throw httpError(400, `该版本已发布（${published.label}），无需重复申请；如需重发请先撤销原发布`);

  const pre = preflight(projectId, revisionId);
  if (!pre.canPublish) {
    throw httpError(400, '发布条件未满足：需通过时间轴硬约束、完成质检且阻断级问题全部处理', { preflight: pre });
  }
  const need = pre.warningsPending.map((w) => w.id);
  const got = new Set(confirmations);
  const missing = need.filter((id) => !got.has(id));
  const extra = [...got].filter((id) => !need.includes(id));
  if (missing.length || extra.length) {
    throw httpError(400, '警告级问题需随申请逐项确认，确认项与预检清单不一致', { missing, extra });
  }

  const existing = db
    .prepare(`SELECT * FROM release_requests WHERE project_id=? AND revision_id=? AND ${ACTIVE_REQ}`)
    .get(projectId, revisionId);
  if (existing) return { request: parseRequest(existing), deduplicated: true };

  const id = rqid();
  const t = now();
  const payload = {
    id, project_id: projectId, revision_id: revisionId, head_rev_id: pre.headRevId,
    preflight: JSON.stringify(pre), fingerprint: pre.fingerprint,
    confirmations: JSON.stringify(need),
    message: String(message || ''), applicant: author, created_at: t,
  };
  db.prepare(
    `INSERT INTO release_requests
       (id, project_id, revision_id, head_rev_id, status, preflight, fingerprint, confirmations,
        message, applicant, reviewer, review_comment, invalid_reason, created_at, reviewed_at, invalidated_at, published_at, release_id)
     VALUES (@id, @project_id, @revision_id, @head_rev_id, 'pending', @preflight, @fingerprint, @confirmations,
        @message, @applicant, NULL, NULL, NULL, @created_at, NULL, NULL, NULL, NULL)`,
  ).run(payload);
  store.writeAudit(projectId, revisionId, [
    {
      field: `relreq:${id}`, action: 'relreq-submit', oldValue: null,
      newValue: JSON.stringify({
        revisionId, headRevId: pre.headRevId, fingerprint: pre.fingerprint,
        jobId: pre.job.id, warningsConfirmed: need.length, message: String(message || ''),
      }),
    },
  ], author);
  return { request: getRequest(id), deduplicated: false };
}

/** 统一的审核入口：条件更新保证并发下同一申请不会被重复批准/驳回或批准后再驳回。 */
function decideRequest(projectId, requestId, { action, comment = '', author }) {
  if (!['approve', 'reject'].includes(action)) throw httpError(400, 'action 应为 approve 或 reject');
  const row = db.prepare('SELECT * FROM release_requests WHERE id = ?').get(requestId);
  if (!row || row.project_id !== projectId) throw httpError(404, '发布申请不存在');

  // 审核前复检：绑定的版本/预检结果已变化则申请失效，审核动作拒绝执行
  revalidateRequests(projectId, row.revision_id);
  const cur = getRequest(requestId);
  if (cur.status === 'invalidated') {
    throw httpError(409, `申请已失效（${INVALID_REASON_TEXT[cur.invalid_reason] || cur.invalid_reason}），请重新申请`, {
      invalidated: true, reason: cur.invalid_reason,
    });
  }
  if (action === 'reject' && !String(comment || '').trim()) {
    throw httpError(400, '驳回必须填写审核意见');
  }
  if (cur.status !== 'pending') {
    throw httpError(409, cur.status === 'approved'
      ? '申请已批准，不能重复审核'
      : cur.status === 'rejected'
        ? '申请已驳回，不能重复审核'
        : '申请已发布，不能再审核');
  }

  const next = action === 'approve' ? 'approved' : 'rejected';
  const t = now();
  const res = db.prepare(
    `UPDATE release_requests SET status=?, reviewer=?, review_comment=?, reviewed_at=?
     WHERE id=? AND status='pending'`,
  ).run(next, author, String(comment || ''), t, requestId);
  if (res.changes === 0) {
    // 并发：另一个审核请求已先落库
    const winner = getRequest(requestId);
    throw httpError(409, `申请已被其他审核人${winner.status === 'approved' ? '批准' : '驳回'}，状态以记录为准`, {
      status: winner.status, reviewer: winner.reviewer,
    });
  }
  store.writeAudit(projectId, row.revision_id, [
    {
      field: `relreq:${requestId}`,
      action: action === 'approve' ? 'relreq-approve' : 'relreq-reject',
      oldValue: 'pending',
      newValue: JSON.stringify({ status: next, comment: String(comment || '') }),
    },
  ], author);
  return { request: getRequest(requestId) };
}

/**
 * 凭已批准的发布申请生成快照。并发一致性由一个事务保证：
 *  1) 申请必须存在且属于本项目；
 *  2) 事务内条件校验申请状态 = approved 且预检指纹与当前一致，否则拒绝
 *     （批准后版本/预检结果发生变化会先经读取时复检置为 invalidated）；
 *  3) 同版本已有 published 快照（另一个请求/并发先发）→ 幂等返回已有快照。
 * 警告项在发布时落「逐项确认」状态，申请随后标记 published 并关联快照。
 */
function publish(projectId, { requestId, author }) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const reqRow = db.prepare('SELECT * FROM release_requests WHERE id = ?').get(requestId);
  if (!reqRow || reqRow.project_id !== projectId) throw httpError(404, '发布申请不存在');

  // 发布前复检：绑定的版本/预检结果已变化则申请自动失效，发布被拒绝
  revalidateRequests(projectId, reqRow.revision_id);
  const fresh = getRequest(requestId);
  if (fresh.status === 'invalidated') {
    throw httpError(409, `申请已失效（${INVALID_REASON_TEXT[fresh.invalid_reason] || fresh.invalid_reason}），请重新申请`, {
      invalidated: true, reason: fresh.invalid_reason,
    });
  }

  // 同一版本重复发布：返回已有快照，不产生重复
  const existing = db
    .prepare(`SELECT * FROM releases WHERE project_id=? AND revision_id=? AND status='published'`)
    .get(projectId, reqRow.revision_id);
  if (existing) return { release: parseRelease(existing), deduplicated: true, requestId };

  const bound = fresh.preflight;
  const revisionId = reqRow.revision_id;
  const rev = store.getRevision(revisionId);
  const pre = preflight(projectId, revisionId);
  if (!pre.canPublish || pre.fingerprint !== bound.fingerprint) {
    // 复检之后、入事务之前预检发生变化：懒失效并拒绝发布
    revalidateRequests(projectId, revisionId);
    const after = getRequest(requestId);
    throw httpError(409, after.status === 'invalidated'
      ? `申请已失效（${INVALID_REASON_TEXT[after.invalid_reason] || after.invalid_reason}），请重新申请`
      : '申请绑定的预检结果已变化，请重新申请',
    { invalidated: after.status === 'invalidated', reason: after.invalid_reason });
  }
  const frozenRules = rules.expandRules(getScopedRules(projectId), rev.snapshot.tracks);
  const allFindings = db.prepare('SELECT * FROM qc_findings WHERE job_id = ?').all(pre.job.id).map(parseFinding);
  const headId = project.head_id;
  const countBy = (sev) => allFindings.filter((f) => f.severity === sev);
  const warningNeed = pre.warningsPending.map((w) => w.id);
  const qcSummary = {
    requestId,
    jobId: pre.job.id,
    jobRevisionId: revisionId,
    jobFinishedAt: pre.job.finished_at,
    rulesHash: pre.job.rules_hash,
    blocker: {
      total: countBy('blocker').length,
      fixed: countBy('blocker').filter((f) => f.status === 'fixed').length,
      ignored: countBy('blocker').filter((f) => f.status === 'ignored' && f.decided_on_rev === headId).length,
    },
    warning: {
      total: countBy('warning').length,
      confirmed: warningNeed,
      ignored: countBy('warning').filter((f) => f.status === 'ignored' && f.decided_on_rev === headId).map((f) => f.id),
    },
    headRevIdAtPublish: headId,
    publishedBy: author,
    approvedBy: fresh.reviewer,
  };
  const files = exporter.renderFiles(rev.snapshot);
  const seq = db.prepare('SELECT COUNT(*) AS c FROM releases WHERE project_id = ?').get(projectId).c + 1;
  const label = `REL-${String(seq).padStart(3, '0')}`;
  const id = relid();
  const t = now();

  const txn = db.transaction(() => {
    // 事务内条件校验：并发审核/发布时只有一个写入能成功
    const cur = db.prepare(`SELECT * FROM release_requests WHERE id=? AND status='approved'`).get(requestId);
    if (!cur) {
      const nowRow = getRequest(requestId);
      throw httpError(409, nowRow.status === 'published'
        ? '该申请已发布'
        : '申请已失效或未获批准，不能发布（请刷新后重新申请/审核）', { status: nowRow.status });
    }
    // 事务内最后一次指纹比对（指纹在复检后变化的极窄竞态：直接拒绝，不落不一致状态）
    const pre2 = preflight(projectId, revisionId);
    if (!pre2.canPublish || pre2.fingerprint !== cur.fingerprint) {
      throw httpError(409, '申请绑定的预检结果在发布时发生变化，请重新预检后再发布', { race: true });
    }
    const dup = db
      .prepare(`SELECT id FROM releases WHERE project_id=? AND revision_id=? AND status='published'`)
      .get(projectId, revisionId);
    if (dup) return { duplicateOf: dup.id };

    // 警告级逐项确认留痕（状态、操作者、关联版本）
    for (const w of pre2.warningsPending) {
      db.prepare(`UPDATE qc_findings SET status='confirmed', decided_by=?, decided_at=?, decide_reason=?, decided_on_rev=? WHERE id=?`)
        .run(author, t, '发布时逐项确认', headId, w.id);
      insertEvent(projectId, w.id, 'confirm', author, '发布时逐项确认', revisionId, { release: label });
    }
    db.prepare(
      `INSERT INTO releases (id, project_id, revision_id, seq, label, snapshot, rules_snapshot, qc_summary, files, status, message, author, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,'published',?,?,?)`,
    ).run(id, projectId, revisionId, seq, label, JSON.stringify(rev.snapshot), JSON.stringify(frozenRules),
      JSON.stringify(qcSummary), JSON.stringify(files), String(reqRow.message || ''), author, t);
    db.prepare(
      `UPDATE release_requests SET status='published', published_at=?, release_id=? WHERE id=? AND status='approved'`,
    ).run(t, id, requestId);
    return { duplicateOf: null };
  });

  const result = txn();
  if (result.duplicateOf) {
    return { release: getRelease(result.duplicateOf), deduplicated: true, requestId };
  }

  const auditEntries = pre.warningsPending.map((w) => ({
    field: `qc:${w.id}`, action: 'qc-confirm', oldValue: w.status, newValue: `confirmed（发布 ${label}）`,
  }));
  auditEntries.push({
    field: `relreq:${requestId}`, action: 'relreq-publish', oldValue: 'approved',
    newValue: JSON.stringify({ release: id, label, reviewer: fresh.reviewer }),
  });
  auditEntries.push({
    field: `release:${id}`, action: 'publish', oldValue: null,
    newValue: JSON.stringify({ label, revisionId, requestId, jobId: pre.job.id, warningsConfirmed: warningNeed.length }),
  });
  store.writeAudit(projectId, revisionId, auditEntries, author);
  return { release: getRelease(id), deduplicated: false, requestId };
}

function withdrawRelease(projectId, releaseId, { author, reason }) {
  const row = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
  if (!row || row.project_id !== projectId) throw httpError(404, '发布快照不存在');
  if (row.status !== 'published') throw httpError(400, '该快照已撤销，不能重复撤销');
  db.prepare(`UPDATE releases SET status='withdrawn', withdrawn_by=?, withdrawn_at=?, withdraw_reason=? WHERE id=?`)
    .run(author, now(), String(reason || ''), releaseId);
  store.writeAudit(projectId, row.revision_id, [
    { field: `release:${releaseId}`, action: 'withdraw', oldValue: row.label, newValue: String(reason || '') },
  ], author);
  return getRelease(releaseId);
}

/** 快照与任意后续版本的逐句差异。 */
function diffRelease(projectId, releaseId, againstRevId) {
  const rel = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
  if (!rel || rel.project_id !== projectId) throw httpError(404, '发布快照不存在');
  const rev = store.getRevision(againstRevId);
  if (!rev || rev.project_id !== projectId) throw httpError(400, '对比版本无效');
  const result = differ.diffSnapshots(JSON.parse(rel.snapshot), rev.snapshot);
  return { release: { id: rel.id, label: rel.label, revision_id: rel.revision_id }, against: { id: rev.id, message: rev.message }, ...result };
}

module.exports = {
  getRulesPayload,
  putRules,
  startJob,
  getJob,
  listJobs,
  cancelJob,
  listFindings,
  findingDetail,
  cueHistory,
  ignoreFindings,
  applyFixes,
  preflight,
  createRequest,
  decideRequest,
  listRequests,
  getRequest,
  publish,
  withdrawRelease,
  listReleases,
  getRelease,
  diffRelease,
};
