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
 */
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
  return {
    revisionId,
    headRevId: headId,
    hardErrors,
    job: jobRow ? parseJob(jobRow) : null,
    blockerUnhandled,
    warningsPending,
    canPublish: hardErrors.length === 0 && Boolean(jobRow) && blockerUnhandled.length === 0,
  };
}

function publish(projectId, { revisionId, author, confirmations = [], message = '' }) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');

  // 同一版本重复发布：返回已有快照，不产生重复
  const existing = db
    .prepare(`SELECT * FROM releases WHERE project_id=? AND revision_id=? AND status='published'`)
    .get(projectId, revisionId);
  if (existing) return { release: parseRelease(existing), deduplicated: true };

  const pre = preflight(projectId, revisionId);
  if (!pre.canPublish) {
    throw httpError(400, '发布条件未满足：需通过时间轴硬约束、完成质检且阻断级问题全部处理', { preflight: pre });
  }
  const need = pre.warningsPending.map((w) => w.id);
  const got = new Set(confirmations);
  const missing = need.filter((id) => !got.has(id));
  if (missing.length) throw httpError(400, '警告级问题需在确认页逐项确认', { missing });

  const rev = store.getRevision(revisionId);
  const frozenRules = rules.expandRules(getScopedRules(projectId), rev.snapshot.tracks);
  const allFindings = db.prepare('SELECT * FROM qc_findings WHERE job_id = ?').all(pre.job.id).map(parseFinding);
  const headId = project.head_id;
  const countBy = (sev) => allFindings.filter((f) => f.severity === sev);
  const qcSummary = {
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
      confirmed: need,
      ignored: countBy('warning').filter((f) => f.status === 'ignored' && f.decided_on_rev === headId).map((f) => f.id),
    },
    headRevIdAtPublish: headId,
    publishedBy: author,
  };
  const files = exporter.renderFiles(rev.snapshot);
  const seq = db.prepare('SELECT COUNT(*) AS c FROM releases WHERE project_id = ?').get(projectId).c + 1;
  const label = `REL-${String(seq).padStart(3, '0')}`;
  const id = relid();
  const t = now();

  const txn = db.transaction(() => {
    // 警告级逐项确认留痕（状态、操作者、关联版本）
    for (const w of pre.warningsPending) {
      db.prepare(`UPDATE qc_findings SET status='confirmed', decided_by=?, decided_at=?, decide_reason=?, decided_on_rev=? WHERE id=?`)
        .run(author, t, '发布时逐项确认', headId, w.id);
      insertEvent(projectId, w.id, 'confirm', author, '发布时逐项确认', revisionId, { release: label });
    }
    db.prepare(
      `INSERT INTO releases (id, project_id, revision_id, seq, label, snapshot, rules_snapshot, qc_summary, files, status, message, author, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,'published',?,?,?)`,
    ).run(id, projectId, revisionId, seq, label, JSON.stringify(rev.snapshot), JSON.stringify(frozenRules),
      JSON.stringify(qcSummary), JSON.stringify(files), String(message || ''), author, t);
  });
  txn();

  const auditEntries = pre.warningsPending.map((w) => ({
    field: `qc:${w.id}`, action: 'qc-confirm', oldValue: w.status, newValue: `confirmed（发布 ${label}）`,
  }));
  auditEntries.push({
    field: `release:${id}`, action: 'publish', oldValue: null,
    newValue: JSON.stringify({ label, revisionId, jobId: pre.job.id, warningsConfirmed: need.length }),
  });
  store.writeAudit(projectId, revisionId, auditEntries, author);
  return { release: getRelease(id), deduplicated: false };
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
  publish,
  withdrawRelease,
  listReleases,
  getRelease,
  diffRelease,
};
