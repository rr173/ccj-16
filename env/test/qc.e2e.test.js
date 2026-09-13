// 端到端：交付质检与发布快照全流程
// 规则配置 → 质检任务（取消/去重/重跑）→ 结果处理（忽略/过期/修复/护栏）→ 发布门禁 → 快照冻结/对比/撤销 → 审计追溯
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

let failures = 0;
function ok(cond, name, extra = '') {
  console.log(cond ? '  ✓' : '  ✗', name, cond ? '' : extra);
  if (!cond) failures++;
}

async function waitJob(pid, jobId, want = 'done') {
  for (let i = 0; i < 200; i++) {
    const { data } = await j('GET', `/api/projects/${pid}/qc/jobs/${jobId}`);
    if (data.job.status === want) return data.job;
    if (['cancelled', 'failed'].includes(data.job.status) && want === 'done') {
      throw new Error(`任务意外结束：${data.job.status}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('等待任务超时');
}

async function submit(pid, baseRevId, snapshot, author, message) {
  const r = await j('POST', `/api/projects/${pid}/revisions`, { baseRevId, snapshot, author, message });
  if (r.status !== 201) throw new Error('提交失败：' + JSON.stringify(r.data));
  return r.data.revision;
}

/* ---------- 项目 A：完整质检→处理→发布流程 ---------- */
console.log('项目 A：质检与发布全流程');
const { data: created } = await j('POST', '/api/projects', { name: '质检发布流程', author: 'alice' });
const pid = created.project.id;
const rev0 = created.revision;

const seedSnap = {
  ...created.revision.snapshot,
  tracks: [
    { id: 't_main', name: '主轨', color: '#4e8cff', mutexGroup: null },
    { id: 't_sub', name: '副轨', color: '#ff9a3c', mutexGroup: null },
  ],
  cues: [
    { id: 'c1', trackId: 't_main', start: 0, end: 200, text: '短', locked: false },
    { id: 'c2', trackId: 't_main', start: 2000, end: 3000, text: '正常句', locked: false },
    { id: 'c3', trackId: 't_main', start: 5000, end: 6000, text: 'x'.repeat(50), locked: false },
    { id: 'c5', trackId: 't_main', start: 8000, end: 20000, text: '这句太长了', locked: false },
    { id: 'c4', trackId: 't_sub', start: 5050, end: 6150, text: '对齐句', locked: false },
  ],
};
const rev1 = await submit(pid, rev0.id, seedSnap, 'alice', '种子版本');

// 规则配置：项目级（duration 阻断、cps 关闭）+ 轨道级覆盖
const putRules = await j('PUT', `/api/projects/${pid}/qc/rules`, {
  trackId: '', author: 'alice',
  rules: {
    duration: { enabled: true, severity: 'blocker', params: { minMs: 500, maxMs: 10000 } },
    cps: { enabled: false, severity: 'warning', params: { maxCps: 20 } },
    line_chars: { enabled: true, severity: 'warning', params: { maxChars: 42 } },
    gap: { enabled: true, severity: 'warning', params: { minGapMs: 200 } },
    align: { enabled: true, severity: 'warning', params: { toleranceMs: 100, trackA: '', trackB: '' } },
  },
});
ok(putRules.status === 200 && putRules.data.rules[''].duration.severity === 'blocker', '项目级规则已保存');
const putTrack = await j('PUT', `/api/projects/${pid}/qc/rules`, {
  trackId: 't_sub', author: 'alice',
  rules: { align: { enabled: true, severity: 'blocker', params: { toleranceMs: 100, trackA: '', trackB: '' } } },
});
ok(putTrack.status === 200 && putTrack.data.rules.t_sub.align.severity === 'blocker', '轨道级覆盖已保存');
const badRule = await j('PUT', `/api/projects/${pid}/qc/rules`, {
  trackId: '', author: 'alice', rules: { duration: { params: { minMs: 9999, maxMs: 100 } } },
});
ok(badRule.status === 400, '非法规则参数被拒绝', JSON.stringify(badRule.data));

// 发起质检 → 任务可追踪 → 完成
const job1Start = await j('POST', `/api/projects/${pid}/qc/jobs`, { revisionId: rev1.id, author: 'alice' });
ok(job1Start.status === 202 && job1Start.data.job.status === 'running', '质检任务已启动并可追踪');
const job1 = await waitJob(pid, job1Start.data.job.id);
ok(job1.status === 'done' && job1.summary.total === 4 && job1.summary.blocker === 2 && job1.summary.warning === 2,
  '任务完成，统计正确', JSON.stringify(job1.summary));

const { data: f1 } = await j('GET', `/api/projects/${pid}/qc/jobs/${job1.id}/findings`);
ok(f1.findings.length === 4, '共 4 条结果');
const fBlock = (await j('GET', `/api/projects/${pid}/qc/jobs/${job1.id}/findings?severity=blocker`)).data.findings;
ok(fBlock.length === 2 && fBlock.every((x) => x.severity === 'blocker'), '按严重级别筛选');
const fTrack = (await j('GET', `/api/projects/${pid}/qc/jobs/${job1.id}/findings?trackId=t_main`)).data.findings;
ok(fTrack.length === 4, '按轨道筛选');
const fCombo = (await j('GET', `/api/projects/${pid}/qc/jobs/${job1.id}/findings?trackId=t_main&severity=warning&status=open`)).data.findings;
ok(fCombo.length === 2, '轨道+级别+状态组合筛选');
const c1F = f1.findings.find((x) => x.cue_id === 'c1');
const c5F = f1.findings.find((x) => x.cue_id === 'c5');
const c3Line = f1.findings.find((x) => x.cue_id === 'c3' && x.rule_key === 'line_chars');
ok(c1F.evidence.includes('200ms') && c1F.suggestion.safe === true, '结果含证据与安全建议');
ok(c1F.basis.start === 0 && c1F.basis.end === 200, '结果记录句子基准值');

// 发布门禁：阻断未处理 → 预检不通过、不能提交发布申请
const pre0 = await j('GET', `/api/projects/${pid}/releases/preflight?revisionId=${rev1.id}`);
ok(pre0.data.canPublish === false && pre0.data.blockerUnhandled.length === 2, '预检：阻断未处理不可发布');
const pubEarly = await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev1.id, author: 'alice', confirmations: [] });
ok(pubEarly.status === 400, '阻断未处理时提交发布申请被拒绝');

// 自动修复（安全项）→ 生成 qcfix 版本
const fix1 = await j('POST', `/api/projects/${pid}/qc/findings/fix`, {
  findingIds: [c5F.id], baseRevId: rev1.id, author: 'bob', reason: '按建议缩短',
});
ok(fix1.status === 201 && fix1.data.revision.kind === 'qcfix', '安全项自动修复生成 qcfix 版本');
const rev2 = fix1.data.revision;
ok(rev2.snapshot.cues.find((c) => c.id === 'c5').end === 18000, 'c5 已缩短到最长时长');
const c5After = (await j('GET', `/api/projects/${pid}/qc/findings/${c5F.id}`)).data;
ok(c5After.finding.status === 'fixed' && c5After.finding.fix_revision_id === rev2.id, '修复结果状态与关联版本留痕');
ok(c5After.events.some((e) => e.action === 'fix' && e.actor === 'bob'), '修复事件含操作者');

// 非安全项不能自动修复
const fixManual = await j('POST', `/api/projects/${pid}/qc/findings/fix`, {
  findingIds: [c3Line.id], baseRevId: rev2.id, author: 'bob',
});
ok(fixManual.status === 409 && /安全/.test(fixManual.data.failures?.[0]?.reason || ''), '人工项拒绝自动修复');

// 忽略（基于当前 HEAD）
const ign1 = await j('POST', `/api/projects/${pid}/qc/findings/decide`, {
  findingIds: [c1F.id], action: 'ignore', reason: '语气停顿，保留', baseRevId: rev2.id, author: 'alice',
});
ok(ign1.status === 200 && ign1.data.updated === 1, '阻断项标记忽略');

// 新版本 → 旧忽略决定过期
const snap3 = JSON.parse(JSON.stringify(rev2.snapshot));
snap3.cues.find((c) => c.id === 'c2').text = '改过的文本';
const rev3 = await submit(pid, rev2.id, snap3, 'carol', '改 c2 文本');
const c1Stale = (await j('GET', `/api/projects/${pid}/qc/findings/${c1F.id}`)).data;
ok(c1Stale.finding.status === 'stale', '新版本后旧处理被识别为过期');
ok(c1Stale.events.some((e) => e.action === 'stale'), '过期事件留痕');

// 基于旧版本的处理被拒绝
const ignStale = await j('POST', `/api/projects/${pid}/qc/findings/decide`, {
  findingIds: [c1F.id], action: 'ignore', reason: 'x', baseRevId: rev2.id, author: 'alice',
});
ok(ignStale.status === 409 && ignStale.data.stale === true, '基于旧版本的处理返回 409 要求重新选择');

// 对新版本重新质检 → 重新处理
const job2 = await waitJob(pid, (await j('POST', `/api/projects/${pid}/qc/jobs`, { revisionId: rev3.id, author: 'alice' })).data.job.id);
ok(job2.summary.blocker === 1 && job2.summary.warning === 2, '修复后重新质检：阻断只剩 c1');
const f2 = (await j('GET', `/api/projects/${pid}/qc/jobs/${job2.id}/findings`)).data.findings;
const c1F2 = f2.find((x) => x.cue_id === 'c1');
await j('POST', `/api/projects/${pid}/qc/findings/decide`, {
  findingIds: [c1F2.id], action: 'ignore', reason: '确认保留', baseRevId: rev3.id, author: 'alice',
});

// 发布：警告需随申请逐项确认
const pre1 = (await j('GET', `/api/projects/${pid}/releases/preflight?revisionId=${rev3.id}`)).data;
ok(pre1.canPublish === true && pre1.warningsPending.length === 2 && typeof pre1.fingerprint === 'string', '预检通过，2 条警告待确认，含指纹');

// 未批准不能发布
const noReq = await j('POST', `/api/projects/${pid}/releases`, { requestId: 'rq_nonexistent', author: 'alice' });
ok(noReq.status === 404, '没有申请不能发布');

// 警告未逐项确认 → 申请被拒
const appNoConfirm = await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev3.id, author: 'alice', confirmations: [], message: '首发' });
ok(appNoConfirm.status === 400 && appNoConfirm.data.missing.length === 2, '未逐项确认警告不能提交申请');

// 驳回必须填写意见
const app1 = await j('POST', `/api/projects/${pid}/release-requests`, {
  revisionId: rev3.id, author: 'alice', confirmations: pre1.warningsPending.map((w) => w.id), message: '首发',
});
ok(app1.status === 201 && app1.data.request.status === 'pending', '发布申请已提交（pending，绑定版本与预检结果）');
const rq1 = app1.data.request.id;
ok(app1.data.request.preflight.fingerprint === pre1.fingerprint, '申请冻结了预检结果与指纹');

// 重复提交 → 幂等返回同一申请
const app1Dup = await j('POST', `/api/projects/${pid}/release-requests`, {
  revisionId: rev3.id, author: 'bob', confirmations: pre1.warningsPending.map((w) => w.id),
});
ok(app1Dup.status === 200 && app1Dup.data.deduplicated === true && app1Dup.data.request.id === rq1, '重复提交申请幂等返回');

const rejectNoReason = await j('POST', `/api/release-requests/${rq1}/reject`, { author: 'rev1', comment: '' });
ok(rejectNoReason.status === 400, '驳回不填意见被拒绝');

// 驳回 → 状态与意见/时间/署名留痕
const reject1 = await j('POST', `/api/release-requests/${rq1}/reject`, { author: 'rev1', comment: '请再核对 c1' });
ok(reject1.status === 200 && reject1.data.request.status === 'rejected' && reject1.data.request.reviewer === 'rev1', '申请被驳回并留痕');
// 已驳回不能批准、不能重复驳回
const rejApprove = await j('POST', `/api/release-requests/${rq1}/approve`, { author: 'rev1' });
const rejAgain = await j('POST', `/api/release-requests/${rq1}/reject`, { author: 'rev1', comment: 'x' });
ok(rejApprove.status === 409 && rejAgain.status === 409, '已驳回申请不能再批准或重复驳回');
const pubRejected = await j('POST', `/api/projects/${pid}/releases`, { requestId: rq1, author: 'alice' });
ok(pubRejected.status === 409, '已驳回申请不能发布');

// 重新申请（驳回后允许同版本重新提交）
const app2 = await j('POST', `/api/projects/${pid}/release-requests`, {
  revisionId: rev3.id, author: 'alice', confirmations: pre1.warningsPending.map((w) => w.id), message: '首发v2',
});
ok(app2.status === 201 && app2.data.request.id !== rq1 && app2.data.request.status === 'pending', '驳回后可重新申请（新记录）');
const rq2 = app2.data.request.id;
const approve1 = await j('POST', `/api/release-requests/${rq2}/approve`, { author: 'rev2', comment: '同意发布' });
ok(approve1.status === 200 && approve1.data.request.status === 'approved' && approve1.data.request.reviewed_at > 0, '申请获批准，审核人/意见/时间留痕');
// 不能重复批准、批准后不能驳回
const appAgain = await j('POST', `/api/release-requests/${rq2}/approve`, { author: 'rev3' });
const appThenRej = await j('POST', `/api/release-requests/${rq2}/reject`, { author: 'rev3', comment: '反悔' });
ok(appAgain.status === 409 && appThenRej.status === 409, '已批准申请不能重复批准或再驳回');

// 发布：凭批准的申请
const pub1 = await j('POST', `/api/projects/${pid}/releases`, { requestId: rq2, author: 'alice' });
ok(pub1.status === 201 && pub1.data.release.label === 'REL-001', '批准后发布成功，生成唯一标识 REL-001');
const rel1 = pub1.data.release;
ok(rel1.snapshot.cues.length === 5 && rel1.rules_snapshot[''].duration.severity === 'blocker' && rel1.qc_summary.jobId === job2.id,
  '快照冻结句子/规则配置/质检摘要');
ok(rel1.files.srt.all.includes('00:00:08,000 --> 00:00:18,000') && rel1.files.vtt.all.startsWith('WEBVTT'), '快照内含 SRT/VTT 文件');
const rq2After = (await j('GET', `/api/projects/${pid}/release-requests`)).data.requests.find((q) => q.id === rq2);
ok(rq2After.status === 'published' && rq2After.release_id === rel1.id, '申请状态变为已发布并关联快照');

// 重复发布（同一批准申请再发）→ 不产生重复快照
const pubDup = await j('POST', `/api/projects/${pid}/releases`, { requestId: rq2, author: 'bob' });
ok(pubDup.status === 200 && pubDup.data.deduplicated === true && pubDup.data.release.id === rel1.id, '同版本重复发布返回已有快照');

// 下载文件
const dl1 = await fetch(`${BASE}/api/releases/${rel1.id}/files/srt/all`);
const srt1 = await dl1.text();
ok(dl1.status === 200 && srt1.includes('改过的文本') && srt1.includes('00:00:00,000 --> 00:00:00,200'), 'SRT 下载内容为冻结版本');
const dlVtt = await fetch(`${BASE}/api/releases/${rel1.id}/files/vtt/t_main`);
ok(dlVtt.status === 200 && (await dlVtt.text()).includes('WEBVTT'), '按轨道下载 VTT');

// 项目继续编辑 → 快照内容不变
const snap4 = JSON.parse(JSON.stringify(rev3.snapshot));
snap4.cues.find((c) => c.id === 'c2').text = '再改一次';
snap4.cues.push({ id: 'c9', trackId: 't_main', start: 30000, end: 31000, text: '新增句', locked: false });
const rev4 = await submit(pid, rev3.id, snap4, 'carol', '发布后继续编辑');
const srt2 = await (await fetch(`${BASE}/api/releases/${rel1.id}/files/srt/all`)).text();
ok(srt2 === srt1 && !srt2.includes('再改一次'), '项目新版本不影响已发布快照');

// 快照 vs 后续版本逐句差异
const diff = (await j('GET', `/api/releases/${rel1.id}/diff?against=${rev4.id}`)).data;
ok(diff.summary.cues.changed === 1 && diff.summary.cues.added === 1, '逐句差异统计正确');
ok(diff.cues.find((c) => c.id === 'c2').changes.text.to === '再改一次', '差异含字段级新旧值');

// 撤销发布 → 文件不可下载；之后可重新发布（新标识）
const wd = await j('POST', `/api/releases/${rel1.id}/withdraw`, { author: 'alice', reason: '发现漏翻' });
ok(wd.data.release.status === 'withdrawn' && wd.data.release.withdrawn_by === 'alice', '撤销发布留痕');
const dlGone = await fetch(`${BASE}/api/releases/${rel1.id}/files/srt/all`);
ok(dlGone.status === 410, '撤销后文件不可下载');
// 撤销后重新发布：项目已产生新版本，旧的忽略决定已过期，需重新选择后才能发
const headNow = (await j('GET', `/api/projects/${pid}`)).data.project.head_id;
const reIgnore = await j('POST', `/api/projects/${pid}/qc/findings/decide`, {
  findingIds: [c1F2.id], action: 'ignore', reason: '重新确认保留', baseRevId: headNow, author: 'alice',
});
ok(reIgnore.status === 200, '撤销后重新处理过期阻断项');
// 撤销后重新发布：旧申请已 published 终结，需对该版本重新申请→批准→发布
const preRe = (await j('GET', `/api/projects/${pid}/releases/preflight?revisionId=${rev3.id}`)).data;
ok(preRe.canPublish === true, '重新处理后预检再次通过');
const appRe = await j('POST', `/api/projects/${pid}/release-requests`, {
  revisionId: rev3.id, author: 'alice', confirmations: preRe.warningsPending.map((w) => w.id), message: '重发',
});
ok(appRe.status === 201, '撤销后可重新提交申请');
const apprRe = await j('POST', `/api/release-requests/${appRe.data.request.id}/approve`, { author: 'rev2' });
ok(apprRe.status === 200, '重新申请获批准');
const pub2 = await j('POST', `/api/projects/${pid}/releases`, { requestId: appRe.data.request.id, author: 'alice' });
ok(pub2.status === 201 && pub2.data.release.label === 'REL-002' && pub2.data.release.id !== rel1.id, '撤销后经审批可重新发布（新标识）');

// 修复护栏①：修复会引入新重叠 → 拒绝
const job3 = await waitJob(pid, (await j('POST', `/api/projects/${pid}/qc/jobs`, { revisionId: rev4.id, author: 'alice' })).data.job.id);
const f3 = (await j('GET', `/api/projects/${pid}/qc/jobs/${job3.id}/findings`)).data.findings;
const c1F3 = f3.find((x) => x.cue_id === 'c1' && x.status === 'open');
const snap5 = JSON.parse(JSON.stringify(rev4.snapshot));
const c2m = snap5.cues.find((c) => c.id === 'c2');
c2m.start = 300; c2m.end = 1300; // 挪到 c1 后方，挡住延长
const rev5 = await submit(pid, rev4.id, snap5, 'carol', '挪动 c2');
const fixBlocked = await j('POST', `/api/projects/${pid}/qc/findings/fix`, {
  findingIds: [c1F3.id], baseRevId: rev5.id, author: 'bob',
});
ok(fixBlocked.status === 400 && fixBlocked.data.violations?.length > 0, '修复引入新重叠被时间轴复检拒绝');

// 修复护栏②：句子质检后被他人修改 → 拒绝（不覆盖新修改）
const snap6 = JSON.parse(JSON.stringify(rev5.snapshot));
snap6.cues.find((c) => c.id === 'c1').text = '别人改过的短句';
const rev6 = await submit(pid, rev5.id, snap6, 'carol', '改 c1 文本');
const fixGuarded = await j('POST', `/api/projects/${pid}/qc/findings/fix`, {
  findingIds: [c1F3.id], baseRevId: rev6.id, author: 'bob',
});
ok(fixGuarded.status === 409 && /已被修改/.test(fixGuarded.data.failures?.[0]?.reason || ''), '句子已变化时修复被拒绝');

// 某句从发现到处理的完整历史
const hist = (await j('GET', `/api/projects/${pid}/qc/cues/c1/history`)).data.history;
const allActions = hist.flatMap((h) => h.events.map((e) => e.action));
ok(hist.length >= 3 && allActions.includes('found') && allActions.includes('ignore') && allActions.includes('stale'),
  'c1 完整历史：found→ignore→stale→ignore');

// 审计追溯
const audit = (await j('GET', `/api/projects/${pid}/audit?limit=2000`)).data.audit.map((a) => a.action);
for (const act of ['qc-rule', 'qc-run', 'qc-done', 'qc-fix', 'qc-ignore', 'qc-stale', 'qc-confirm',
  'relreq-submit', 'relreq-approve', 'relreq-reject', 'relreq-publish', 'publish', 'withdraw']) {
  ok(audit.includes(act), `审计含 ${act}`);
}
const revs = (await j('GET', `/api/projects/${pid}/revisions`)).data.revisions;
ok(revs.some((r) => r.kind === 'qcfix'), '版本历史含 qcfix 修复版本');

/* ---------- 项目 B：任务取消 / 运行中去重 / 重跑 ---------- */
console.log('项目 B：任务取消与去重');
const { data: createdB } = await j('POST', '/api/projects', { name: '取消与去重', author: 'alice' });
const pidB = createdB.project.id;
const cuesB = [];
for (let i = 0; i < 200; i++) {
  cuesB.push({ id: `b${i}`, trackId: 't_main', start: i * 2000, end: i * 2000 + 100, text: '短', locked: false });
}
const revB = await submit(pidB, createdB.revision.id, { ...createdB.revision.snapshot, cues: cuesB }, 'alice', '200 句');

const jb1 = (await j('POST', `/api/projects/${pidB}/qc/jobs`, { revisionId: revB.id, author: 'alice' })).data;
const jb2 = await j('POST', `/api/projects/${pidB}/qc/jobs`, { revisionId: revB.id, author: 'alice' });
ok(jb2.data.deduplicated === true && jb2.data.job.id === jb1.job.id, '运行中重复发起被去重');
const cancel = await j('POST', `/api/projects/${pidB}/qc/jobs/${jb1.job.id}/cancel`, { author: 'alice' });
ok(cancel.data.job.status === 'cancelled', '任务可取消');
await waitJob(pidB, jb1.job.id, 'cancelled');
const fB = (await j('GET', `/api/projects/${pidB}/qc/jobs/${jb1.job.id}/findings`)).data.findings;
ok(fB.length === 0, '取消的任务不落结果');
const cancelAgain = await j('POST', `/api/projects/${pidB}/qc/jobs/${jb1.job.id}/cancel`, { author: 'alice' });
ok(cancelAgain.status === 400, '已取消任务不能重复取消');

const jb3 = (await j('POST', `/api/projects/${pidB}/qc/jobs`, { revisionId: revB.id, author: 'alice' })).data;
ok(jb3.job.id !== jb1.job.id, '取消后可重新发起（新任务）');
const jb3Done = await waitJob(pidB, jb3.job.id);
ok(jb3Done.status === 'done' && jb3Done.summary.total === 200, '重跑完成，200 条时长过短结果');
const jobsB = (await j('GET', `/api/projects/${pidB}/qc/jobs`)).data.jobs;
ok(jobsB.length === 2 && jobsB.filter((x) => x.status === 'cancelled').length === 1, '任务历史完整（去重未产生新任务，含取消）');

/* ---------- 项目 C：发布申请的自动失效（警告变化/阻断重现/新提交）与并发审核一致 ---------- */
console.log('项目 C：发布申请失效与并发审核');
const { data: createdC } = await j('POST', '/api/projects', { name: '审批失效与并发', author: 'alice' });
const pidC = createdC.project.id;
const cueC1 = { id: 'd1', trackId: 't_main', start: 1000, end: 3000, text: '完全正常的一句对白内容', locked: false };
const cueC2 = { id: 'd2', trackId: 't_main', start: 3200, end: 5200, text: '另一句同样完全正常的对白', locked: false };
const revC1 = await submit(pidC, createdC.revision.id, { ...createdC.revision.snapshot, cues: [cueC1, cueC2] }, 'alice', '种子');

async function setRulesC(pid, cfg) {
  const defaults = {
    duration: { enabled: false, severity: 'blocker', params: { minMs: 500, maxMs: 10000 } },
    cps: { enabled: false, severity: 'warning', params: { maxCps: 20 } },
    line_chars: { enabled: false, severity: 'warning', params: { maxChars: 42 } },
    gap: { enabled: false, severity: 'warning', params: { minGapMs: 500 } },
    align: { enabled: false, severity: 'warning', params: { toleranceMs: 120, trackA: '', trackB: '' } },
  };
  await j('PUT', `/api/projects/${pid}/qc/rules`, { trackId: '', author: 'alice', rules: { ...defaults, ...cfg } });
}
await setRulesC(pidC, { gap: { enabled: true, severity: 'warning', params: { minGapMs: 500 } } });
const jobC1 = await waitJob(pidC, (await j('POST', `/api/projects/${pidC}/qc/jobs`, { revisionId: revC1.id, author: 'alice' })).data.job.id);
const fC1 = (await j('GET', `/api/projects/${pidC}/qc/jobs/${jobC1.id}/findings`)).data.findings;
ok(fC1.length === 1 && fC1[0].severity === 'warning', 'C 基线：仅 1 条警告（间隔不足）');
const preC1 = (await j('GET', `/api/projects/${pidC}/releases/preflight?revisionId=${revC1.id}`)).data;
ok(preC1.canPublish === true && preC1.warningsPending.length === 1, 'C 预检通过，1 条警告待确认');

// ① 警告确认变化 → 待处理申请自动失效
const reqC1 = (await j('POST', `/api/projects/${pidC}/release-requests`, {
  revisionId: revC1.id, author: 'alice', confirmations: preC1.warningsPending.map((w) => w.id),
})).data.request.id;
await j('POST', `/api/projects/${pidC}/qc/findings/decide`, {
  findingIds: [fC1[0].id], action: 'ignore', reason: '接受该间隔', baseRevId: revC1.id, author: 'alice',
});
const gotC1 = (await j('GET', `/api/projects/${pidC}/release-requests`)).data.requests.find((q) => q.id === reqC1);
ok(gotC1.status === 'invalidated' && gotC1.invalid_reason === 'warnings-changed',
  '警告确认项变化 → 申请读取时自动失效', JSON.stringify({ s: gotC1.status, r: gotC1.invalid_reason }));
ok((await j('POST', `/api/release-requests/${reqC1}/approve`, { author: 'rev' })).status === 409
  && (await j('POST', `/api/projects/${pidC}/releases`, { requestId: reqC1, author: 'alice' })).status === 409,
  '失效申请既不能审核也不能发布');

// ② 阻断问题重新出现 → 已批准申请自动失效
const preC2 = (await j('GET', `/api/projects/${pidC}/releases/preflight?revisionId=${revC1.id}`)).data;
ok(preC2.canPublish === true && preC2.warningsPending.length === 0, '警告被忽略后预检仍通过');
const reqC2 = (await j('POST', `/api/projects/${pidC}/release-requests`, {
  revisionId: revC1.id, author: 'alice', confirmations: [],
})).data.request.id;
ok((await j('POST', `/api/release-requests/${reqC2}/approve`, { author: 'rev1', comment: '同意' })).status === 200, 'C 申请已批准');
await setRulesC(pidC, {
  gap: { enabled: true, severity: 'warning', params: { minGapMs: 500 } },
  duration: { enabled: true, severity: 'blocker', params: { minMs: 500, maxMs: 1000 } },
});
await waitJob(pidC, (await j('POST', `/api/projects/${pidC}/qc/jobs`, { revisionId: revC1.id, author: 'alice' })).data.job.id);
const gotC2 = (await j('GET', `/api/projects/${pidC}/release-requests`)).data.requests.find((q) => q.id === reqC2);
ok(gotC2.status === 'invalidated' && gotC2.invalid_reason === 'blockers-changed',
  '阻断问题重新出现 → 已批准申请自动失效', JSON.stringify({ s: gotC2.status, r: gotC2.invalid_reason }));
ok((await j('POST', `/api/projects/${pidC}/releases`, { requestId: reqC2, author: 'alice' })).status === 409,
  '批准后预检变化不能发布，需重新申请');

// ③ 版本产生新提交 → 提交钩子自动失效
await setRulesC(pidC, {}); // 全部规则关闭
// 旧质检产生的阻断结果仍需重新处理（规则关闭不会改写历史结果）
const jobC3 = await waitJob(pidC, (await j('POST', `/api/projects/${pidC}/qc/jobs`, { revisionId: revC1.id, author: 'alice' })).data.job.id);
const fC3Open = (await j('GET', `/api/projects/${pidC}/qc/jobs/${jobC3.id}/findings`)).data.findings
  .filter((x) => ['open', 'stale'].includes(x.status));
if (fC3Open.length) {
  await j('POST', `/api/projects/${pidC}/qc/findings/decide`, {
    findingIds: fC3Open.map((x) => x.id), action: 'ignore', reason: '规则已关闭，保留', baseRevId: revC1.id, author: 'alice',
  });
}
const preC3 = (await j('GET', `/api/projects/${pidC}/releases/preflight?revisionId=${revC1.id}`)).data;
ok(preC3.canPublish === true && preC3.blockerUnhandled.length === 0 && preC3.warningsPending.length === 0, '阻断重新处理后预检通过');
const reqC3 = (await j('POST', `/api/projects/${pidC}/release-requests`, {
  revisionId: revC1.id, author: 'alice', confirmations: [],
})).data.request.id;
await j('POST', `/api/release-requests/${reqC3}/approve`, { author: 'rev1' });
const snapC2 = JSON.parse(JSON.stringify(revC1.snapshot));
snapC2.cues.push({ id: 'd9', trackId: 't_main', start: 9000, end: 11000, text: '后来追加的句子', locked: false });
const revC2 = await submit(pidC, revC1.id, snapC2, 'carol', '申请后追加提交');
const gotC3 = (await j('GET', `/api/projects/${pidC}/release-requests`)).data.requests.find((q) => q.id === reqC3);
ok(gotC3.status === 'invalidated' && gotC3.invalid_reason === 'new-revision',
  '版本产生新提交 → 已批准申请由提交钩子自动失效', JSON.stringify({ s: gotC3.status, r: gotC3.invalid_reason }));
const preC4 = (await j('GET', `/api/projects/${pidC}/releases/preflight?revisionId=${revC2.id}`)).data;
ok(preC4.canPublish === false && preC4.job === null, '新版本尚未质检，预检不通过');
ok((await j('POST', `/api/projects/${pidC}/release-requests`, { revisionId: revC2.id, author: 'alice', confirmations: [] })).status === 400,
  '预检不通过时新申请被拒绝');

// ④ 并发审核：批准与驳回同时到达，只有一个生效，状态唯一确定
await waitJob(pidC, (await j('POST', `/api/projects/${pidC}/qc/jobs`, { revisionId: revC2.id, author: 'alice' })).data.job.id);
const preC5 = (await j('GET', `/api/projects/${pidC}/releases/preflight?revisionId=${revC2.id}`)).data;
ok(preC5.canPublish === true, '新版本质检后预检通过');
const reqC4 = (await j('POST', `/api/projects/${pidC}/release-requests`, {
  revisionId: revC2.id, author: 'alice', confirmations: preC5.warningsPending.map((w) => w.id),
})).data.request.id;
const race = await Promise.all([
  j('POST', `/api/release-requests/${reqC4}/approve`, { author: 'race-approver' }),
  j('POST', `/api/release-requests/${reqC4}/reject`, { author: 'race-rejecter', comment: '并发驳回' }),
]);
const codes = race.map((r) => r.status).sort();
ok(codes[0] === 200 && codes[1] === 409, '并发审核：只有一个成功，另一个 409', JSON.stringify(codes));
const winner = race.find((r) => r.status === 200);
const loserMsg = race.find((r) => r.status === 409).data.error;
ok(/已被其他审核人|不能重复审核|已批准|已驳回/.test(loserMsg), '失败方收到并发冲突提示', loserMsg);
const finC4 = (await j('GET', `/api/projects/${pidC}/release-requests`)).data.requests.find((q) => q.id === reqC4);
ok((finC4.status === 'approved' && finC4.reviewer === 'race-approver')
  || (finC4.status === 'rejected' && finC4.reviewer === 'race-rejecter'),
  '并发后状态唯一确定，署名与最终状态一致', JSON.stringify({ s: finC4.status, by: finC4.reviewer }));
ok((await j('POST', `/api/release-requests/${reqC4}/approve`, { author: 'late' })).status === 409, '终态后再次审核被拒绝');

// ⑤ 页面记录状态齐全：在后续新版本上依次制造 已发布 / 已驳回 / 已批准 / 待处理
// （并发的 reqC4：胜者为批准则直接发布；胜者为驳回则重新申请→批准→发布）
let reqToPublish = reqC4;
if (finC4.status === 'rejected') {
  const again = await j('POST', `/api/projects/${pidC}/release-requests`, {
    revisionId: revC2.id, author: 'alice', confirmations: preC5.warningsPending.map((w) => w.id),
  });
  ok(again.status === 201, '并发驳回后可重新申请');
  await j('POST', `/api/release-requests/${again.data.request.id}/approve`, { author: 'rev2' });
  reqToPublish = again.data.request.id;
}
const pubC0 = await j('POST', `/api/projects/${pidC}/releases`, { requestId: reqToPublish, author: 'alice' });
ok(pubC0.status === 201 && pubC0.data.release.qc_summary.approvedBy, '批准申请发布成功，摘要含审批人');
// 已发布版本再申请 → 被唯一门禁拒绝（同版本已有 published 快照）
const reqAfterPub = await j('POST', `/api/projects/${pidC}/release-requests`, {
  revisionId: revC2.id, author: 'alice', confirmations: preC5.warningsPending.map((w) => w.id),
});
ok(reqAfterPub.status === 400, '已发布版本不能再次申请', reqAfterPub.data?.error);

// 新版本 revC3：一条驳回记录
const snapC3 = JSON.parse(JSON.stringify(revC2.snapshot));
snapC3.cues[0].text = '微调第一句';
const revC3 = await submit(pidC, revC2.id, snapC3, 'alice', '微调');
await waitJob(pidC, (await j('POST', `/api/projects/${pidC}/qc/jobs`, { revisionId: revC3.id, author: 'alice' })).data.job.id);
const preC6 = (await j('GET', `/api/projects/${pidC}/releases/preflight?revisionId=${revC3.id}`)).data;
ok(preC6.canPublish === true, 'revC3 预检通过');
const reqC5 = (await j('POST', `/api/projects/${pidC}/release-requests`, {
  revisionId: revC3.id, author: 'alice', confirmations: preC6.warningsPending.map((w) => w.id),
})).data.request;
ok((await j('POST', `/api/release-requests/${reqC5.id}/reject`, { author: 'rev2', comment: '材料不齐' })).status === 200, '驳回记录留痕');
// 重复提交幂等保护：reqC5 已驳回，可重新申请
const reqC6 = (await j('POST', `/api/projects/${pidC}/release-requests`, {
  revisionId: revC3.id, author: 'alice', confirmations: preC6.warningsPending.map((w) => w.id),
})).data.request;
// 再重复一次：命中进行中申请，幂等返回同一记录
const reqC6Dup = await j('POST', `/api/projects/${pidC}/release-requests`, {
  revisionId: revC3.id, author: 'bob', confirmations: preC6.warningsPending.map((w) => w.id),
});
ok(reqC6Dup.status === 200 && reqC6Dup.data.request.id === reqC6.id, '重复提交幂等返回同一申请');

// 新版本 revC4：留一条待处理申请（新提交会把此前的待处理申请失效，故先建版本）
const snapC4 = JSON.parse(JSON.stringify(revC3.snapshot));
snapC4.cues.push({ id: 'd10', trackId: 't_main', start: 20000, end: 22000, text: '又一句追加', locked: false });
const revC4 = await submit(pidC, revC3.id, snapC4, 'alice', '再追加');
await waitJob(pidC, (await j('POST', `/api/projects/${pidC}/qc/jobs`, { revisionId: revC4.id, author: 'alice' })).data.job.id);

// 此时批准旧版本 revC3 上的 reqC6：它已被新提交失效，批准应被拒绝
const apprStale = await j('POST', `/api/release-requests/${reqC6.id}/approve`, { author: 'rev2', comment: '晚到的批准' });
ok(apprStale.status === 409 && apprStale.data.invalidated === true, '新提交后批准旧申请被拒绝（已自动失效）');
// 重新申请 revC3 并批准——revC3 不是 HEAD，只要预检通过且指纹不变即可
const preC6b = (await j('GET', `/api/projects/${pidC}/releases/preflight?revisionId=${revC3.id}`)).data;
const reqC6b = (await j('POST', `/api/projects/${pidC}/release-requests`, {
  revisionId: revC3.id, author: 'alice', confirmations: preC6b.warningsPending.map((w) => w.id),
})).data.request;
ok((await j('POST', `/api/release-requests/${reqC6b.id}/approve`, { author: 'rev2', comment: '同意' })).status === 200, '重新申请后批准记录留痕');

// revC4 上留一条待处理申请
const preC7 = (await j('GET', `/api/projects/${pidC}/releases/preflight?revisionId=${revC4.id}`)).data;
const reqC8 = (await j('POST', `/api/projects/${pidC}/release-requests`, {
  revisionId: revC4.id, author: 'alice', confirmations: preC7.warningsPending.map((w) => w.id),
})).data.request;
ok(reqC8.status === 'pending', '留下一条待处理申请');

const listCAll = (await j('GET', `/api/projects/${pidC}/release-requests`)).data.requests;
for (const [s, label] of [['pending', '待处理'], ['approved', '已批准'], ['rejected', '已驳回'], ['invalidated', '已失效'], ['published', '已发布']]) {
  ok(listCAll.some((q) => q.status === s), `审批记录列表含「${label}」状态`);
}
// 待处理申请展示申请人/时间；已批准展示审核人/意见/时间
const pendingRow = listCAll.find((q) => q.status === 'pending');
const approvedRow = listCAll.find((q) => q.status === 'approved');
ok(pendingRow.applicant === 'alice' && pendingRow.created_at > 0 && !pendingRow.reviewer, '待处理记录含申请人署名与时间');
ok(approvedRow.reviewer === 'rev2' && approvedRow.review_comment === '同意' && approvedRow.reviewed_at > 0, '已批准记录含审核人/意见/时间');

// 失效事件同样写审计（含新提交、警告变化、阻断重现三类原因）
const auditC = (await j('GET', `/api/projects/${pidC}/audit?limit=2000`)).data.audit;
const invalidateRows = auditC.filter((a) => a.action === 'relreq-invalidate');
ok(invalidateRows.length >= 4, '申请失效全部写入审计', String(invalidateRows.length));
ok(new Set(invalidateRows.map((a) => (a.new_value.match(/invalidated:([a-z-]+)/) || [])[1]))
  .has('new-revision'), '审计可区分 new-revision 失效原因');

console.log(failures === 0 ? '\n质检与发布快照端到端全部通过 ✓' : `\n存在 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
