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

// 发布门禁：阻断未处理 → 不能发布
const pre0 = await j('GET', `/api/projects/${pid}/releases/preflight?revisionId=${rev1.id}`);
ok(pre0.data.canPublish === false && pre0.data.blockerUnhandled.length === 2, '预检：阻断未处理不可发布');
const pubEarly = await j('POST', `/api/projects/${pid}/releases`, { revisionId: rev1.id, author: 'alice', confirmations: [] });
ok(pubEarly.status === 400, '阻断未处理时发布被拒绝');

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

// 发布：警告需逐项确认
const pre1 = (await j('GET', `/api/projects/${pid}/releases/preflight?revisionId=${rev3.id}`)).data;
ok(pre1.canPublish === true && pre1.warningsPending.length === 2, '预检通过，2 条警告待确认');
const pubNoConfirm = await j('POST', `/api/projects/${pid}/releases`, { revisionId: rev3.id, author: 'alice', confirmations: [] });
ok(pubNoConfirm.status === 400 && pubNoConfirm.data.missing.length === 2, '未逐项确认警告不能发布');
const pub1 = await j('POST', `/api/projects/${pid}/releases`, {
  revisionId: rev3.id, author: 'alice', confirmations: pre1.warningsPending.map((w) => w.id), message: '首发',
});
ok(pub1.status === 201 && pub1.data.release.label === 'REL-001', '发布成功，生成唯一标识 REL-001');
const rel1 = pub1.data.release;
ok(rel1.snapshot.cues.length === 5 && rel1.rules_snapshot[''].duration.severity === 'blocker' && rel1.qc_summary.jobId === job2.id,
  '快照冻结句子/规则配置/质检摘要');
ok(rel1.files.srt.all.includes('00:00:08,000 --> 00:00:18,000') && rel1.files.vtt.all.startsWith('WEBVTT'), '快照内含 SRT/VTT 文件');

// 重复发布同一版本 → 不产生重复快照
const pubDup = await j('POST', `/api/projects/${pid}/releases`, {
  revisionId: rev3.id, author: 'bob', confirmations: [], message: '重复',
});
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
const pub2 = await j('POST', `/api/projects/${pid}/releases`, {
  revisionId: rev3.id, author: 'alice', confirmations: [], message: '重发',
});
ok(pub2.status === 201 && pub2.data.release.label === 'REL-002' && pub2.data.release.id !== rel1.id, '撤销后可重新发布（新标识）');

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
const audit = (await j('GET', `/api/projects/${pid}/audit?limit=500`)).data.audit.map((a) => a.action);
for (const act of ['qc-rule', 'qc-run', 'qc-done', 'qc-fix', 'qc-ignore', 'qc-stale', 'qc-confirm', 'publish', 'withdraw']) {
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

console.log(failures === 0 ? '\n质检与发布快照端到端全部通过 ✓' : `\n存在 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
