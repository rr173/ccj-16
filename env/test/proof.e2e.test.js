// 端到端：分段协作校对（HTTP）
// 创建批次（历史版本/冻结/切片）→ 领取并发一方成功 → 草稿/提交 → 退回重提
// → HEAD 推进后一次接受多片段：冲突逐段报告、携带选择合入一个新版本 → 过滤/待办/事件
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

async function submit(pid, baseRevId, snapshot, author, message) {
  const r = await j('POST', `/api/projects/${pid}/revisions`, { baseRevId, snapshot, author, message });
  if (r.status !== 201) throw new Error('提交失败：' + JSON.stringify(r.data));
  return r.data.revision;
}

/* ---------- 项目与历史版本 ---------- */
console.log('分段协作校对：端到端');
const { data: created } = await j('POST', '/api/projects', { name: '协作校对E2E', author: '组织者' });
const pid = created.project.id;
const rev0 = created.revision;
const tracks = [{ id: 't_main', name: '主轨', color: '#4e8cff', mutexGroup: null }];
const cue = (id, start, end, text) => ({ id, trackId: 't_main', start, end, text, locked: false });
const snap = (cues) => ({ ...rev0.snapshot, tracks, cues });

const cues1 = [
  cue('c1', 0, 1500, '第一句'),
  cue('c2', 2000, 3500, '第二句'),
  cue('c3', 20000, 21500, '第三句'),
  cue('c4', 22000, 23500, '第四句'),
];
const rev1 = await submit(pid, rev0.id, snap(cues1), '组织者', '基准版');
// HEAD 再往前走：改 c1（与审校稿将冲突）、c4 不动
const rev2 = await submit(pid, rev1.id, snap(cues1.map((c) => c.id === 'c1' ? cue('c1', 0, 1500, '第一句-HEAD') : c)), '其他人', 'HEAD 改第一句');

/* ---------- 创建批次 ---------- */
let r = await j('POST', `/api/projects/${pid}/proof/batches`, { author: '组织者' });
ok(r.status === 400, '缺少基准版本被拒绝');
r = await j('POST', `/api/projects/${pid}/proof/batches`, {
  revisionId: rev1.id, title: 'E2E批次', gapMs: 2000, maxSegmentMs: 8000, ttlMs: 3600000, author: '组织者',
});
ok(r.status === 201 && r.data.batch.id, '从历史版本 rev1 创建批次');
const bid = r.data.batch.id;
r = await j('GET', `/api/projects/${pid}/proof/batches/${bid}`);
const segs = r.data.segments;
ok(segs.length === 2 && segs[0].cueIds.join() === 'c1,c2' && segs[1].cueIds.join() === 'c3,c4',
  `自动切成 2 段（${segs.map((s) => s.cueIds.join()).join(' | ')}）`);
ok(segs.every((s) => s.status === 'unclaimed') && r.data.batch.progress.counts.unclaimed === 2, '初始状态全部未领取');
ok(segs[0].baseChanged === true && segs[1].baseChanged === false, '逐段标注基准句是否已在 HEAD 变化');

/* ---------- 并发领取只有一方成功 ---------- */
const [A, B] = segs;
const [ra, rb] = await Promise.all([
  j('POST', `/api/proof/segments/${A.id}/claim`, { reviewer: '甲', clientToken: 'claim-A' }),
  j('POST', `/api/proof/segments/${A.id}/claim`, { reviewer: '乙', clientToken: 'claim-B' }),
]);
ok(ra.status === 201 && ra.data.segment.assignee === '甲', '并发领取：甲成功');
ok(rb.status === 409 && rb.data.code === 'already-claimed', '并发领取：乙失败（只有一方成功）');
// 甲重复领取幂等
const ra2 = await j('POST', `/api/proof/segments/${A.id}/claim`, { reviewer: '甲', clientToken: 'claim-A' });
ok(ra2.status === 200 && ra2.data.deduplicated, '同令牌重复领取幂等 200');

/* ---------- 片段详情与草稿 ---------- */
let det = (await j('GET', `/api/proof/segments/${A.id}?viewer=甲`)).data.segment;
ok(det.baseline.length === 2 && det.currentDraft === null, '详情含基准内容，未保存时无当前草稿');
const baseA = det.baseline.map((x) => x.cue);
let dr = await j('PUT', `/api/proof/segments/${A.id}/draft`, {
  reviewer: '甲', content: baseA.map((c) => c.id === 'c1' ? { ...c, text: '第一句-校对' } : c),
  baseVersion: 0, clientToken: 'draft-A-1',
});
ok(dr.status === 200 && dr.data.draftVersion === 1, '保存草稿成功');
const drDup = await j('PUT', `/api/proof/segments/${A.id}/draft`, {
  reviewer: '甲', content: baseA.map((c) => c.id === 'c1' ? { ...c, text: '第一句-校对' } : c),
  baseVersion: 0, clientToken: 'draft-A-1',
});
ok(drDup.status === 200 && drDup.data.deduplicated, '草稿重复请求幂等');
const drStale = await j('PUT', `/api/proof/segments/${A.id}/draft`, {
  reviewer: '甲', content: baseA, baseVersion: 0,
});
ok(drStale.status === 409 && drStale.data.code === 'version-conflict', '乐观锁失配返回 409');
// 非本人不能看草稿内容
const detB = (await j('GET', `/api/proof/segments/${A.id}?viewer=乙`)).data.segment;
ok(detB.currentDraft === null && detB.mine === false, '其他人看不到甲的草稿内容');

/* ---------- 提交 / 退回 / 再次提交 ---------- */
let sr = await j('POST', `/api/proof/segments/${A.id}/submit`, { reviewer: '甲', clientToken: 'sub-A-1' });
ok(sr.status === 201 && sr.data.segment.status === 'review', '提交进入待审核');
const srDup = await j('POST', `/api/proof/segments/${A.id}/submit`, { reviewer: '甲', clientToken: 'sub-A-1' });
ok(srDup.status === 200 && srDup.data.deduplicated, '提交重复请求不产生重复提交');
const noEdit = await j('PUT', `/api/proof/segments/${A.id}/draft`, { reviewer: '甲', content: baseA, baseVersion: 1 });
ok(noEdit.status === 409 && noEdit.data.code === 'in-review', '待审核片段不能再编辑');
const noClaim = await j('POST', `/api/proof/segments/${A.id}/claim`, { reviewer: '乙' });
ok(noClaim.status === 409 && noClaim.data.code === 'in-review', '待审核片段不能被领取');
const retNoReason = await j('POST', `/api/proof/segments/${A.id}/return`, { author: '组织者' });
ok(retNoReason.status === 400, '退回无理由被拒绝');
const ret = await j('POST', `/api/proof/segments/${A.id}/return`, { reason: '术语请统一', author: '组织者' });
ok(ret.status === 200 && ret.data.segment.status === 'returned' && ret.data.segment.returnReason === '术语请统一'
  && ret.data.segment.claimExpiresAt > Date.now(), '退回附理由并给新一轮有效期');
// 修改后再次提交
const retSave = await j('PUT', `/api/proof/segments/${A.id}/draft`, {
  reviewer: '甲',
  content: baseA.map((c) => c.id === 'c1' ? { ...c, text: '第一句-校对改' } : c),
  baseVersion: 1, clientToken: 'draft-A-2',
});
ok(retSave.status === 200, '退回后可继续保存草稿');
const sr2 = await j('POST', `/api/proof/segments/${A.id}/submit`, { reviewer: '甲', clientToken: 'sub-A-2' });
ok(sr2.status === 201 && sr2.data.submission.seq === 2, '再次提交生成第 2 条提交记录');

/* ---------- 第二个片段：乙领取、提交（c3 改动可自动合入，c4 与基准相同）---------- */
await j('POST', `/api/proof/segments/${B.id}/claim`, { reviewer: '乙', clientToken: 'claim-B' });
const detB2 = (await j('GET', `/api/proof/segments/${B.id}?viewer=乙`)).data.segment;
await j('PUT', `/api/proof/segments/${B.id}/draft`, {
  reviewer: '乙',
  content: detB2.baseline.map((x) => x.cue).map((c) => c.id === 'c3' ? { ...c, text: '第三句-校对' } : c),
  baseVersion: 0, clientToken: 'draft-B-1',
});
await j('POST', `/api/proof/segments/${B.id}/submit`, { reviewer: '乙', clientToken: 'sub-B-1' });

/* ---------- 一次接受多片段：先冲突 409 且不写入，再携带逐段选择合入 ---------- */
const headBefore = (await j('GET', `/api/projects/${pid}`)).data.project.head_id;
const conf = await j('POST', `/api/projects/${pid}/proof/accept`, {
  batchId: bid, segmentIds: [A.id, B.id], author: '组织者', clientToken: 'accept-1',
});
ok(conf.status === 409 && conf.data.code === 'conflicts', '存在冲突：整体拒绝');
const rep = conf.data.report;
ok(Array.isArray(rep) && rep.length === 2, '逐段报告（2 段）');
const repA = rep.find((x) => x.segmentId === A.id);
const repB = rep.find((x) => x.segmentId === B.id);
ok(repA.result === 'conflict' && repA.conflicts.some((c) => c.cueId === 'c1')
  && repA.conflicts[0].fields.some((f) => f.field === 'text'), 'A 段：c1 文本双方修改，给出 base/mine/theirs');
ok(repB.result === 'auto' && repB.changedCueIds.join() === 'c3', 'B 段：c3 可自动合入');
const headMid = (await j('GET', `/api/projects/${pid}`)).data.project.head_id;
ok(headMid === headBefore, '冲突时未产生新版本（不能部分写入）');

const acc = await j('POST', `/api/projects/${pid}/proof/accept`, {
  batchId: bid,
  segmentIds: [A.id, B.id],
  resolutions: { [A.id]: { c1: 'mine' } },
  author: '组织者', message: '一次接受两段', clientToken: 'accept-2',
});
ok(acc.status === 201 && acc.data.revision.kind === 'proof', '冲突解决后接受成功，生成新版本');
const head = (await j('GET', `/api/projects/${pid}`)).data.head;
const byId = Object.fromEntries(head.snapshot.cues.map((c) => [c.id, c]));
ok(byId.c1.text === '第一句-校对改', 'c1 采用审校稿 mine');
ok(byId.c3.text === '第三句-校对', 'c3 自动合入');
ok(byId.c4.text === '第四句', 'c4 保持基准');
ok(byId.c2.text === '第二句', '未改动句不变');
const after = (await j('GET', `/api/projects/${pid}/proof/batches/${bid}`)).data;
ok(after.segments.every((s) => s.status === 'merged') && after.batch.status === 'completed',
  '两段已合入，批次完成');
// 接受令牌幂等：片段已 merged，重发返回同一版本而非报错
const accDup = await j('POST', `/api/projects/${pid}/proof/accept`, {
  batchId: bid, segmentIds: [A.id, B.id], author: '组织者', clientToken: 'accept-2',
});
ok(accDup.status === 200 && accDup.data.deduplicated && accDup.data.revisionId === acc.data.revision.id,
  '接受请求重发幂等，不产生第二个版本');

/* ---------- 过滤 / 待办 / 事件 ---------- */
const fMerged = await j('GET', `/api/projects/${pid}/proof/batches/${bid}?status=merged&viewer=甲`);
ok(fMerged.data.segments.length === 2, '按状态过滤（已合入）');
const fPerson = await j('GET', `/api/projects/${pid}/proof/batches/${bid}?assignee=乙`);
ok(fPerson.data.segments.length === 1 && fPerson.data.segments[0].assignee === '乙', '按人员过滤');
// 个人待办：用一个新批次让甲持有编辑中片段
const nb = await j('POST', `/api/projects/${pid}/proof/batches`, {
  revisionId: head.id, title: '待办批', gapMs: 2000, maxSegmentMs: 8000, ttlMs: 3600000, author: '组织者',
});
const nseg = nb.data.batch.id ? (await j('GET', `/api/projects/${pid}/proof/batches/${nb.data.batch.id}`)).data.segments : [];
await j('POST', `/api/proof/segments/${nseg[0].id}/claim`, { reviewer: '甲' });
const todos = (await j('GET', `/api/proof/todos?reviewer=甲&projectId=${pid}`)).data;
ok(todos.todos.editing.some((s) => s.id === nseg[0].id), '个人待办：编辑中片段');
const events = (await j('GET', `/api/projects/${pid}/proof/events?batchId=${bid}`)).data.events;
ok(events.length >= 10 && events.every((e, i) => i === 0 || e.id >= events[i - 1].id), '事件流存在且顺序一致');

/* ---------- 指派 / 续期 / 释放 HTTP 路径 ---------- */
const asg = await j('POST', `/api/proof/segments/${nseg[0].id}/assign`, { assignee: '丙', author: '组织者' });
ok(asg.status === 200 && asg.data.reassigned && asg.data.segment.assignee === '丙', '组织者重新指派');
const rn = await j('POST', `/api/proof/segments/${nseg[0].id}/renew`, { reviewer: '丙', clientToken: 'renew-1' });
ok(rn.status === 200 && rn.data.segment.claimExpiresAt, '续期成功并返回新到期时间');
const rel = await j('POST', `/api/proof/segments/${nseg[0].id}/release`, { reviewer: '丙', clientToken: 'release-1' });
ok(rel.status === 200 && rel.data.segment.status === 'unclaimed', '主动释放后回到未领取');

if (failures) {
  console.log(`\n协作校对端到端测试失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n分段协作校对：端到端全部通过');
