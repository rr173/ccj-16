'use strict';
/**
 * 发布回归门禁与变更订阅。
 *
 * 订阅（gate_subscriptions）：
 *   用户可在同一项目下创建多个订阅，各自指定基线（任意历史版本 revision 或
 *   发布快照 release，创建/修改时冻结基线内容）与关注条件：轨道、差异类型、
 *   关键词、质检严重级别。订阅可暂停/恢复：暂停后不随提交自动触发评估，
 *   手动重跑仍可用；恢复时立即对最新 HEAD 评估一次。
 *
 * 评估（gate_evaluations，唯一事件编号 GATE-XXXX-NNNNNN）：
 *   - 触发点：项目产生新版本（编辑/合并/导入/回滚/质检修复，经提交钩子）、
 *     提交发布申请（按申请绑定的具体版本，钉版评估），以及页面手动重跑。
 *   - 异步执行：入队后由定时器驱动；并发新提交时同一订阅的 HEAD 评估
 *     串行折叠（每订阅至多一个 commit 事件在调度），worker 执行前总是重新
 *     读取最新 HEAD——绝不基于过期 HEAD 出结果；重复触发/重复重跑命中
 *     进行中事件即复用，不产生重复结果/通知。
 *   - 逐项证据：相对基线的差异按稳定身份（cueId + 差异类型，跨轨移动带双轨
 *     身份）与该订阅上一完成事件对比，标记 new(新增)/worsened(恶化)/
 *     recovered(恢复)/persisting(仍存在)；另记录相对基线新出现、当前仍未
 *     处理的关注级质检问题。
 *   - 门禁：存在新增/恶化的关注差异，或新出现且未处理的关注级质检问题即命中。
 *   - 失败可重试（retry 复用同一事件行，attempts 递增，保留失败原因）；
 *     手动「重跑」对已结束事件生成新事件编号、保留完整历史；与上一事件
 *     结果完全相同时折叠通知（deduplicated / notif skipped），不重复打扰。
 *
 * 豁免（gate_exemptions）：
 *   门禁命中后，服务端阻止基于该版本提交发布申请或生成发布快照；
 *   只有审核人针对「本次事件 + 该版本」创建具名豁免（必填理由）才可放行。
 *   豁免严格绑定事件与版本——新版本产生新的评估事件后必须重新豁免，
 *   不能沿用旧豁免绕过新版本的重新评估。
 *
 * 全部状态流转（订阅增改/暂停/恢复、评估排队/开始/完成/失败/重试、门禁拦截、
 * 豁免创建/撤销、通知送达）写入项目审计。
 */
const crypto = require('crypto');
const { db } = require('../db');
const store = require('../store');
const { computeDiff } = require('../report/match');

const now = () => Date.now();
const subid = () => 'gs_' + crypto.randomBytes(9).toString('hex');
const evid = () => 'ge_' + crypto.randomBytes(9).toString('hex');
const exid = () => 'gx_' + crypto.randomBytes(9).toString('hex');
const httpError = store.httpError;

const DIFF_TYPES = ['added', 'deleted', 'track', 'time', 'text', 'lock'];
const SEVERITIES = ['blocker', 'warning'];
const STATUSES = ['queued', 'running', 'done', 'failed'];
const TRIGGERS = ['commit', 'qc', 'release-request', 'manual'];

/* ================================ 参数规范化 ================================ */

function strArr(raw, allowed) {
  if (raw == null || raw === '') return [];
  let arr = raw;
  if (typeof arr === 'string') arr = arr.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(arr)) throw httpError(400, '参数应为数组');
  const out = [];
  for (const x of arr) {
    const v = String(x);
    if (allowed && !allowed.includes(v)) throw httpError(400, `非法取值：${v}`);
    out.push(v);
  }
  if (out.length > 500) throw httpError(400, '参数过多');
  return [...new Set(out)].sort();
}

function normalizeConfig(raw = {}) {
  return {
    trackIds: strArr(raw.trackIds, null), // 项目相关校验在调用处做
    diffTypes: strArr(raw.diffTypes, DIFF_TYPES),
    keyword: String(raw.keyword || '').trim().slice(0, 200),
    qcSeverities: strArr(raw.qcSeverities, SEVERITIES).length
      ? strArr(raw.qcSeverities, SEVERITIES)
      : ['blocker'], // 默认只盯阻断级
  };
}

function configHash(cfg) {
  return crypto.createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 14);
}

/** 校验轨道 id 均属于项目（允许空数组=全部轨道）。 */
function checkTracks(trackIds, snap) {
  if (!trackIds.length) return;
  const ids = new Set((snap.tracks || []).map((t) => t.id));
  for (const t of trackIds) if (!ids.has(t)) throw httpError(400, `关注轨道不存在：${t}`);
}

/* ================================ 基线解析 ================================ */

/**
 * 解析基线：revision 直接取版本快照；release 取发布时冻结的快照。
 * 订阅行会再冻结一份基线内容，因而发布撤销后基线仍可用于评估。
 */
function resolveBaseline(projectId, kind, ref) {
  if (kind === 'revision') {
    const rev = store.getRevision(ref);
    if (!rev || rev.project_id !== projectId) throw httpError(400, '基线版本无效');
    return {
      kind, ref, revId: rev.id,
      label: `版本 ${rev.id.slice(0, 10)}（${(rev.message || rev.kind).slice(0, 30)}）`,
      snapshot: rev.snapshot,
    };
  }
  if (kind === 'release') {
    const qc = require('../qc/store'); // 延迟 require 规避循环依赖
    const rel = qc.getRelease(ref);
    if (!rel || rel.project_id !== projectId) throw httpError(400, '基线发布快照无效');
    return { kind, ref, revId: rel.revision_id, label: `${rel.label}（发布快照）`, snapshot: rel.snapshot };
  }
  throw httpError(400, '基线类型应为 revision 或 release');
}

/* ================================ 订阅 ================================ */

function parseSub(row) {
  if (!row) return null;
  return {
    ...row,
    track_ids: JSON.parse(row.track_ids),
    diff_types: JSON.parse(row.diff_types),
    qc_severities: JSON.parse(row.qc_severities),
  };
}
function getSub(subId) {
  return parseSub(db.prepare('SELECT * FROM gate_subscriptions WHERE id = ?').get(subId));
}
function listSubscriptions(projectId) {
  return db.prepare('SELECT * FROM gate_subscriptions WHERE project_id = ? ORDER BY created_at DESC, id DESC')
    .all(projectId).map(parseSub);
}
function subConfig(s) {
  return { trackIds: s.track_ids, diffTypes: s.diff_types, keyword: s.keyword, qcSeverities: s.qc_severities };
}

function createSubscription(projectId, body, author) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const name = String(body.name || '').trim().slice(0, 80) || '未命名门禁订阅';
  const baselineKind = String(body.baselineKind || '');
  const baselineRef = String(body.baselineRef || '');
  if (!baselineRef) throw httpError(400, '缺少基线（baselineRef）');
  const baseline = resolveBaseline(projectId, baselineKind, baselineRef);

  const cfg = normalizeConfig(body);
  const head = store.getRevision(project.head_id);
  checkTracks(cfg.trackIds, head ? head.snapshot : baseline.snapshot);
  const hash = configHash({ baseline: [baseline.kind, baseline.ref], ...cfg });

  const id = subid();
  const t = now();
  db.prepare(
    `INSERT INTO gate_subscriptions
       (id, project_id, name, baseline_kind, baseline_ref, baseline_label, baseline_rev_id, baseline_snapshot,
        track_ids, diff_types, keyword, qc_severities, status, config_hash, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
  ).run(
    id, projectId, name, baseline.kind, baseline.ref, baseline.label, baseline.revId,
    JSON.stringify(baseline.snapshot), JSON.stringify(cfg.trackIds), JSON.stringify(cfg.diffTypes),
    cfg.keyword, JSON.stringify(cfg.qcSeverities),
    hash, author, t, t,
  );

  store.writeAudit(projectId, project.head_id, [
    {
      field: `gatesub:${id}`, action: 'gatesub-create', oldValue: null,
      newValue: JSON.stringify({
        name, baseline: baseline.label, tracks: cfg.trackIds, types: cfg.diffTypes,
        keyword: cfg.keyword, severities: cfg.qcSeverities,
      }),
    },
  ], author);

  const sub = getSub(id);
  // 创建后立即对当前 HEAD 做一次评估（若项目已有提交）
  if (project.head_id) enqueue({ projectId, sub, revisionId: project.head_id, trigger: 'manual', author });
  return { subscription: sub };
}

function updateSubscription(projectId, subId, body, author) {
  const s = mustOwnSub(projectId, subId);
  const name = body.name == null ? s.name : (String(body.name || '').trim().slice(0, 80) || s.name);

  let baseline = {
    kind: s.baseline_kind, ref: s.baseline_ref, revId: s.baseline_rev_id,
    label: s.baseline_label, snapshot: JSON.parse(s.baseline_snapshot),
  };
  if (body.baselineRef != null) {
    baseline = resolveBaseline(projectId, String(body.baselineKind || s.baseline_kind), String(body.baselineRef));
  }
  const cfg = normalizeConfig({
    trackIds: body.trackIds ?? s.track_ids,
    diffTypes: body.diffTypes ?? s.diff_types,
    keyword: body.keyword ?? s.keyword,
    qcSeverities: body.qcSeverities ?? s.qc_severities,
  });
  const project = store.getProject(projectId);
  const head = store.getRevision(project.head_id);
  checkTracks(cfg.trackIds, head ? head.snapshot : baseline.snapshot);
  const hash = configHash({ baseline: [baseline.kind, baseline.ref], ...cfg });
  const t = now();

  const old = {
    name: s.name, baseline: s.baseline_label, tracks: s.track_ids, types: s.diff_types,
    keyword: s.keyword, severities: s.qc_severities,
  };
  db.prepare(
    `UPDATE gate_subscriptions SET name=?, baseline_kind=?, baseline_ref=?, baseline_label=?, baseline_rev_id=?,
       baseline_snapshot=?, track_ids=?, diff_types=?, keyword=?, qc_severities=?, config_hash=?, updated_by=?, updated_at=?
     WHERE id=?`,
  ).run(name, baseline.kind, baseline.ref, baseline.label, baseline.revId, JSON.stringify(baseline.snapshot),
    JSON.stringify(cfg.trackIds), JSON.stringify(cfg.diffTypes), cfg.keyword, JSON.stringify(cfg.qcSeverities),
    hash, author, t, subId);
  store.writeAudit(projectId, project.head_id, [
    {
      field: `gatesub:${subId}`, action: 'gatesub-update',
      oldValue: JSON.stringify(old),
      newValue: JSON.stringify({
        name, baseline: baseline.label, tracks: cfg.trackIds, types: cfg.diffTypes,
        keyword: cfg.keyword, severities: cfg.qcSeverities,
      }),
    },
  ], author);
  // 条件修改后对当前 HEAD 重新评估一次
  const fresh = getSub(subId);
  if (project.head_id) enqueue({ projectId, sub: fresh, revisionId: project.head_id, trigger: 'manual', author });
  return { subscription: fresh };
}

function setPaused(projectId, subId, paused, author) {
  const s = mustOwnSub(projectId, subId);
  const next = paused ? 'paused' : 'active';
  if (s.status === next) return { subscription: s };
  const t = now();
  if (paused) {
    db.prepare(`UPDATE gate_subscriptions SET status='paused', paused_by=?, paused_at=?, updated_by=?, updated_at=? WHERE id=?`)
      .run(author, t, author, t, subId);
  } else {
    db.prepare(`UPDATE gate_subscriptions SET status='active', resumed_at=?, updated_by=?, updated_at=? WHERE id=?`)
      .run(t, author, t, subId);
  }
  const project = store.getProject(projectId);
  store.writeAudit(projectId, project.head_id, [
    { field: `gatesub:${subId}`, action: paused ? 'gatesub-pause' : 'gatesub-resume', oldValue: s.status, newValue: next },
  ], author);
  // 恢复时立即对最新 HEAD 评估一次（暂停期间的提交钩子均被跳过）
  const fresh = getSub(subId);
  if (!paused && project.head_id) {
    enqueue({ projectId, sub: fresh, revisionId: project.head_id, trigger: 'manual', author });
  }
  return { subscription: fresh };
}

function mustOwnSub(projectId, subId) {
  const s = getSub(subId);
  if (!s || s.project_id !== projectId) throw httpError(404, '门禁订阅不存在');
  return s;
}

/* ================================ 事件编号 ================================ */

const nextEventNo = db.transaction((projectId) => {
  db.prepare('INSERT INTO gate_counters (project_id, seq) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET seq = seq + 1')
    .run(projectId);
  const seq = db.prepare('SELECT seq FROM gate_counters WHERE project_id = ?').get(projectId).seq;
  const p = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId).id.slice(2, 6).toUpperCase();
  return `GATE-${p}-${String(seq).padStart(6, '0')}`;
});

/* ================================ 评估入队（去重/合并） ================================ */

// 每订阅的提交折叠标记：并发新提交在同一 tick 内只调度一次 HEAD 评估。
// worker 执行前会再读一次最新 HEAD，因此即使标记已清、事件在跑，后续提交也会
// 被下面的「进行中 commit 事件合并」兜住，始终只保留一个事件，且结果基于最新 HEAD。
const commitScheduled = new Set();

/**
 * 入队一次评估。
 * - commit（HEAD 评估）：同订阅已有进行中事件即合并复用；多个并发提交折叠为一次调度。
 * - release-request（钉版评估）/ manual（手动）：按 (订阅,版本,触发来源) 去重。
 */
function enqueue({ projectId, sub, revisionId, trigger, author }) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');

  const inflight = db
    .prepare(`SELECT * FROM gate_evaluations WHERE subscription_id=? AND status IN ('queued','running') ORDER BY created_at`)
    .all(sub.id);
  for (const row of inflight) {
    // 同类触发（commit 间、qc 间）合并；不同触发来源只在同版本同来源时复用
    const sameKind =
      (row.trigger === 'commit' && trigger === 'commit') ||
      (row.trigger === 'qc' && trigger === 'qc');
    if (sameKind) return { evaluation: parseEval(row), deduplicated: true };
    if (row.target_revision_id === revisionId && row.trigger === trigger) {
      return { evaluation: parseEval(row), deduplicated: true };
    }
  }

  if (trigger === 'commit') {
    // 同 tick 并发提交折叠：只保留一次调度
    if (commitScheduled.has(sub.id)) return { evaluation: null, deduplicated: true, coalesced: true };
    commitScheduled.add(sub.id);
    const enqAt = now();
    setImmediate(() => {
      commitScheduled.delete(sub.id);
      try {
        createEvent({ projectId, subId: sub.id, revisionId, trigger, author, enqAt });
      } catch (e) {
        // 调度失败不能影响主提交流程，落审计便于排查
        store.writeAudit(projectId, revisionId, [
          { field: `gatesub:${sub.id}`, action: 'gateeval-fail', oldValue: null, newValue: '入队失败：' + String(e.message || e) },
        ], '系统');
      }
    });
    return { evaluation: null, scheduled: true };
  }
  return createEvent({ projectId, subId: sub.id, revisionId, trigger, author, enqAt: now() });
}

function createEvent({ projectId, subId, revisionId, trigger, author, enqAt }) {
  const project = store.getProject(projectId);
  const sub = getSub(subId);
  if (!sub) return { evaluation: null, skipped: true };
  // 调度瞬间订阅已暂停：提交类自动评估跳过（手动/钉版仍执行）
  if (trigger === 'commit' && sub.status === 'paused') return { evaluation: null, skipped: true };
  // 质检完成触发的补评估同样尊重暂停状态
  if (trigger === 'qc' && sub.status === 'paused') return { evaluation: null, skipped: true };
  // commit 事件在调度时重定向到最新 HEAD：并发新提交始终以最新 HEAD 重算
  const target = trigger === 'commit' ? (project.head_id || revisionId) : revisionId;

  const id = evid();
  const eventNo = nextEventNo(projectId);
  const cfg = subConfig(sub);
  db.prepare(
    `INSERT INTO gate_evaluations
       (id, event_no, project_id, subscription_id, target_revision_id, trigger, triggered_by, status,
        config_snapshot, config_hash, baseline_kind, baseline_ref, baseline_label, baseline_rev_id,
        baseline_snapshot, attempts, head_at_start, created_at)
     VALUES (?,?,?,?,?,?,?, 'queued', ?,?,?,?,?,?,?, 0, ?,?)`,
  ).run(id, eventNo, projectId, subId, target, trigger, author,
    JSON.stringify(cfg), sub.config_hash, sub.baseline_kind, sub.baseline_ref, sub.baseline_label,
    sub.baseline_rev_id, sub.baseline_snapshot, project.head_id, enqAt || now());
  store.writeAudit(projectId, target, [
    { field: `gateeval:${id}`, action: 'gateeval-queue', oldValue: null, newValue: JSON.stringify({ eventNo, trigger, revision: target }) },
  ], author);
  const timer = setTimeout(() => runEvaluation(id), 5);
  timer.unref?.();
  return { evaluation: getEval(id), deduplicated: false };
}

/**
 * 页面手动重跑：已结束事件 → 新事件（新编号）；进行中 → 幂等复用。
 * commit 类事件重跑始终对最新 HEAD；钉版事件（qc / release-request）重跑原版本。
 */
function rerun(projectId, evalId, author) {
  const row = mustOwnEval(projectId, evalId);
  const sub = getSub(row.subscription_id);
  const target = row.trigger === 'commit' ? store.getProject(projectId).head_id : row.target_revision_id;
  const inflight = db
    .prepare(`SELECT * FROM gate_evaluations WHERE subscription_id=? AND target_revision_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`)
    .get(sub.id, target);
  if (inflight) return { evaluation: parseEval(inflight), deduplicated: true };
  return enqueue({ projectId, sub, revisionId: target, trigger: 'manual', author });
}

/** 失败重试：复用同一事件行，attempts+1，保留历史失败原因。 */
function retry(projectId, evalId, author) {
  const row = mustOwnEval(projectId, evalId);
  if (row.status !== 'failed') throw httpError(400, '只有失败的评估可以重试');
  db.prepare(`UPDATE gate_evaluations SET status='queued', attempts=attempts+1, error=NULL, started_at=NULL, finished_at=NULL WHERE id=?`).run(evalId);
  store.writeAudit(projectId, row.target_revision_id, [
    { field: `gateeval:${evalId}`, action: 'gateeval-retry', oldValue: 'failed', newValue: 'queued' },
  ], author);
  const timer = setTimeout(() => runEvaluation(evalId), 5);
  timer.unref?.();
  return { evaluation: getEval(evalId) };
}

/* ================================ 差异趋势判定 ================================ */

/**
 * 差异项稳定身份：cueId + 差异类型；跨轨移动额外带双轨，
 * 使同一句从 A→B 与 A→C 被视为不同的差异项。
 */
function diffItemKey(it) {
  const cue = it.cueIdTo || it.cueIdFrom;
  if (it.type === 'track') return `${cue}:track:${it.trackIdFrom || ''}>${it.trackIdTo || ''}`;
  return `${cue}:${it.type}`;
}

/** 差异严重程度：用于「恶化」判定（值越大越差，区间约 1~3）。 */
function diffSeverity(it) {
  if (it.type === 'added' || it.type === 'deleted') return 3;
  if (it.type === 'track') return 2;
  if (it.type === 'time') {
    const dStart = Math.abs((it.newValue?.start ?? 0) - (it.oldValue?.start ?? 0));
    const dEnd = Math.abs((it.newValue?.end ?? 0) - (it.oldValue?.end ?? 0));
    return 1 + Math.min(2, Math.max(dStart, dEnd) / 5000);
  }
  if (it.type === 'text') {
    const a = String(it.oldValue || ''), b = String(it.newValue || '');
    return 1 + Math.min(2, Math.abs(a.length - b.length) / 40 + (a.trim() !== b.trim() ? 0.5 : 0));
  }
  return 1; // lock
}

/** 应用订阅关注条件（轨道/类型/关键词）。 */
function matchConfig(item, cfg) {
  if (cfg.diffTypes.length && !cfg.diffTypes.includes(item.type)) return false;
  if (cfg.trackIds.length) {
    const inTracks = cfg.trackIds.includes(item.trackId) ||
      (item.trackIdFrom && cfg.trackIds.includes(item.trackIdFrom)) ||
      (item.trackIdTo && cfg.trackIds.includes(item.trackIdTo));
    if (!inTracks) return false;
  }
  if (cfg.keyword) {
    const kw = cfg.keyword.toLowerCase();
    const hay = [item.cueIdFrom, item.cueIdTo, item.trackName,
      typeof item.oldValue === 'object' ? item.oldValue?.text : item.oldValue,
      typeof item.newValue === 'object' ? item.newValue?.text : item.newValue]
      .filter((x) => x != null).join('\n').toLowerCase();
    if (!hay.includes(kw)) return false;
  }
  return true;
}

/**
 * 取趋势对比的基线事件差异项：
 * 同一目标版本上的重复评估（commit/qc 补评/手动重跑）必须产出完全一致的趋势，
 * 因而只参考「其他版本」上时间最近的一次完成事件——趋势衡量的是版本间变化，
 * 重跑不改变趋势，也保证同版本各事件结果指纹一致（豁免可共享、通知不重复）。
 */
function previousItems(subId, createdAt, excludeId, targetRevId) {
  const row = db
    .prepare(`SELECT items FROM gate_evaluations
              WHERE subscription_id=? AND status='done' AND created_at<=? AND id<>?
                AND (target_revision_id IS NULL OR target_revision_id<>?)
              ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(subId, createdAt, excludeId, targetRevId);
  const m = new Map();
  if (row) {
    for (const it of JSON.parse(row.items || '[]')) {
      if (it.kind === 'diff' && it.trend !== 'recovered') m.set(it.key, it);
    }
  }
  return m;
}

/**
 * 相对基线新出现的关注级质检问题（cueId+ruleKey 对不上基线版本最近完成质检）。
 * 门禁只计当前仍未处理者：fixed 不算；已忽略但基于旧版本（已过期）仍算未处理。
 */
function newQcFindings(projectId, baselineSnap, baselineRevId, targetRev, cfg) {
  const baselineJob = latestDoneJobFor(projectId, baselineSnap, baselineRevId);
  const targetJob = db
    .prepare(`SELECT * FROM qc_jobs WHERE project_id=? AND revision_id=? AND status='done' ORDER BY finished_at DESC, id DESC LIMIT 1`)
    .get(projectId, targetRev.id);
  if (!targetJob) return { items: [], targetJob: null, baselineJob: baselineJob?.id || null };

  const baseRows = baselineJob ? db.prepare('SELECT * FROM qc_findings WHERE job_id=?').all(baselineJob.id) : [];
  const baseKeys = new Set(baseRows.map((f) => `${f.cue_id}|${f.rule_key}`));
  const out = [];
  for (const f of db.prepare('SELECT * FROM qc_findings WHERE job_id=?').all(targetJob.id)) {
    if (!cfg.qcSeverities.includes(f.severity)) continue;
    if (baseKeys.has(`${f.cue_id}|${f.rule_key}`)) continue;
    // 门禁只计「当前仍未处理」：已修复不算；基于目标版本（当前 HEAD）的忽略决定算已处理，
    // 但基于旧版本的忽略（已过期）仍算未处理
    if (f.status === 'fixed') continue;
    if (f.status === 'ignored' && f.decided_on_rev === targetRev.id) continue;
    if (cfg.trackIds.length && !cfg.trackIds.includes(f.track_id)) continue;
    if (cfg.keyword && ![f.evidence, f.cue_id].join('\n').toLowerCase().includes(cfg.keyword.toLowerCase())) continue;
    out.push({
      key: `qc:${f.cue_id}:${f.rule_key}`,
      kind: 'qc',
      trend: 'new',
      cueId: f.cue_id,
      trackId: f.track_id,
      ruleKey: f.rule_key,
      severityQc: f.severity,
      status: f.status,
      evidence: f.evidence,
      actual: JSON.parse(f.actual),
      findingId: f.id,
      jobId: targetJob.id,
    });
  }
  return { items: out, targetJob: targetJob.id, baselineJob: baselineJob?.id || null };
}

/**
 * 找与基线内容一致的最近完成质检任务；找不到（基线从没跑过质检等）则视为
 * 基线无质检——目标版本上所有关注级问题都算「新出现」。
 */
function latestDoneJobFor(projectId, baselineSnap, baselineRevId) {
  // 优先：基线来源版本本身的最近完成质检
  const direct = db
    .prepare(`SELECT * FROM qc_jobs WHERE project_id=? AND revision_id=? AND status='done' ORDER BY finished_at DESC, id DESC LIMIT 1`)
    .get(projectId, baselineRevId);
  if (direct) return direct;
  // 基线没有直接质检（如基线是发布快照或旧版本）：找内容一致的最近完成质检
  const baselineCues = JSON.stringify(baselineSnap.cues);
  const rows = db.prepare(
    `SELECT j.* FROM qc_jobs j JOIN revisions r ON r.id=j.revision_id
     WHERE j.project_id=? AND j.status='done' ORDER BY j.finished_at DESC`,
  ).all(projectId);
  for (const j of rows) {
    const rev = store.getRevision(j.revision_id);
    if (rev && JSON.stringify(rev.snapshot.cues) === baselineCues) return j;
  }
  return null;
}

function diffEvidence(it) {
  const cue = it.cueIdTo || it.cueIdFrom || '';
  const label = { added: '新增句', deleted: '删除句', track: '跨轨移动', time: '时间修改', text: '文本修改', lock: '锁定状态变化' }[it.type] || it.type;
  return `${label} · 句子 ${cue} · 轨道 ${it.trackName || it.trackId}`;
}

function computeEvaluation(evRow) {
  const projectId = evRow.project_id;
  // commit 事件执行时总是重新读取最新 HEAD——并发新提交以最新 HEAD 重算
  let targetRevId = evRow.target_revision_id;
  if (evRow.trigger === 'commit') targetRevId = store.getProject(projectId).head_id || targetRevId;
  const targetRev = store.getRevision(targetRevId);
  if (!targetRev || targetRev.project_id !== projectId) throw new Error('目标版本不存在或已不属于本项目');

  const cfg = JSON.parse(evRow.config_snapshot);
  const baselineSnap = JSON.parse(evRow.baseline_snapshot);

  const { items: diffRaw } = computeDiff(baselineSnap, targetRev.snapshot);
  const watched = diffRaw.filter((it) => it.type !== 'unchanged' && matchConfig(it, cfg));
  const prevMap = previousItems(evRow.subscription_id, evRow.created_at, evRow.id, targetRevId);
  const currentKeys = new Set(watched.map(diffItemKey));

  const items = [];
  for (const it of watched) {
    const key = diffItemKey(it);
    const prev = prevMap.get(key);
    const severity = diffSeverity(it);
    const trend = prev ? (severity > prev.severity + 0.01 ? 'worsened' : 'persisting') : 'new';
    items.push({
      key, kind: 'diff', trend, type: it.type,
      cueIdFrom: it.cueIdFrom, cueIdTo: it.cueIdTo,
      trackId: it.trackId, trackIdFrom: it.trackIdFrom, trackIdTo: it.trackIdTo, trackName: it.trackName,
      oldValue: it.oldValue, newValue: it.newValue, matchedBy: it.matchedBy, similarity: it.similarity,
      start: it.start, severity, prevSeverity: prev ? prev.severity : null, evidence: diffEvidence(it),
    });
  }
  for (const [key, prev] of prevMap) {
    if (currentKeys.has(key)) continue;
    items.push({
      ...prev, trend: 'recovered',
      evidence: `已恢复：相对基线的差异在目标版本中消失（${prev.evidence || key}）`,
    });
  }

  const qc = newQcFindings(projectId, baselineSnap, evRow.baseline_rev_id, targetRev, cfg);
  items.push(...qc.items);

  const trendOrder = { new: 0, worsened: 1, persisting: 2, recovered: 3 };
  items.sort((a, b) =>
    (trendOrder[a.trend] ?? 9) - (trendOrder[b.trend] ?? 9) ||
    (a.kind || '').localeCompare(b.kind || '') ||
    (a.start || 0) - (b.start || 0) ||
    (a.key < b.key ? -1 : 1),
  );

  const counts = { new: 0, worsened: 0, recovered: 0, persisting: 0, qcNew: 0 };
  for (const it of items) {
    if (it.kind === 'qc') { counts.qcNew++; continue; }
    counts[it.trend] = (counts[it.trend] || 0) + 1;
  }
  // 门禁：相对基线仍存在的关注差异（新增/恶化/持续，恢复项不算），
  // 或新出现且未处理的关注级质检问题。持续项（早前新增、本版本仍在）同样拦截——
  // 豁免只绑定具体事件+版本，不能靠「多等一个版本」绕过回归门禁。
  const gateHit = items.some((it) =>
    (it.kind === 'diff' && it.trend !== 'recovered') || it.kind === 'qc');

  // 结果指纹：同订阅同版本同配置重算得到相同结果时用于折叠重复通知/共享豁免。
  // 质检项用稳定的 cue+rule 身份（不含每次质检新建的 finding id）。
  const fpItems = items.map((it) => it.kind === 'qc'
    ? `qc:${it.key}:${it.trend}:${it.status}`
    : `${it.key}:${it.trend}:${JSON.stringify(it.newValue)}`);
  const resultHash = crypto.createHash('sha1').update(JSON.stringify({ c: cfg, fpItems })).digest('hex').slice(0, 14);

  return {
    targetRev,
    items,
    resultHash,
    summary: { counts, gateHit, qc: { targetJob: qc.targetJob, baselineJob: qc.baselineJob } },
  };
}

/* ================================ worker ================================ */

function runEvaluation(evalId) {
  const row = db.prepare('SELECT * FROM gate_evaluations WHERE id = ?').get(evalId);
  if (!row || !['queued', 'running'].includes(row.status)) return;
  const t = now();
  db.prepare(`UPDATE gate_evaluations SET status='running', started_at=?, attempts=attempts+1 WHERE id=?`).run(t, evalId);
  store.writeAudit(row.project_id, row.target_revision_id, [
    { field: `gateeval:${evalId}`, action: 'gateeval-start', oldValue: null, newValue: row.event_no },
  ], row.triggered_by || '系统');
  try {
    finishEvaluation(row, computeEvaluation(row));
  } catch (e) {
    failEvaluation(row, e);
  }
}

function finishEvaluation(row, result) {
  const t = now();
  const actualTarget = result.targetRev.id;

  // 与上一同版本完成事件结果完全相同：不重复通知（结果仍保留为独立历史事件）
  const prevSame = db
    .prepare(`SELECT id FROM gate_evaluations
              WHERE subscription_id=? AND target_revision_id=? AND status='done' AND result_hash=? AND id<>?
              ORDER BY finished_at DESC LIMIT 1`)
    .get(row.subscription_id, actualTarget, result.resultHash, row.id);

  const txn = db.transaction(() => {
    const cur = db.prepare(`SELECT status FROM gate_evaluations WHERE id=?`).get(row.id);
    if (!cur || !['queued', 'running'].includes(cur.status)) return false;
    db.prepare(
      `UPDATE gate_evaluations SET status='done', items=?, summary=?, result_hash=?, gate_hit=?,
         target_revision_id=?, finished_at=?, error=NULL, deduplicated=?, notif_status=? WHERE id=?`,
    ).run(JSON.stringify(result.items), JSON.stringify(result.summary), result.resultHash,
      result.summary.gateHit ? 1 : 0, actualTarget, t,
      prevSame ? 1 : 0,
      result.summary.gateHit ? (prevSame ? 'skipped' : 'sent') : 'none',
      row.id);
    return true;
  });
  if (!txn()) return;

  store.writeAudit(row.project_id, actualTarget, [
    {
      field: `gateeval:${row.id}`, action: 'gateeval-done', oldValue: null,
      newValue: JSON.stringify({ eventNo: row.event_no, ...result.summary.counts, gateHit: result.summary.gateHit, duplicate: !!prevSame }),
    },
  ], row.triggered_by || '系统');

  if (result.summary.gateHit && !prevSame) {
    store.writeAudit(row.project_id, actualTarget, [
      {
        field: `gateeval:${row.id}`, action: 'gatenotify', oldValue: null,
        newValue: JSON.stringify({ eventNo: row.event_no, subscription: getSub(row.subscription_id)?.name, counts: result.summary.counts }),
      },
    ], '系统');
  }
}

function failEvaluation(row, err) {
  const reason = String(err && err.message || err).slice(0, 2000);
  db.prepare(`UPDATE gate_evaluations SET status='failed', error=?, finished_at=? WHERE id=?`)
    .run(reason, now(), row.id);
  store.writeAudit(row.project_id, row.target_revision_id, [
    { field: `gateeval:${row.id}`, action: 'gateeval-fail', oldValue: null, newValue: reason },
  ], row.triggered_by || '系统');
}

/* ================================ 读取 / 筛选 ================================ */

function parseEval(row) {
  if (!row) return null;
  return {
    ...row,
    config_snapshot: JSON.parse(row.config_snapshot),
    items: row.items ? JSON.parse(row.items) : null,
    summary: row.summary ? JSON.parse(row.summary) : null,
    gate_hit: !!row.gate_hit,
    deduplicated: !!row.deduplicated,
  };
}
function getEval(evalId) {
  return parseEval(db.prepare('SELECT * FROM gate_evaluations WHERE id = ?').get(evalId));
}
function mustOwnEval(projectId, evalId) {
  const row = db.prepare('SELECT * FROM gate_evaluations WHERE id = ?').get(evalId);
  if (!row || row.project_id !== projectId) throw httpError(404, '门禁评估事件不存在');
  return row;
}

/**
 * 评估列表。filters: { subscriptionId, status, gateHit, trend, trigger, revisionId }。
 * 列表不带 items/冻结快照（大字段），详情接口才返回逐项证据。
 */
function listEvaluations(projectId, filters = {}) {
  let sql = 'SELECT * FROM gate_evaluations WHERE project_id = ?';
  const args = [projectId];
  if (filters.subscriptionId) { sql += ' AND subscription_id = ?'; args.push(String(filters.subscriptionId)); }
  if (filters.status) {
    const arr = String(filters.status).split(',').filter(Boolean);
    for (const s of arr) if (!STATUSES.includes(s)) throw httpError(400, `非法状态：${s}`);
    sql += ` AND status IN (${arr.map(() => '?').join(',')})`; args.push(...arr);
  }
  if (filters.gateHit === 'true' || filters.gateHit === '1') sql += ' AND gate_hit = 1';
  if (filters.gateHit === 'false' || filters.gateHit === '0') sql += ' AND gate_hit = 0';
  if (filters.trigger) {
    if (!TRIGGERS.includes(String(filters.trigger))) throw httpError(400, `非法触发来源：${filters.trigger}`);
    sql += ' AND trigger = ?'; args.push(String(filters.trigger));
  }
  if (filters.revisionId) { sql += ' AND target_revision_id = ?'; args.push(String(filters.revisionId)); }
  sql += ' ORDER BY created_at DESC, id DESC';
  const trend = filters.trend ? String(filters.trend) : '';
  if (trend && !['new', 'worsened', 'recovered', 'persisting'].includes(trend)) throw httpError(400, 'trend 参数非法');

  const out = [];
  for (const r of db.prepare(sql).all(...args).map(parseEval)) {
    if (trend) {
      const full = getEval(r.id);
      if (!(full.items || []).some((it) => it.trend === trend)) continue;
    }
    const { items, config_snapshot, baseline_snapshot, ...rest } = r;
    out.push({ ...rest, itemCount: items ? items.length : null });
  }
  return out;
}

/** 详情：返回逐项证据，可叠加筛选（trend / kind / trackId / keyword）。 */
function getEvaluationDetail(projectId, evalId, q = {}) {
  const row = mustOwnEval(projectId, evalId);
  const ev = parseEval(row);
  const sub = getSub(ev.subscription_id);
  const exemption = activeExemptionFor(ev.id);
  let items = ev.items || [];
  const applied = {};

  if (q.trend) {
    const allowed = String(q.trend).split(',').filter(Boolean);
    for (const x of allowed) {
      if (!['new', 'worsened', 'recovered', 'persisting'].includes(x)) throw httpError(400, 'trend 参数非法');
    }
    items = items.filter((it) => allowed.includes(it.trend));
    applied.trend = allowed;
  }
  if (q.kind) {
    if (!['diff', 'qc'].includes(String(q.kind))) throw httpError(400, 'kind 应为 diff 或 qc');
    items = items.filter((it) => it.kind === q.kind);
    applied.kind = q.kind;
  }
  if (q.trackId) {
    items = items.filter((it) => it.trackId === q.trackId || it.trackIdFrom === q.trackId || it.trackIdTo === q.trackId);
    applied.trackId = String(q.trackId);
  }
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    items = items.filter((it) => JSON.stringify(it).toLowerCase().includes(kw));
    applied.keyword = String(q.keyword);
  }

  return {
    evaluation: { ...ev, items, filteredCount: items.length },
    subscription: { id: sub.id, name: sub.name, status: sub.status },
    exemption: exemption ? {
      id: exemption.id, name: exemption.name, reviewer: exemption.reviewer,
      reason: exemption.reason, created_at: exemption.created_at,
    } : null,
    appliedFilters: applied,
  };
}

/* ================================ 门禁校验（发布流程接入点） ================================ */

function activeExemptionFor(eventId) {
  return db.prepare('SELECT * FROM gate_exemptions WHERE event_id = ? AND revoked_at IS NULL').get(eventId);
}

/**
 * 门禁检查：某项目某版本当前是否被任一订阅门禁拦截。
 * 每个订阅只看该版本上最新一次「配置仍有效」的完成事件——最新事件未命中即放行
 * （例如阻断处理后补评估不再命中）；命中且无有效豁免才拦截。
 *
 * 返回 { blocked, blockers, unexempted }。
 */
function checkGate(projectId, revisionId) {
  // 每个订阅取该版本上「最新一次配置有效」的完成事件：若最新事件未命中，则视为已放行
  // （例如阻断经处理后重新质检，补评估不再命中）；命中且无豁免才拦截。
  const rows = db.prepare(
    `SELECT * FROM gate_evaluations
     WHERE project_id=? AND target_revision_id=? AND status='done'
     ORDER BY finished_at DESC, id DESC`,
  ).all(projectId, revisionId);
  const blockers = [];
  const seenSubs = new Set();
  for (const row of rows) {
    const sub = getSub(row.subscription_id);
    if (!sub || seenSubs.has(sub.id)) continue;
    seenSubs.add(sub.id);
    if (row.config_hash !== sub.config_hash) continue; // 条件已改：旧事件失效
    if (!row.gate_hit) continue; // 最新事件未命中 → 放行
    let evEx = activeExemptionFor(row.id);
    // 同一订阅+版本上结果指纹完全相同的重复事件（重跑/质检后补评）共享豁免：
    // 豁免仍严格绑定版本与命中结果，不会延伸到新版本或新结果
    if (!evEx && row.result_hash) {
      const dup = db.prepare(
        `SELECT e.* FROM gate_evaluations e
         JOIN gate_exemptions x ON x.event_id = e.id AND x.revoked_at IS NULL
         WHERE e.subscription_id=? AND e.target_revision_id=? AND e.result_hash=? AND e.id<>? LIMIT 1`,
      ).get(sub.id, revisionId, row.result_hash, row.id);
      if (dup) evEx = activeExemptionFor(dup.id);
    }
    blockers.push({
      eventId: row.id,
      eventNo: row.event_no,
      subscriptionId: sub.id,
      subscriptionName: sub.name,
      subscriptionStatus: sub.status,
      counts: JSON.parse(row.summary).counts,
      exemption: evEx ? {
        id: evEx.id, name: evEx.name, reviewer: evEx.reviewer, reason: evEx.reason, created_at: evEx.created_at,
      } : null,
    });
  }
  const unexempted = blockers.filter((b) => !b.exemption);
  return { blocked: unexempted.length > 0, blockers, unexempted };
}

/** 是否还有钉在该版本上未完成的评估（发布申请需等待评估完成后再据结果决定）。 */
function pendingForRevision(projectId, revisionId) {
  return db.prepare(
    `SELECT COUNT(*) AS c FROM gate_evaluations
     WHERE project_id=? AND target_revision_id=? AND status IN ('queued','running')`,
  ).get(projectId, revisionId).c;
}

/**
 * 确保某版本在所有「未暂停」订阅下都有配置最新的完成事件（供发布申请提交前调用）。
 * 已完成且配置最新则复用；进行中则等待；否则为每个订阅入队钉版事件。
 * 返回 { pending, subscriptionCount }。
 */
function ensureEvaluated(projectId, revisionId, author) {
  const subs = db.prepare(`SELECT * FROM gate_subscriptions WHERE project_id=? AND status='active'`).all(projectId).map(parseSub);
  let pending = false;
  for (const sub of subs) {
    const latest = db
      .prepare(`SELECT * FROM gate_evaluations WHERE subscription_id=? AND target_revision_id=? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(sub.id, revisionId);
    if (latest && ['queued', 'running'].includes(latest.status)) { pending = true; continue; }
    if (latest && latest.status === 'done' && latest.config_hash === sub.config_hash) continue;
    enqueue({ projectId, sub, revisionId, trigger: 'release-request', author });
    pending = true;
  }
  return { pending, subscriptionCount: subs.length };
}

/* ================================ 豁免 ================================ */

function parseEx(row) {
  if (!row) return null;
  return { ...row, item_keys: JSON.parse(row.item_keys || '[]') };
}

function createExemption(projectId, eventId, body, author) {
  const row = mustOwnEval(projectId, eventId);
  if (row.status !== 'done') throw httpError(400, '评估尚未完成，不能创建豁免');
  if (!row.gate_hit) throw httpError(400, '该事件未命中门禁，无需豁免');
  const existing = activeExemptionFor(eventId);
  if (existing) throw httpError(409, '该事件已存在有效豁免', { exemption: parseEx(existing) });

  const name = String(body.name || '').trim().slice(0, 80);
  const reason = String(body.reason || '').trim();
  if (!name) throw httpError(400, '豁免必须具名（name）');
  if (!reason) throw httpError(400, '豁免必须填写理由（reason）');

  const id = exid();
  const t = now();
  db.prepare(
    `INSERT INTO gate_exemptions (id, project_id, event_id, subscription_id, revision_id, name, reviewer, reason, scope, item_keys, created_at)
     VALUES (?,?,?,?,?,?,?,?,'all','[]',?)`,
  ).run(id, projectId, eventId, row.subscription_id, row.target_revision_id, name, author, reason, t);
  store.writeAudit(projectId, row.target_revision_id, [
    {
      field: `gateex:${id}`, action: 'gateex-create', oldValue: null,
      newValue: JSON.stringify({ eventNo: row.event_no, name, reviewer: author, reason, revision: row.target_revision_id }),
    },
  ], author);
  return { exemption: parseEx(db.prepare('SELECT * FROM gate_exemptions WHERE id=?').get(id)) };
}

function revokeExemption(projectId, exId, body, author) {
  const row = db.prepare('SELECT * FROM gate_exemptions WHERE id=?').get(exId);
  if (!row || row.project_id !== projectId) throw httpError(404, '豁免不存在');
  if (row.revoked_at) throw httpError(400, '豁免已撤销，不能重复撤销');
  const reason = String(body?.reason || '').trim();
  if (!reason) throw httpError(400, '撤销豁免必须填写理由');
  db.prepare(`UPDATE gate_exemptions SET revoked_by=?, revoked_at=?, revoke_reason=? WHERE id=?`)
    .run(author, now(), reason, exId);
  store.writeAudit(projectId, row.revision_id, [
    { field: `gateex:${exId}`, action: 'gateex-revoke', oldValue: row.name, newValue: reason },
  ], author);
  return { exemption: parseEx(db.prepare('SELECT * FROM gate_exemptions WHERE id=?').get(exId)) };
}

function listExemptions(projectId) {
  return db.prepare('SELECT * FROM gate_exemptions WHERE project_id=? ORDER BY created_at DESC, id DESC')
    .all(projectId).map(parseEx);
}
function getExemption(exId) {
  return parseEx(db.prepare('SELECT * FROM gate_exemptions WHERE id=?').get(exId));
}

/* ================================ 提交 / 质检钩子 ================================ */

/**
 * 质检任务完成 / 阻断级处理决定（忽略）变化后：对该版本在所有活跃订阅下
 * 重新评估一次（新出现的关注级问题需进入门禁；阻断处理后需重新放行判定）。
 * 结果指纹与上一同版本事件相同时标记 deduplicated/notif skipped，
 * 不产生重复结果判定与重复通知。
 */
require('../qc/store').onQcChange(({ projectId, revisionId }) => {
  const subs = db.prepare(`SELECT * FROM gate_subscriptions WHERE project_id=? AND status='active'`).all(projectId).map(parseSub);
  for (const sub of subs) {
    try {
      enqueue({ projectId, sub, revisionId, trigger: 'qc', author: '系统' });
    } catch (e) {
      store.writeAudit(projectId, revisionId, [
        { field: `gatesub:${sub.id}`, action: 'gateeval-fail', oldValue: null, newValue: '质检后入队失败：' + String(e.message || e) },
      ], '系统');
    }
  }
});

/**
 * 项目产生新版本（编辑/合并/导入/回滚/质检修复）后：
 * 为所有「未暂停」订阅各入队一次 HEAD 评估。并发提交在每订阅队列上折叠，
 * worker 执行前重读最新 HEAD，不产生重复事件/结果/通知。
 */
store.onCommit(({ projectId, revision }) => {
  const subs = db.prepare(`SELECT * FROM gate_subscriptions WHERE project_id=? AND status='active'`).all(projectId).map(parseSub);
  for (const sub of subs) {
    try {
      enqueue({ projectId, sub, revisionId: revision.id, trigger: 'commit', author: '系统' });
    } catch (e) {
      store.writeAudit(projectId, revision.id, [
        { field: `gatesub:${sub.id}`, action: 'gateeval-fail', oldValue: null, newValue: '入队失败：' + String(e.message || e) },
      ], '系统');
    }
  }
});

/* ---------- 启动恢复：进程重启后挂死的排队/运行事件重新调度或标失败可重试 ---------- */
(function recoverOnBoot() {
  const stuck = db.prepare(`SELECT * FROM gate_evaluations WHERE status IN ('queued','running')`).all();
  for (const row of stuck) {
    db.prepare(`UPDATE gate_evaluations SET status='failed', error=?, finished_at=? WHERE id=? AND status IN ('queued','running')`)
      .run('服务重启时任务中断，请重试', now(), row.id);
    if (row.status === 'running') {
      store.writeAudit(row.project_id, row.target_revision_id, [
        { field: `gateeval:${row.id}`, action: 'gateeval-fail', oldValue: 'running', newValue: '服务重启时任务中断，请重试' },
      ], '系统');
    }
  }
})();

module.exports = {
  DIFF_TYPES,
  normalizeConfig,
  createSubscription,
  updateSubscription,
  listSubscriptions,
  getSub,
  setPaused,
  enqueue,
  rerun,
  retry,
  listEvaluations,
  getEvaluationDetail,
  getEval,
  checkGate,
  pendingForRevision,
  ensureEvaluated,
  createExemption,
  revokeExemption,
  listExemptions,
  getExemption,
};
