// 端到端：多阶段会签与审批策略
// 策略配置（顺序阶段：角色/最少同意人数/驳回重提/有效期）→ 提交申请冻结策略/门禁事件/版本/预检指纹 →
// 逐阶段会签（幂等/并发唯一迁移/意见署名时间留痕）→ 全部通过才批准发布 →
// 策略/门禁事件变化即失效 → 阶段超时过期与负责人重开 → 驳回后重新提交（新版本号+关联前申请）
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

async function submit(pid, baseRevId, snapshot, author = 'alice', message = '提交') {
  const r = await j('POST', `/api/projects/${pid}/revisions`, { baseRevId, snapshot, author, message });
  if (r.status !== 201) throw new Error('提交失败：' + JSON.stringify(r.data));
  return r.data.revision;
}
async function waitQc(pid, jobId) {
  for (let i = 0; i < 200; i++) {
    const { data } = await j('GET', `/api/projects/${pid}/qc/jobs/${jobId}`);
    if (data.job.status === 'done') return data.job;
    await sleep(25);
  }
  throw new Error('等待质检超时');
}
async function waitEval(pid, revId, subId) {
  for (let i = 0; i < 200; i++) {
    const { evaluations } = (await j('GET', `/api/projects/${pid}/gate/evaluations?revisionId=${revId}&subscriptionId=${subId}`)).data;
    if (evaluations.some((e) => e.status === 'done')) return evaluations;
    await sleep(30);
  }
  throw new Error('等待门禁评估超时');
}
// 规则全关 + 质检完成，使预检可通过
async function makePublishable(pid, rev) {
  await j('PUT', `/api/projects/${pid}/qc/rules`, {
    trackId: '', author: 'alice',
    rules: {
      duration: { enabled: false, severity: 'blocker', params: { minMs: 500, maxMs: 10000 } },
      cps: { enabled: false, severity: 'warning', params: { maxCps: 20 } },
      line_chars: { enabled: false, severity: 'warning', params: { maxChars: 42 } },
      gap: { enabled: false, severity: 'warning', params: { minGapMs: 100 } },
      align: { enabled: false, severity: 'warning', params: { toleranceMs: 120, trackA: '', trackB: '' } },
    },
  });
  const job = (await j('POST', `/api/projects/${pid}/qc/jobs`, { revisionId: rev.id, author: 'alice' })).data.job;
  await waitQc(pid, job.id);
  const pre = (await j('GET', `/api/projects/${pid}/releases/preflight?revisionId=${rev.id}`)).data;
  if (!pre.canPublish) throw new Error('预检未通过：' + JSON.stringify(pre.blockerUnhandled));
  return pre;
}
async function newProject(name) {
  const { data } = await j('POST', '/api/projects', { name, author: 'alice' });
  const pid = data.project.id;
  const snap = { ...data.revision.snapshot };
  snap.cues = [
    { id: 'c1', trackId: 't_main', start: 1000, end: 3000, text: '第一句正常对白内容', locked: false },
    { id: 'c2', trackId: 't_main', start: 4000, end: 6000, text: '第二句正常对白内容', locked: false },
  ];
  const rev = await submit(pid, data.revision.id, snap, 'alice', '种子版本');
  await makePublishable(pid, rev);
  return { pid, rev };
}
const getReq = async (pid, rid) =>
  (await j('GET', `/api/projects/${pid}/release-requests`)).data.requests.find((q) => q.id === rid);

/* ==================== 项目 D：策略配置 + 两阶段会签全流程 ==================== */
console.log('项目 D：多阶段会签全流程');
{
  const { pid, rev } = await newProject('多阶段会签');

  // 策略参数校验
  const badRole = await j('PUT', `/api/projects/${pid}/approval-policy`, {
    stages: [{ role: '', minApprovals: 1 }], author: 'lead',
  });
  const badMin = await j('PUT', `/api/projects/${pid}/approval-policy`, {
    stages: [{ role: '审校', minApprovals: 0 }], author: 'lead',
  });
  const badTtl = await j('PUT', `/api/projects/${pid}/approval-policy`, {
    stages: [{ role: '审校', minApprovals: 1, ttlMs: -5 }], author: 'lead',
  });
  ok(badRole.status === 400 && badMin.status === 400 && badTtl.status === 400, '非法策略参数被拒绝');

  // 配置两阶段策略：① 翻译审校（最少 2 人同意）② 发布终审（1 人，24 小时有效期）
  const put = await j('PUT', `/api/projects/${pid}/approval-policy`, {
    author: 'lead',
    stages: [
      { role: '翻译审校', minApprovals: 2, allowResubmit: true, ttlMs: 0 },
      { role: '发布终审', minApprovals: 1, allowResubmit: true, ttlMs: 24 * 3600 * 1000 },
    ],
  });
  ok(put.status === 200 && put.data.policy.stages.length === 2 && put.data.policy.hash, '审批策略已保存（两阶段）');
  const gotPolicy = (await j('GET', `/api/projects/${pid}/approval-policy`)).data.policy;
  ok(gotPolicy.stages[0].role === '翻译审校' && gotPolicy.stages[0].minApprovals === 2
    && gotPolicy.stages[1].ttlMs === 86400000, '策略可读取（角色/人数/有效期）');

  // 提交申请：冻结策略/门禁事件/版本/预检指纹，第一阶段激活
  const app1 = await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev.id, author: 'alice', confirmations: [], message: '首发' });
  ok(app1.status === 201 && app1.data.request.status === 'pending', '申请已提交（pending）');
  const rq = app1.data.request;
  ok(rq.policy_snapshot && rq.policy_snapshot.length === 2 && rq.policy_hash === gotPolicy.hash, '申请冻结了当时策略');
  ok(typeof rq.gate_fingerprint === 'string' && rq.fingerprint && rq.head_rev_id, '申请冻结了门禁事件/版本/预检指纹');
  ok(rq.version_no === 1 && !rq.prev_request_id, '首个申请版本号为 1');

  const l1 = await getReq(pid, rq.id);
  ok(l1.stages.length === 2 && l1.stages[0].status === 'active' && l1.stages[1].status === 'waiting',
    '阶段实例生成：第一阶段会签中，其余等待');
  ok(l1.stages[0].role === '翻译审校' && l1.stages[0].min_approvals === 2, '阶段冻结角色与最少同意人数');

  // 阶段 1：第一名审核人同意 → 未达法定人数，仍 pending
  const d1 = await j('POST', `/api/release-requests/${rq.id}/approve`, { author: 'rev-a', comment: '前半部分没问题' });
  ok(d1.status === 200 && d1.data.outcome === 'collecting' && d1.data.request.status === 'pending', '1/2 同意：继续会签');
  // 同一审核人重复同一操作 → 幂等
  const d1dup = await j('POST', `/api/release-requests/${rq.id}/approve`, { author: 'rev-a', comment: '前半部分没问题' });
  ok(d1dup.status === 200 && d1dup.data.deduplicated === true, '同一审核人同阶段重复操作幂等返回');
  const l2 = await getReq(pid, rq.id);
  ok(l2.stages[0].approvals === 1 && l2.stages[0].decisions.length === 1, '重复操作不产生重复意见');
  // 同一审核人改投驳回 → 409
  const d1flip = await j('POST', `/api/release-requests/${rq.id}/reject`, { author: 'rev-a', comment: '反悔' });
  ok(d1flip.status === 409, '同一审核人同阶段不同操作被拒绝');
  // 不能跨阶段：阶段 2 尚未激活（接口层面体现为只能对当前阶段投票，此处阶段 1 仍在会签）
  // 第二名审核人同意 → 阶段 1 通过，进入阶段 2
  const d2 = await j('POST', `/api/release-requests/${rq.id}/approve`, { author: 'rev-b', comment: '同意' });
  ok(d2.status === 200 && d2.data.outcome === 'stage-approved' && d2.data.request.current_stage === 1,
    '2/2 同意：阶段 1 通过并激活阶段 2');
  const l3 = await getReq(pid, rq.id);
  ok(l3.stages[0].status === 'approved' && l3.stages[1].status === 'active' && l3.status === 'pending',
    '未完成当前阶段不能进入下一阶段（逐阶段推进）');
  ok(l3.stages[1].expires_at > 0, '阶段 2 按策略生成有效期截止时间');
  // 阶段 1 已终结：rev-c 再对阶段 1 投票已无入口（当前阶段是 2）；rev-a/rev-b 的决定留痕
  ok(l3.stages[0].decisions.every((d) => d.reviewer && d.created_at > 0), '会签意见含署名与时间');

  // 阶段 2：一人同意即全部通过
  const d3 = await j('POST', `/api/release-requests/${rq.id}/approve`, { author: 'lead', comment: '终审通过' });
  ok(d3.status === 200 && d3.data.outcome === 'all-approved' && d3.data.request.status === 'approved',
    '全部阶段通过 → 申请批准');
  const l4 = await getReq(pid, rq.id);
  ok(l4.stages.every((s) => s.status === 'approved') && l4.reviewer === 'lead', '各阶段状态与审核人留痕');

  // 全部阶段通过后才能生成发布快照
  const pub = await j('POST', `/api/projects/${pid}/releases`, { requestId: rq.id, author: 'alice' });
  ok(pub.status === 201 && pub.data.release.label === 'REL-001', '全部阶段通过后发布成功');
  const relStages = pub.data.release.qc_summary.approval?.stages || [];
  ok(relStages.length === 2 && relStages[0].decisions.length === 2 && relStages[1].decisions[0].reviewer === 'lead',
    '发布快照冻结各阶段会签意见/署名/时间');

  // 详情：完整审计记录（事件流）
  const detail = (await j('GET', `/api/release-requests/${rq.id}`)).data;
  const acts = detail.events.map((e) => e.action);
  ok(acts.includes('submit') && acts.includes('stage-activate') && acts.filter((a) => a === 'decision').length === 3
    && acts.includes('stage-approved') && acts.includes('request-approved') && acts.includes('publish'),
    '申请事件流完整（提交/激活/意见/阶段通过/批准/发布）', acts.join(','));
  ok(detail.chain.length === 1 && detail.chain[0].version_no === 1, '重新提交链含本申请');

  const audit = (await j('GET', `/api/projects/${pid}/audit?limit=2000`)).data.audit.map((a) => a.action);
  for (const act of ['relpolicy-update', 'relreq-submit', 'relreq-approve', 'relreq-stage', 'relreq-publish']) {
    ok(audit.includes(act), `审计含 ${act}`);
  }
}

/* ==================== 项目 E：驳回后重新提交（版本号+关联）与禁止重提 ==================== */
console.log('项目 E：驳回与重新提交');
{
  const { pid, rev } = await newProject('驳回重提');
  await j('PUT', `/api/projects/${pid}/approval-policy`, {
    author: 'lead',
    stages: [
      { role: '校对', minApprovals: 1, allowResubmit: true, ttlMs: 0 },
      { role: '终审', minApprovals: 1, allowResubmit: false, ttlMs: 0 },
    ],
  });
  const mk = async () => (await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev.id, author: 'alice', confirmations: [] })).data.request;

  const rq1 = await mk();
  const noComment = await j('POST', `/api/release-requests/${rq1.id}/reject`, { author: 'rev-a', comment: '' });
  ok(noComment.status === 400, '驳回必须填写意见');
  const rej = await j('POST', `/api/release-requests/${rq1.id}/reject`, { author: 'rev-a', comment: '标点需统一' });
  ok(rej.status === 200 && rej.data.request.status === 'rejected' && rej.data.request.review_comment === '标点需统一',
    '阶段 1 驳回 → 申请驳回并留痕');

  // 驳回后重新提交：新申请版本号 + 关联前一申请
  const rq2 = await mk();
  ok(rq2.version_no === 2 && rq2.prev_request_id === rq1.id && rq2.root_request_id === rq1.id,
    '重新提交生成新申请版本并保留关联', JSON.stringify({ v: rq2.version_no, prev: rq2.prev_request_id }));
  const detail2 = (await j('GET', `/api/release-requests/${rq2.id}`)).data;
  ok(detail2.chain.length === 2 && detail2.events.some((e) => e.action === 'resubmit'),
    '申请链与重新提交事件留痕');

  // 推进到阶段 2 并驳回（该阶段策略不允许重新提交）
  await j('POST', `/api/release-requests/${rq2.id}/approve`, { author: 'rev-a', comment: '校对通过' });
  const rej2 = await j('POST', `/api/release-requests/${rq2.id}/reject`, { author: 'lead', comment: '终审不通过' });
  ok(rej2.status === 200 && rej2.data.request.status === 'rejected', '阶段 2 驳回');
  const rq3res = await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev.id, author: 'alice', confirmations: [] });
  ok(rq3res.status === 400 && /不允许重新提交/.test(rq3res.data.error), '被驳回阶段策略禁止重新提交', rq3res.data.error);

  const audit = (await j('GET', `/api/projects/${pid}/audit?limit=2000`)).data.audit.map((a) => a.action);
  ok(audit.includes('relreq-reject') && audit.includes('relreq-submit'), '驳回与重新提交写审计');
}

/* ==================== 项目 F：策略/门禁事件变化失效 + 阶段超时与重开 ==================== */
console.log('项目 F：失效与阶段超时');
{
  const { pid, rev } = await newProject('失效与超时');
  await j('PUT', `/api/projects/${pid}/approval-policy`, {
    author: 'lead',
    stages: [{ role: '审校', minApprovals: 2, allowResubmit: true, ttlMs: 0 }],
  });
  // ① 审批过程中策略变化 → 立即失效
  const rq1 = (await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev.id, author: 'alice', confirmations: [] })).data.request;
  await j('POST', `/api/release-requests/${rq1.id}/approve`, { author: 'rev-a' });
  await j('PUT', `/api/projects/${pid}/approval-policy`, {
    author: 'lead', stages: [{ role: '审校', minApprovals: 1, allowResubmit: true, ttlMs: 0 }],
  });
  const got1 = await getReq(pid, rq1.id);
  ok(got1.status === 'invalidated' && got1.invalid_reason === 'policy-changed',
    '策略变化 → 进行中申请立即失效', JSON.stringify({ s: got1.status, r: got1.invalid_reason }));
  const ev1 = (await j('GET', `/api/release-requests/${rq1.id}`)).data.events;
  ok(ev1.some((e) => e.action === 'invalidate' && e.detail.reason === 'policy-changed'), '失效原因写入事件流');

  // ② 门禁事件变化 → 失效（新建订阅触发对申请版本的评估）
  const rq2 = (await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev.id, author: 'alice', confirmations: [] })).data.request;
  ok(rq2.status === 'pending', '策略更新后重新提交申请');
  const sub = await j('POST', `/api/projects/${pid}/gate/subscriptions`, {
    name: '回归门禁', baselineKind: 'revision', baselineRef: rev.id, author: 'alice',
  });
  ok(sub.status === 201, '门禁订阅已创建');
  await waitEval(pid, rev.id, sub.data.subscription.id);
  const got2 = await getReq(pid, rq2.id);
  ok(got2.status === 'invalidated' && got2.invalid_reason === 'gate-changed',
    '门禁事件变化 → 申请失效', JSON.stringify({ s: got2.status, r: got2.invalid_reason }));

  // ③ 阶段超时 → 过期并记录原因；负责人重开；重开后可继续会签
  await j('PUT', `/api/projects/${pid}/approval-policy`, {
    author: 'lead',
    stages: [{ role: '审校', minApprovals: 2, allowResubmit: true, ttlMs: 600 }],
  });
  const rq3 = (await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev.id, author: 'alice', confirmations: [] })).data.request;
  await j('POST', `/api/release-requests/${rq3.id}/approve`, { author: 'rev-a' }); // 1/2
  await sleep(750);
  const got3 = await getReq(pid, rq3.id); // 列表读取触发超时扫描
  ok(got3.status === 'expired' && /审批有效期/.test(got3.stages[0].expire_reason || ''),
    '阶段超时 → 申请过期并记录原因', got3.stages?.[0]?.expire_reason);
  const approveExpired = await j('POST', `/api/release-requests/${rq3.id}/approve`, { author: 'rev-b' });
  ok(approveExpired.status === 409 && approveExpired.data.expired === true, '过期阶段不能继续会签');
  const ev3 = (await j('GET', `/api/release-requests/${rq3.id}`)).data.events;
  ok(ev3.some((e) => e.action === 'stage-expired'), '过期事件留痕');

  // 负责人重开（门禁仍满足：指纹均未变化）
  const reopen = await j('POST', `/api/release-requests/${rq3.id}/reopen`, { author: 'lead' });
  ok(reopen.status === 200 && reopen.data.request.status === 'pending', '负责人在门禁仍满足时重新开启阶段');
  const got3b = await getReq(pid, rq3.id);
  ok(got3b.stages[0].status === 'active' && got3b.stages[0].reopened_count === 1
    && got3b.stages[0].expires_at > Date.now(), '阶段重开并获得新的有效期窗口');
  ok(got3b.stages[0].approvals === 1, '重开保留已收集的会签意见');
  // 重开后继续会签至批准
  const d3 = await j('POST', `/api/release-requests/${rq3.id}/approve`, { author: 'rev-b' });
  ok(d3.status === 200 && d3.data.request.status === 'approved', '重开后会签完成并批准');

  // ④ 过期期间产生新提交 → 过期申请失效（不可重开）
  await j('PUT', `/api/projects/${pid}/approval-policy`, {
    author: 'lead',
    stages: [{ role: '审校', minApprovals: 1, allowResubmit: true, ttlMs: 500 }],
  });
  const rq4 = (await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev.id, author: 'alice', confirmations: [] })).data.request;
  await sleep(650);
  const got4 = await getReq(pid, rq4.id);
  ok(got4.status === 'expired', '短有效期再次过期');
  const snap2 = JSON.parse(JSON.stringify(rev.snapshot));
  snap2.cues[0].text = '改过文本的第一句';
  await submit(pid, rev.id, snap2, 'carol', '过期期间新提交');
  const got4b = await getReq(pid, rq4.id);
  ok(got4b.status === 'invalidated' && got4b.invalid_reason === 'new-revision', '过期期间新提交 → 申请失效');
  const reopenDead = await j('POST', `/api/release-requests/${rq4.id}/reopen`, { author: 'lead' });
  ok(reopenDead.status === 400, '已失效申请不能重新开启');

  const audit = (await j('GET', `/api/projects/${pid}/audit?limit=3000`)).data.audit.map((a) => a.action);
  for (const act of ['relreq-invalidate', 'relreq-expire', 'relreq-reopen']) {
    ok(audit.includes(act), `审计含 ${act}`);
  }
}

/* ==================== 项目 G：并发会签唯一状态转换 ==================== */
console.log('项目 G：并发会签');
{
  const { pid, rev } = await newProject('并发会签');
  await j('PUT', `/api/projects/${pid}/approval-policy`, {
    author: 'lead',
    stages: [{ role: '终审', minApprovals: 1, allowResubmit: true, ttlMs: 0 }],
  });
  const rq = (await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev.id, author: 'alice', confirmations: [] })).data.request;
  // 同意与驳回并发到达：只有一个合法状态转换
  const race = await Promise.all([
    j('POST', `/api/release-requests/${rq.id}/approve`, { author: 'race-a' }),
    j('POST', `/api/release-requests/${rq.id}/reject`, { author: 'race-b', comment: '并发驳回' }),
  ]);
  const codes = race.map((r) => r.status).sort();
  ok(codes[0] === 200 && codes[1] === 409, '并发同意/驳回：只有一个生效', JSON.stringify(codes));
  const fin = await getReq(pid, rq.id);
  ok((fin.status === 'approved' && fin.reviewer === 'race-a') || (fin.status === 'rejected' && fin.reviewer === 'race-b'),
    '并发后状态唯一确定', JSON.stringify({ s: fin.status, by: fin.reviewer }));
  const detail = (await j('GET', `/api/release-requests/${rq.id}`)).data;
  ok(detail.events.filter((e) => e.action === 'decision').length === 1, '阶段终结后另一决定不落库');

  // 两名审核人并发同意（需 2 人）：两条意见都落库，阶段只通过一次
  const { pid: pid2, rev: rev2 } = await newProject('并发会签2');
  await j('PUT', `/api/projects/${pid2}/approval-policy`, {
    author: 'lead',
    stages: [{ role: '审校', minApprovals: 2, allowResubmit: true, ttlMs: 0 }],
  });
  const rq2 = (await j('POST', `/api/projects/${pid2}/release-requests`, { revisionId: rev2.id, author: 'alice', confirmations: [] })).data.request;
  const race2 = await Promise.all([
    j('POST', `/api/release-requests/${rq2.id}/approve`, { author: 'rev-x' }),
    j('POST', `/api/release-requests/${rq2.id}/approve`, { author: 'rev-y' }),
  ]);
  ok(race2.every((r) => r.status === 200), '两名审核人并发同意均落库');
  const fin2 = await getReq(pid2, rq2.id);
  ok(fin2.status === 'approved' && fin2.stages[0].approvals === 2 && fin2.stages[0].status === 'approved',
    '会签进度 2/2，阶段只迁移一次');
  const det2 = (await j('GET', `/api/release-requests/${rq2.id}`)).data;
  ok(det2.events.filter((e) => e.action === 'stage-approved').length === 1, '阶段通过事件唯一');
  // 批准后发布
  const pub2 = await j('POST', `/api/projects/${pid2}/releases`, { requestId: rq2.id, author: 'alice' });
  ok(pub2.status === 201, '并发会签批准后正常发布');
}

console.log(failures === 0 ? '\n多阶段会签端到端全部通过 ✓' : `\n存在 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
