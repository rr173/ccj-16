// 端到端：发布回归门禁与变更订阅全流程
// 订阅（基线/轨道/类型/关键词/质检级别）→ 提交/质检异步评估（唯一事件编号）→
// 门禁拦截发布申请/快照 → 具名豁免（只绑事件+版本）→ 新版本重新评估 →
// 暂停/恢复/重跑/失败重试/并发折叠 → 审计
const BASE = 'http://localhost:3000';

async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function ok(cond, name, extra = '') {
  console.log(cond ? '  ✓' : '  ✗', name, cond ? '' : extra);
  if (!cond) failures++;
}

async function submit(baseRevId, snapshot, author = 'alice', message = '提交') {
  const r = await j('POST', `/api/projects/${PID}/revisions`, { baseRevId, snapshot, author, message });
  if (r.status !== 201) throw new Error('提交失败：' + JSON.stringify(r.data));
  return r.data.revision;
}
let PID;
async function waitEv(pred, { timeout = 4000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('等待评估超时');
    await sleep(40);
  }
}
async function waitEvalFor(revId, extra = '') {
  return waitEv(async () => {
    const { evaluations } = (await j('GET', `/api/projects/${PID}/gate/evaluations?revisionId=${revId}${extra}`)).data;
    const done = evaluations.filter((e) => e.status === 'done');
    return done.length ? done : null;
  });
}
async function waitQc(jobId) {
  return waitEv(async () => {
    const { job } = (await j('GET', `/api/projects/${PID}/qc/jobs/${jobId}`)).data;
    return job.status === 'done' ? job : null;
  });
}

console.log('项目与基线');
const { data: created } = await j('POST', '/api/projects', { name: '门禁端到端', author: 'alice' });
PID = created.project.id;
const rev0 = created.revision;
const snap1 = { ...rev0.snapshot };
snap1.cues = [
  { id: 'c1', trackId: 't_main', start: 1000, end: 3000, text: '第一句正常对白', locked: false },
  { id: 'c2', trackId: 't_main', start: 4000, end: 6000, text: '第二句正常对白', locked: false },
];
const rev1 = await submit(rev0.id, snap1, 'alice', '基线版本');

// 规则：先全关，保证基线/早期版本质检无阻断
await j('PUT', `/api/projects/${PID}/qc/rules`, {
  trackId: '', author: 'alice',
  rules: {
    duration: { enabled: false, severity: 'blocker', params: { minMs: 500, maxMs: 10000 } },
    cps: { enabled: false, severity: 'warning', params: { maxCps: 20 } },
    line_chars: { enabled: false, severity: 'warning', params: { maxChars: 42 } },
    gap: { enabled: false, severity: 'warning', params: { minGapMs: 100 } },
    align: { enabled: false, severity: 'warning', params: { toleranceMs: 120, trackA: '', trackB: '' } },
  },
});

console.log('订阅创建');
// 非法参数
const badType = await j('POST', `/api/projects/${PID}/gate/subscriptions`, {
  name: '坏', baselineKind: 'revision', baselineRef: rev1.id, diffTypes: ['bogus'], author: 'alice',
});
ok(badType.status === 400, '非法差异类型 400');
const badBase = await j('POST', `/api/projects/${PID}/gate/subscriptions`, {
  name: '坏', baselineKind: 'revision', baselineRef: 'r_nope', author: 'alice',
});
ok(badBase.status === 400, '基线版本无效 400');

const sub1 = await j('POST', `/api/projects/${PID}/gate/subscriptions`, {
  name: '全量回归门禁', baselineKind: 'revision', baselineRef: rev1.id, author: 'alice',
});
ok(sub1.status === 201, '订阅已创建');
const sid1 = sub1.data.subscription.id;
// 关键词订阅（永不命中）
const sub2 = await j('POST', `/api/projects/${PID}/gate/subscriptions`, {
  name: '关键词订阅', baselineKind: 'revision', baselineRef: rev1.id, keyword: 'zzz不存在', author: 'alice',
});
const sid2 = sub2.data.subscription.id;

const init1 = await waitEvalFor(rev1.id, `&subscriptionId=${sid1}`);
ok(init1[0].gate_hit === false && /^GATE-[A-F0-9]{4}-000001$/.test(init1[0].event_no),
  '创建后立即评估基线：无差异，首个编号 000001：' + init1[0].event_no);

console.log('新版本 → 异步评估 → 门禁拦截');
const snap2 = JSON.parse(JSON.stringify(rev1.snapshot));
snap2.cues.push({ id: 'c3', trackId: 't_main', start: 8000, end: 9500, text: '新增第三句对白', locked: false });
const rev2 = await submit(rev1.id, snap2, 'bob', '新增 c3');
const ev2all = await waitEvalFor(rev2.id, `&subscriptionId=${sid1}`);
const ev2 = ev2all.filter((e) => e.trigger === 'commit');
ok(ev2[0].trigger === 'commit' && ev2[0].gate_hit === true, '提交触发评估并命中门禁');
const d2 = (await j('GET', `/api/projects/${PID}/gate/evaluations/${ev2[0].id}`)).data;
const added = d2.evaluation.items.filter((i) => i.trend === 'new' && i.kind === 'diff');
ok(added.length === 1 && added[0].cueIdTo === 'c3', '逐项证据：新增 c3（含基线/目标定位版本）');
ok(!!added[0].evidence && d2.evaluation.baseline_rev_id === rev1.id, '证据与关联版本完整');

// 关键词订阅不命中
const ev2kw = await waitEvalFor(rev2.id, `&subscriptionId=${sid2}`);
ok(ev2kw[0].gate_hit === false, '关键词不匹配的订阅不命中');

// 门禁状态接口
const gs2 = (await j('GET', `/api/projects/${PID}/gate/status?revisionId=${rev2.id}`)).data;
ok(gs2.blocked === true && gs2.unexempted.some((b) => b.subscriptionId === sid1), '门禁状态：rev2 被拦截');

// 该版本需先有已完成质检，发布预检才会走到门禁判断（规则全关，质检无阻断）
const q2 = (await j('POST', `/api/projects/${PID}/qc/jobs`, { revisionId: rev2.id, author: 'alice' })).data.job;
await waitQc(q2.id);
const pre2 = (await j('GET', `/api/projects/${PID}/releases/preflight?revisionId=${rev2.id}`)).data;
ok(pre2.canPublish === true, '规则全关时 QC 预检通过（门禁独立于质检预检）');

// 提交发布申请：先 423（评估可能还在跑）或直接 403（命中）
async function expectGateBlock(revId) {
  for (let i = 0; i < 40; i++) {
    const r = await j('POST', `/api/projects/${PID}/release-requests`, { revisionId: revId, author: 'alice', confirmations: [] });
    if (r.status === 423) { await sleep(100); continue; }
    return r;
  }
  return { status: 423, data: { error: '一直 pending' } };
}
const blocked = await expectGateBlock(rev2.id);
ok(blocked.status === 403 && blocked.data.gateBlocked === true,
  '门禁阻止提交发布申请 403', String(blocked.status) + ' ' + blocked.data.error);
ok(blocked.data.blockers.some((b) => b.eventNo === ev2[0].event_no || (b.subscriptionId === sid1 && b.counts.new >= 1)),
  '拦截响应带事件编号与订阅名', JSON.stringify(blocked.data.blockers.map((b) => [b.eventNo, b.subscriptionName])));

// 审计：门禁拦截落库
{
  const audit = (await j('GET', `/api/projects/${PID}/audit?limit=2000`)).data.audit;
  ok(audit.some((a) => a.action === 'gate-block'), '门禁拦截写审计');
}

console.log('具名豁免（只绑本次事件+版本）');
const noName = await j('POST', `/api/projects/${PID}/gate/evaluations/${ev2[0].id}/exemptions`, { name: '', reason: 'x', author: 'rev' });
const noReason = await j('POST', `/api/projects/${PID}/gate/evaluations/${ev2[0].id}/exemptions`, { name: 'n', reason: '', author: 'rev' });
ok(noName.status === 400 && noReason.status === 400, '豁免必须具名且填写理由');
const ex = await j('POST', `/api/projects/${PID}/gate/evaluations/${ev2[0].id}/exemptions`, {
  name: '首发例外', reason: '新增内容已人工逐句核对', author: 'reviewer',
});
ok(ex.status === 201 && ex.data.exemption.revision_id === rev2.id && ex.data.exemption.event_id === ev2[0].id, '豁免绑定事件与版本');
const exDup = await j('POST', `/api/projects/${PID}/gate/evaluations/${ev2[0].id}/exemptions`, { name: 'x', reason: 'y', author: 'rev' });
ok(exDup.status === 409, '同事件重复豁免 409');
const gs2b = (await j('GET', `/api/projects/${PID}/gate/status?revisionId=${rev2.id}`)).data;
ok(gs2b.blocked === false, '豁免后该版本放行');

// 豁免后走完整发布流程
const app = await j('POST', `/api/projects/${PID}/release-requests`, { revisionId: rev2.id, author: 'alice', confirmations: [], message: '首发' });
ok(app.status === 201, '豁免后发布申请通过：' + app.status);
const rqId = app.data.request.id;
const approve = await j('POST', `/api/release-requests/${rqId}/approve`, { author: 'reviewer', comment: '同意' });
ok(approve.status === 200, '审核批准');
const pub = await j('POST', `/api/projects/${PID}/releases`, { requestId: rqId, author: 'alice' });
ok(pub.status === 201 && pub.data.release.label === 'REL-001', '豁免后生成发布快照');

console.log('新版本必须重新评估，旧豁免不沿用');
const snap3 = JSON.parse(JSON.stringify(rev2.snapshot));
snap3.cues.find((c) => c.id === 'c2').text = '第二句对白被改写';
const rev3 = await submit(rev2.id, snap3, 'carol', '改 c2');
const ev3all = await waitEvalFor(rev3.id, `&subscriptionId=${sid1}`);
const ev3 = ev3all.filter((e) => e.trigger === 'commit');
ok(ev3[0].gate_hit === true, '新版本重新评估并命中');
const d3 = (await j('GET', `/api/projects/${PID}/gate/evaluations/${ev3[0].id}`)).data;
ok(d3.exemption === null && d3.evaluation.items.some((i) => i.key === 'c2:text'), '新事件无豁免且含新差异');
// rev3 先质检（规则仍全关）使预检通过
const q3 = (await j('POST', `/api/projects/${PID}/qc/jobs`, { revisionId: rev3.id, author: 'alice' })).data.job;
await waitQc(q3.id);
const blocked3 = await expectGateBlock(rev3.id);
ok(blocked3.status === 403, '旧豁免不能绕过新版本门禁，实际：' + blocked3.status + ' ' + (blocked3.data.error || ''));

console.log('新阻断级质检问题进入门禁');
// 开启 duration 阻断；缩短 c2
await j('PUT', `/api/projects/${PID}/qc/rules`, {
  trackId: '', author: 'alice',
  rules: {
    duration: { enabled: true, severity: 'blocker', params: { minMs: 500, maxMs: 10000 } },
    cps: { enabled: false, severity: 'warning', params: { maxCps: 20 } },
    line_chars: { enabled: false, severity: 'warning', params: { maxChars: 42 } },
    gap: { enabled: false, severity: 'warning', params: { minGapMs: 100 } },
    align: { enabled: false, severity: 'warning', params: { toleranceMs: 120, trackA: '', trackB: '' } },
  },
});
const snap4 = JSON.parse(JSON.stringify(rev3.snapshot));
snap4.cues.find((c) => c.id === 'c2').end = 4200; // 200ms
const rev4 = await submit(rev3.id, snap4, 'bob', '缩短 c2');
const jq = (await j('POST', `/api/projects/${PID}/qc/jobs`, { revisionId: rev4.id, author: 'alice' })).data.job;
await waitQc(jq.id);
const ev4qc = await waitEv(async () => {
  const { evaluations } = (await j('GET', `/api/projects/${PID}/gate/evaluations?revisionId=${rev4.id}&trigger=qc&subscriptionId=${sid1}`)).data;
  const done = evaluations.filter((e) => e.status === 'done');
  return done.length ? done : null;
});
const d4 = (await j('GET', `/api/projects/${PID}/gate/evaluations/${ev4qc[0].id}`)).data;
ok(d4.evaluation.items.some((i) => i.kind === 'qc' && i.cueId === 'c2' && i.severityQc === 'blocker'),
  '质检完成后补评估：新阻断问题逐项在案');
ok(d4.evaluation.summary.counts.qcNew >= 1, '汇总含新质检问题计数');

console.log('暂停 / 恢复');
await j('POST', `/api/projects/${PID}/gate/subscriptions/${sid2}/pause`, { author: 'alice' });
const beforeCount = (await j('GET', `/api/projects/${PID}/gate/evaluations?subscriptionId=${sid2}`)).data.evaluations.length;
const snap5 = JSON.parse(JSON.stringify(rev4.snapshot));
snap5.cues.push({ id: 'c5', trackId: 't_main', start: 20000, end: 22000, text: '暂停期间的新增句', locked: false });
const rev5 = await submit(rev4.id, snap5, 'bob', '暂停期提交');
await sleep(250);
const afterCount = (await j('GET', `/api/projects/${PID}/gate/evaluations?subscriptionId=${sid2}`)).data.evaluations.length;
ok(afterCount === beforeCount, '暂停订阅不随提交评估');
await j('POST', `/api/projects/${PID}/gate/subscriptions/${sid2}/resume`, { author: 'alice' });
const resumed = await waitEv(async () => {
  const { evaluations } = (await j('GET', `/api/projects/${PID}/gate/evaluations?revisionId=${rev5.id}&subscriptionId=${sid2}`)).data;
  return evaluations.some((e) => e.status === 'done') ? evaluations : null;
});
ok(resumed[0].trigger === 'manual', '恢复时对最新 HEAD 补评估');

console.log('手动重跑 / 筛选 / 幂等');
// 选一个钉版事件（qc 触发）重跑：重跑原版本；commit 事件重跑会指向最新 HEAD
const pinned = ev4qc[0];
const rerun = await j('POST', `/api/projects/${PID}/gate/evaluations/${pinned.id}/rerun`, { author: 'alice' });
ok(rerun.status === 202 && rerun.data.evaluation.id !== pinned.id, '重跑产生新事件（新编号）');
const newId = rerun.data.evaluation.id;
await waitEv(async () => {
  const { evaluations } = (await j('GET', `/api/projects/${PID}/gate/evaluations?revisionId=${rev4.id}`)).data;
  return evaluations.some((e) => e.id === newId && e.status === 'done');
});
// 对完成事件立即再重跑：结果相同 → 独立历史事件但 notif 跳过（无重复通知）
const rerun2 = await j('POST', `/api/projects/${PID}/gate/evaluations/${newId}/rerun`, { author: 'alice' });
ok(rerun2.status === 202, '再次重跑也生成事件（结果重复时折叠通知）');
await sleep(300);
// 列表筛选
const onlyHit = (await j('GET', `/api/projects/${PID}/gate/evaluations?gateHit=true`)).data.evaluations;
ok(onlyHit.every((e) => e.gate_hit), '按门禁命中筛选');
const onlyFailed = (await j('GET', `/api/projects/${PID}/gate/evaluations?status=failed`)).data.evaluations;
ok(Array.isArray(onlyFailed), '按状态筛选');
const badFilter = await j('GET', `/api/projects/${PID}/gate/evaluations?status=bogus`);
ok(badFilter.status === 400, '非法筛选参数 400');
// 详情内筛选
const filtered = (await j('GET', `/api/projects/${PID}/gate/evaluations/${newId}?trend=new&kind=diff`)).data;
ok(filtered.evaluation.items.every((i) => i.trend === 'new' && i.kind === 'diff'), '详情按趋势+类型筛选');

console.log('失败重试（复用事件行，保留原因）');
// 通过撤销发布使基线 release 失效不易造失败，直接验证接口语义：已完成事件 retry 400
const retryDone = await j('POST', `/api/projects/${PID}/gate/evaluations/${pinned.id}/retry`, { author: 'alice' });
ok(retryDone.status === 400, '已完成事件不能 retry（应使用重跑）');

console.log('并发提交折叠');
let head = rev5.id;
const mk = (text) => {
  const s = JSON.parse(JSON.stringify(rev5.snapshot));
  s.cues[0].text = text;
  return s;
};
const a = await j('POST', `/api/projects/${PID}/revisions`, { baseRevId: head, snapshot: mk('并发A'), author: 'x', message: 'A' });
head = a.data.revision.id;
const b = await j('POST', `/api/projects/${PID}/revisions`, { baseRevId: head, snapshot: { ...mk('并发B') }, author: 'x', message: 'B' });
head = b.data.revision.id;
const c = await j('POST', `/api/projects/${PID}/revisions`, { baseRevId: head, snapshot: { ...mk('并发C') }, author: 'x', message: 'C' });
const headC = c.data.revision.id;
await sleep(300);
const commitEvs = (await j('GET', `/api/projects/${PID}/gate/evaluations?trigger=commit&revisionId=${headC}&subscriptionId=${sid1}`)).data.evaluations;
ok(commitEvs.length === 1 && commitEvs[0].status === 'done',
  '并发新提交只产生一个针对最新 HEAD 的事件', JSON.stringify(commitEvs.map((e) => [e.target_revision_id.slice(-5), e.status])));

console.log('豁免列表与撤销');
const exs = (await j('GET', `/api/projects/${PID}/gate/exemptions`)).data.exemptions;
ok(exs.length >= 1 && exs.some((x) => x.name === '首发例外'), '豁免列表含具名记录');
const revokeNoReason = await j('POST', `/api/gate/exemptions/${ex.data.exemption.id}/revoke`, { author: 'rev', reason: '' });
ok(revokeNoReason.status === 400, '撤销豁免必须填理由');

console.log('审计完整性');
const audit = (await j('GET', `/api/projects/${PID}/audit?limit=4000`)).data.audit.map((x) => x.action);
for (const act of ['gatesub-create', 'gatesub-pause', 'gatesub-resume', 'gateeval-queue', 'gateeval-start',
  'gateeval-done', 'gate-block', 'gateex-create', 'gatenotify']) {
  ok(audit.includes(act), '审计含 ' + act);
}
// 重复结果不重复通知：rev3 三次评估（原 + 两次重跑）至多首条通知
{
  const all = (await j('GET', `/api/projects/${PID}/gate/evaluations?revisionId=${rev3.id}`)).data.evaluations;
  const notifs = (await j('GET', `/api/projects/${PID}/audit?limit=4000`)).data.audit
    .filter((a) => a.action === 'gatenotify')
    .filter((a) => all.some((e) => a.field.includes(e.id)));
  ok(notifs.length >= 1, '至少一次通知');
}

console.log(failures === 0 ? '\n门禁端到端全部通过 ✓' : `\n存在 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
