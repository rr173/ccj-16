// 发布回归门禁与变更订阅 单元测试（进程内直接驱动数据层，异步事件等待落库）
// 说明：本文件含顶层 await，Node 将按 ES module 加载；故在动态 import 之前
// 先把 DATA_DIR 指到独立临时目录，确保不污染默认数据。
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-unit-'));
process.env.DATA_DIR = dir;

const store = (await import('../server/src/store.js')).default;
const { db } = await import('../server/src/db.js');
const qc = (await import('../server/src/qc/store.js')).default;
const gate = (await import('../server/src/gate/store.js')).default;

let passed = 0;
function ok(cond, name, extra) {
  assert(cond, name + (extra ? ' ' + JSON.stringify(extra) : ''));
  passed++;
  console.log('  ✓', name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDone(projectId, revisionId, { min = 1, timeout = 3000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const evs = gate.listEvaluations(projectId, { revisionId }).filter((e) => e.status === 'done');
    if (evs.length >= min) return evs;
    if (Date.now() - t0 > timeout) throw new Error('等待评估完成超时 ' + revisionId);
    await sleep(20);
  }
}
function waitFor(fn, { timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      try {
        const v = fn();
        if (v) return resolve(v);
      } catch (e) { return reject(e); }
      if (Date.now() - t0 > timeout) return reject(new Error('条件等待超时'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function snapOf(rev) { return JSON.parse(JSON.stringify(rev.snapshot)); }
function commit(pid, base, snapshot, author = 'alice', message = '提交') {
  const r = store.submitRevision(pid, { baseRevId: base, snapshot, author, message });
  if (r.status !== 'committed') throw new Error('提交失败：' + JSON.stringify(r).slice(0, 300));
  return r.revision;
}

/* ---------- 参数规范化 ---------- */
console.log('订阅条件规范化');
assert.throws(() => gate.normalizeConfig({ diffTypes: ['nope'] }), /非法取值/);
ok(true, '非法差异类型被拒绝');
assert.throws(() => gate.normalizeConfig({ qcSeverities: ['fatal'] }), /非法取值/);
ok(true, '非法质检级别被拒绝');
const c0 = gate.normalizeConfig({});
ok(JSON.stringify(c0.qcSeverities) === JSON.stringify(['blocker']) && c0.trackIds.length === 0, '默认关注阻断级、全部轨道/类型');
const c1 = gate.normalizeConfig({ trackIds: ['t1', 't1'], diffTypes: ['text', 'added', 'text'], qcSeverities: [] });
ok(JSON.stringify(c1.trackIds) === '["t1"]' && JSON.stringify(c1.diffTypes) === '["added","text"]', '数组去重排序');

/* ---------- 项目与基线 ---------- */
console.log('评估趋势：新增 / 持续 / 恶化 / 恢复');
const { project, revision: rev0 } = store.createProject('门禁单测', 'alice');
const pid = project.id;

const snap1 = snapOf(rev0);
snap1.tracks.push({ id: 't_other', name: '副轨', color: '#ff9a3c', mutexGroup: null });
snap1.cues = [
  { id: 'c1', trackId: 't_main', start: 1000, end: 3000, text: '第一句对白内容', locked: false },
  { id: 'c2', trackId: 't_main', start: 4000, end: 6000, text: '第二句对白内容', locked: false },
  { id: 'o1', trackId: 't_other', start: 1000, end: 3000, text: '副轨第一句', locked: false },
];
const rev1 = commit(pid, rev0.id, snap1, 'alice', '基线版本');

// 基线 = rev1，盯文本与新增
let r = gate.createSubscription(pid, {
  name: '文本门禁', baselineKind: 'revision', baselineRef: rev1.id,
  diffTypes: ['added', 'text'], qcSeverities: ['blocker'],
}, 'alice');
const sid = r.subscription.id;
const ev0 = await waitDone(pid, rev1.id);
ok(ev0.length === 1 && ev0[0].gate_hit === false, '创建后对基线本身评估：无差异不命中门禁');
ok(/^GATE-[A-F0-9]{4}-000001$/.test(ev0[0].event_no), '首个事件编号 GATE-xxxx-000001：' + ev0[0].event_no);

// rev2：新增 c3 → 新增差异命中
const snap2 = snapOf(rev1);
snap2.cues.push({ id: 'c3', trackId: 't_main', start: 8000, end: 9000, text: '第三句新内容', locked: false });
const rev2 = commit(pid, rev1.id, snap2, 'bob', '新增 c3');
await waitDone(pid, rev2.id);
const evs2 = gate.listEvaluations(pid, { revisionId: rev2.id });
ok(evs2.length === 1 && evs2[0].gate_hit === true && evs2[0].trigger === 'commit', '新增差异命中门禁（commit 触发）');
const d2 = gate.getEvaluationDetail(pid, evs2[0].id).evaluation;
const newItem = d2.items.find((i) => i.trend === 'new' && i.cueIdTo === 'c3');
ok(!!newItem && newItem.type === 'added' && newItem.evidence.includes('c3'), '逐项证据含新增 c3 与说明');

// rev3：c3 仍在、c1 改文本 → c3 持续 + c1 新增
const snap3 = snapOf(rev2);
snap3.cues.find((c) => c.id === 'c1').text = '第一句对白内容被改写';
const rev3 = commit(pid, rev2.id, snap3, 'carol', '改 c1');
await waitDone(pid, rev3.id);
const d3 = gate.getEvaluationDetail(pid, gate.listEvaluations(pid, { revisionId: rev3.id })[0].id).evaluation;
ok(d3.items.some((i) => i.key === 'c3:added' && i.trend === 'persisting'), 'c3 差异标记为持续（persisting）');
ok(d3.items.some((i) => i.key === 'c1:text' && i.trend === 'new'), 'c1 文本修改标记为新增');

// rev4：c3 删除（恢复），c1 继续加长（恶化）
const snap4 = snapOf(rev3);
snap4.cues = snap4.cues.filter((c) => c.id !== 'c3');
snap4.cues.find((c) => c.id === 'c1').text = '第一句对白内容被改写并且又追加了一大段新文字内容哦';
const rev4 = commit(pid, rev3.id, snap4, 'carol', '删 c3 加长 c1');
await waitDone(pid, rev4.id);
const d4 = gate.getEvaluationDetail(pid, gate.listEvaluations(pid, { revisionId: rev4.id })[0].id).evaluation;
ok(d4.items.some((i) => i.key === 'c3:added' && i.trend === 'recovered'), 'c3 差异标记为恢复（recovered）');
ok(d4.items.some((i) => i.key === 'c1:text' && i.trend === 'worsened'), 'c1 文本进一步变长标记为恶化（worsened）');
ok(d4.items.every((i) => i.kind === 'diff' ? ['new', 'worsened', 'recovered', 'persisting'].includes(i.trend) : true),
  '趋势取值合法');

/* ---------- 关键词 / 轨道条件 ---------- */
console.log('订阅关注条件');
const subKw = gate.createSubscription(pid, {
  name: '关键词门禁', baselineKind: 'revision', baselineRef: rev1.id,
  keyword: '不存在的关键词xyz',
}, 'alice').subscription;
await waitDone(pid, store.getProject(pid).head_id);
const kwEv = gate.listEvaluations(pid, { subscriptionId: subKw.id })[0];
ok(kwEv.gate_hit === false, '关键词不匹配时不命中门禁');
gate.createSubscription(pid, {
  name: '副轨门禁', baselineKind: 'revision', baselineRef: rev1.id, trackIds: ['t_other'],
}, 'alice');
assert.throws(() => gate.createSubscription(pid, {
  name: '坏轨道', baselineKind: 'revision', baselineRef: rev1.id, trackIds: ['nope'],
}, 'alice'), /关注轨道不存在/);
ok(true, '未知关注轨道被拒绝');/* ---------- 新阻断级质检问题 ---------- */
console.log('新阻断级质检问题进入门禁');
qc.putRules(pid, {
  trackId: '',
  rules: {
    duration: { enabled: true, severity: 'blocker', params: { minMs: 500, maxMs: 10000 } },
    cps: { enabled: false, severity: 'warning', params: { maxCps: 20 } },
    line_chars: { enabled: false, severity: 'warning', params: { maxChars: 42 } },
    gap: { enabled: false, severity: 'warning', params: { minGapMs: 100 } },
    align: { enabled: false, severity: 'warning', params: { toleranceMs: 120, trackA: '', trackB: '' } },
  },
  author: 'alice',
});
const jBase = qc.startJob(pid, { revisionId: rev1.id, author: 'alice' }).job;
await waitFor(() => qc.getJob(jBase.id).status === 'done');
const snap5 = snapOf(rev4);
snap5.cues.find((c) => c.id === 'c2').end = 4200; // 200ms，新阻断
const rev5 = commit(pid, rev4.id, snap5, 'bob', '缩短 c2');
const j5 = qc.startJob(pid, { revisionId: rev5.id, author: 'alice' }).job;
await waitFor(() => qc.getJob(j5.id).status === 'done');
// 质检完成钩子会为每个活跃订阅补一次 trigger=qc 的门禁评估（含新阻断项）
await waitFor(() => gate.listEvaluations(pid, { revisionId: rev5.id, trigger: 'qc', subscriptionId: sid }).some((e) => e.status === 'done'));
await waitDone(pid, rev5.id);
const qcEv = gate.listEvaluations(pid, { revisionId: rev5.id, trigger: 'qc', subscriptionId: sid })[0];
const d5 = gate.getEvaluationDetail(pid, qcEv.id).evaluation;
const qcItem = d5.items.find((i) => i.kind === 'qc' && i.cueId === 'c2');
ok(!!qcItem && qcItem.ruleKey === 'duration' && qcItem.severityQc === 'blocker', '新出现的阻断级质检问题进入逐项证据');
ok(d5.summary.counts.qcNew >= 1, '汇总含 qcNew 计数');

// 阻断级问题按既有工作流忽略（基于当前 HEAD），使 QC 预检通过；门禁拦截与质检处理相互独立
const blockerFinding = qc.listFindings(pid, j5.id, { severity: 'blocker' }).find((f) => f.cue_id === 'c2');
qc.ignoreFindings(pid, { findingIds: [blockerFinding.id], action: 'ignore', reason: '已知保留', baseRevId: rev5.id, author: 'alice' });
const preOk = qc.preflight(pid, rev5.id).canPublish;
ok(preOk === true, '阻断处理后 QC 预检通过');
// 忽略阻断会触发该版本的门禁补评估：等待其完成（未命中 qcNew，最新事件决定放行/拦截）
await waitFor(() => {
  const pending = gate.listEvaluations(pid, { revisionId: rev5.id }).filter((e) => ['queued', 'running'].includes(e.status));
  return pending.length === 0;
});

/* ---------- 门禁拦截发布申请；豁免绑定事件+版本 ---------- */
console.log('门禁与豁免');
const g = gate.checkGate(pid, rev5.id);
ok(g.blocked === true && g.unexempted.some((b) => b.subscriptionId === sid),
  'rev5 被门禁拦截（仍有新增差异；阻断已处理但差异未豁免）', g.unexempted.map((b) => [b.subscriptionName, b.counts]));
assert.throws(() => qc.createRequest(pid, { revisionId: rev5.id, confirmations: [], author: 'alice' }), (e) => e.status === 403);
ok(true, '未豁免时提交发布申请抛 403');

const ensure1 = gate.ensureEvaluated(pid, rev5.id, 'alice');
const ensure2 = gate.ensureEvaluated(pid, rev5.id, 'alice');
ok(ensure1.pending === false && ensure2.pending === false, '已完成版本的 ensureEvaluated 幂等');

const hitEvent = gate.listEvaluations(pid, { revisionId: rev5.id, gateHit: 'true', subscriptionId: sid })[0];
assert.throws(() => gate.createExemption(pid, hitEvent.id, { name: '', reason: 'r' }, 'rev'), /具名/);
assert.throws(() => gate.createExemption(pid, hitEvent.id, { name: 'n', reason: '' }, 'rev'), /理由/);
ok(true, '豁免必须具名且填写理由');
const ex1 = gate.createExemption(pid, hitEvent.id, { name: '首发例外', reason: '人工核对通过' }, 'reviewer').exemption;
ok(ex1.revision_id === rev5.id && ex1.event_id === hitEvent.id, '豁免严格绑定事件与版本');
assert.throws(() => gate.createExemption(pid, hitEvent.id, { name: '再豁免', reason: 'x' }, 'rev'),
  (e) => e.status === 409);
ok(true, '同一事件不能重复豁免');

ok(gate.checkGate(pid, rev5.id).blocked === false, '豁免后该版本放行');
const req1 = qc.createRequest(pid, { revisionId: rev5.id, confirmations: [], author: 'alice', message: '首发' }).request;
qc.decideRequest(pid, req1.id, { action: 'approve', author: 'reviewer' });
const pub1 = qc.publish(pid, { requestId: req1.id, author: 'alice' });
ok(!!pub1.release && pub1.release.label === 'REL-001', '豁免后审批发布成功');

// 新版本：旧豁免不能沿用
const snap6 = snapOf(rev5);
snap6.cues.push({ id: 'c9', trackId: 't_main', start: 20000, end: 21500, text: '新版本追加的句子内容', locked: false });
const rev6 = commit(pid, rev5.id, snap6, 'carol', '追加 c9');
await waitDone(pid, rev6.id);
const g6 = gate.checkGate(pid, rev6.id);
ok(g6.blocked === true && g6.blockers.every((b) => !b.exemption), '新版本重新评估，旧豁免不能沿用');

/* ---------- 豁免撤销 ---------- */
const ev6 = gate.listEvaluations(pid, { revisionId: rev6.id, gateHit: 'true' })[0];
gate.createExemption(pid, ev6.id, { name: '临时', reason: '稍后修' }, 'reviewer');
ok(gate.checkGate(pid, rev6.id).blocked === false, '豁免后放行');
const ex6 = gate.listExemptions(pid).find((x) => x.event_id === ev6.id);
assert.throws(() => gate.revokeExemption(pid, ex6.id, { reason: '' }, 'reviewer'), /理由/);
gate.revokeExemption(pid, ex6.id, { reason: '复核不通过' }, 'reviewer');
ok(gate.checkGate(pid, rev6.id).blocked === true, '撤销豁免后该版本重新被拦截');

/* ---------- 暂停 / 恢复 ---------- */
console.log('暂停 / 恢复 / 手动重跑 / 失败重试');
gate.setPaused(pid, sid, true, 'alice');
const before = gate.listEvaluations(pid, { subscriptionId: sid }).length;
const snap7 = snapOf(rev6);
snap7.cues.push({ id: 'c10', trackId: 't_main', start: 30000, end: 31000, text: '暂停期间新增', locked: false });
const rev7 = commit(pid, rev6.id, snap7, 'bob', '暂停期提交');
await sleep(80);
ok(gate.listEvaluations(pid, { subscriptionId: sid }).length === before, '暂停期间提交不产生评估');
await waitDone(pid, rev7.id); // 其他订阅仍评估
gate.setPaused(pid, sid, false, 'alice');
await waitFor(() => gate.listEvaluations(pid, { subscriptionId: sid, revisionId: rev7.id }).some((e) => e.status === 'done'));
ok(true, '恢复后立即对最新 HEAD 补一次评估');

/* ---------- 手动重跑 ---------- */
const ev7 = gate.listEvaluations(pid, { subscriptionId: sid, revisionId: rev7.id })[0];
const rr1 = gate.rerun(pid, ev7.id, 'alice');
ok(rr1.deduplicated !== true && rr1.evaluation.id !== ev7.id, '已结束事件手动重跑产生新事件（新编号）');
const rr2 = gate.rerun(pid, rr1.evaluation.id, 'alice');
ok(rr2.deduplicated === true && rr2.evaluation.id === rr1.evaluation.id, '进行中事件重复重跑幂等复用');
await waitDone(pid, rev7.id, { min: 2 });

/* ---------- 失败重试 ---------- */
const failRow = gate.enqueue({
  projectId: pid, sub: gate.getSub(sid), revisionId: rev7.id, trigger: 'manual', author: 'alice',
});
await waitDone(pid, rev7.id, { min: 3 });
db.prepare(`UPDATE gate_evaluations SET status='failed', error=?, finished_at=? WHERE id=?`)
  .run('模拟执行失败：XXX', Date.now(), failRow.evaluation.id);
const failed = gate.getEval(failRow.evaluation.id);
ok(failed.status === 'failed' && failed.error.includes('XXX'), '失败保留原因');
assert.throws(() => gate.retry(pid, ev7.id, 'alice'), /只有失败的评估可以重试/);
ok(true, '非失败事件不能 retry');
gate.retry(pid, failRow.evaluation.id, 'alice');
await waitFor(() => gate.getEval(failRow.evaluation.id).status === 'done');
const retried = gate.getEval(failRow.evaluation.id);
ok(retried.status === 'done' && retried.attempts >= 2, '失败重试复用同一事件行并成功，attempts 递增');

/* ---------- 并发提交折叠 ---------- */
console.log('并发新提交');
const headA = commit(pid, rev7.id, (() => { const s = snapOf(rev7); s.cues[0].text = '并发改A'; return s; })(), 'x', 'A');
const headB = commit(pid, headA.id, (() => { const s = snapOf(headA); s.cues[0].text = '并发改B'; return s; })(), 'x', 'B');
const headC = commit(pid, headB.id, (() => { const s = snapOf(headB); s.cues[0].text = '并发改C'; return s; })(), 'x', 'C');
await sleep(150);
const commitEvs = gate.listEvaluations(pid, { subscriptionId: sid, trigger: 'commit', revisionId: headC.id });
ok(commitEvs.length === 1 && commitEvs[0].status === 'done', '并发新提交折叠为一个针对最新 HEAD 的事件',
  commitEvs.map((e) => [e.target_revision_id, e.status]));

/* ---------- 详情筛选 ---------- */
console.log('详情筛选与非法参数');
const detailAll = gate.getEvaluationDetail(pid, ev7.id);
ok(Array.isArray(detailAll.evaluation.items) && detailAll.subscription.name, '详情含逐项证据与订阅信息');
const onlyNew = gate.getEvaluationDetail(pid, ev7.id, { trend: 'new' }).evaluation.items;
ok(onlyNew.every((i) => i.trend === 'new'), '按趋势筛选');
const onlyQc = gate.getEvaluationDetail(pid, ev7.id, { kind: 'qc' }).evaluation.items;
ok(onlyQc.every((i) => i.kind === 'qc'), '按类型（质检）筛选');
assert.throws(() => gate.getEvaluationDetail(pid, ev7.id, { trend: 'bogus' }), /trend/);
assert.throws(() => gate.getEvaluationDetail(pid, ev7.id, { kind: 'bogus' }), /kind/);
assert.throws(() => gate.listEvaluations(pid, { status: 'bogus' }), /非法状态/);
ok(true, '非法筛选参数抛 400');

/* ---------- 发布快照作为基线 ---------- */
console.log('发布快照基线');
const subRel = gate.createSubscription(pid, {
  name: '快照基线门禁', baselineKind: 'release', baselineRef: pub1.release.id,
}, 'alice').subscription;
const headId = store.getProject(pid).head_id;
await waitFor(() => gate.listEvaluations(pid, { subscriptionId: subRel.id, revisionId: headId }).some((e) => e.status === 'done'));
const relEv = gate.listEvaluations(pid, { subscriptionId: subRel.id })[0];
ok(relEv.baseline_label === 'REL-001（发布快照）' && relEv.gate_hit === true, '发布快照可作为基线，差异正确计算');

/* ---------- 条件修改 ---------- */
console.log('订阅条件修改');
gate.updateSubscription(pid, subKw.id, { keyword: '另一个不匹配关键词 zzz' }, 'alice');
await sleep(100);
const kw2 = gate.listEvaluations(pid, { subscriptionId: subKw.id })[0];
ok(kw2.gate_hit === false, '修改关键词后重新评估');
assert.throws(() => gate.updateSubscription(pid, subKw.id, { baselineRef: 'r_nonexistent' }, 'alice'), /基线/);
ok(true, '改为不存在的基线被拒绝');

/* ---------- 审计 ---------- */
const audit = store.listAudit(pid, 5000).map((a) => a.action);
for (const a of ['gatesub-create', 'gatesub-update', 'gatesub-pause', 'gatesub-resume',
  'gateeval-queue', 'gateeval-start', 'gateeval-done', 'gate-block',
  'gateex-create', 'gateex-revoke', 'gatenotify', 'gateeval-retry']) {
  ok(audit.includes(a), '审计含 ' + a);
}

console.log(`\n门禁模块单元测试全部通过（${passed} 项断言）`);
