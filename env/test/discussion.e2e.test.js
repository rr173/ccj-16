// 讨论串端到端（直接针对运行中的服务）：
// 创建（cue/range）→ 回复幂等 → 解决/重开 → 提交新版本后跟随/orphan → 人工重新定位
//   → 乐观锁冲突 → 合并提交也跟随 → 状态变化与定位历史可查 → 审计留痕
const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
function ok(cond, name, extra = '') {
  console.log(cond ? '  ✓' : '  ✗', name, cond ? '' : extra);
  if (!cond) failures++;
}
async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
async function submit(pid, baseRevId, snapshot, author, message) {
  const r = await j('POST', `/api/projects/${pid}/revisions`, { baseRevId, snapshot, author, message });
  if (r.status !== 201) throw new Error('提交失败：' + JSON.stringify(r.data));
  return r.data.revision;
}

console.log('讨论串：端到端');

/* ---------- 准备项目与含 4 句的版本 ---------- */
const { data: created } = await j('POST', '/api/projects', { name: '讨论E2E', author: 'alice' });
const pid = created.project.id;
const rev0 = created.revision;
const snap1 = {
  ...rev0.snapshot,
  cues: [
    { id: 'c1', trackId: 't_main', start: 0, end: 1500, text: '第一句内容', locked: false },
    { id: 'c2', trackId: 't_main', start: 2000, end: 3500, text: '第二句内容', locked: false },
    { id: 'c3', trackId: 't_main', start: 4000, end: 5000, text: '要删除的句子', locked: false },
    { id: 'c4', trackId: 't_main', start: 6000, end: 7000, text: '要拆分的句子内容', locked: false },
  ],
};
const rev1 = await submit(pid, rev0.id, snap1, 'alice', '第一版');

/* ---------- 创建：挂在单句上 ---------- */
let r = await j('POST', `/api/projects/${pid}/discussions`, {
  anchorType: 'cue', cueId: 'c1', title: '这里怎么翻', body: '第一句这个词有歧义', author: 'bob', clientToken: 'tok-create-1',
});
ok(r.status === 201, '在单句上创建讨论', JSON.stringify(r.data));
const d1 = r.data.thread.thread.id;

r = await j('POST', `/api/projects/${pid}/discussions`, {
  anchorType: 'cue', cueId: 'c1', body: '第一句这个词有歧义', author: 'bob', clientToken: 'tok-create-1',
});
ok(r.status === 200 && r.data.thread.thread.id === d1, '重复创建请求幂等返回原讨论');

r = await j('POST', `/api/projects/${pid}/discussions`, { anchorType: 'cue', cueId: 'cX', body: 'x', author: 'bob' });
ok(r.status === 400, '锚点句子不存在时拒绝创建');

/* ---------- 创建：时间范围 ---------- */
r = await j('POST', `/api/projects/${pid}/discussions`, {
  anchorType: 'range', start: 3000, end: 5000, trackId: 't_main',
  body: '这段间隙是不是太短', author: 'carol', clientToken: 'tok-create-2',
});
ok(r.status === 201, '在时间范围上创建讨论');
const d2 = r.data.thread.thread.id;

/* ---------- 回复：幂等（重复请求不产生重复回复） ---------- */
r = await j('POST', `/api/projects/${pid}/discussions/${d1}/messages`, { body: '   ', author: 'bob' });
ok(r.status === 400, '空回复被拒绝');

r = await j('POST', `/api/projects/${pid}/discussions/${d1}/messages`, {
  body: '我觉得应该这样', author: 'carol', clientToken: 'tok-reply-1',
});
ok(r.status === 201 && r.data.thread.thread.version === 1, '首次回复成功（version 递增）');
r = await j('POST', `/api/projects/${pid}/discussions/${d1}/messages`, {
  body: '我觉得应该这样', author: 'carol', clientToken: 'tok-reply-1',
});
ok(r.status === 200 && r.data.thread.thread.version === 1, '同令牌重复回复不产生重复消息');

// 并发两条不同回复：一条成功，一条乐观锁冲突，重试后两条消息都在
const [a, b] = await Promise.all([
  j('POST', `/api/projects/${pid}/discussions/${d1}/messages`, {
    body: '并发回复 A', author: 'a', expectedVersion: 1, clientToken: 'tok-reply-a',
  }),
  j('POST', `/api/projects/${pid}/discussions/${d1}/messages`, {
    body: '并发回复 B', author: 'b', expectedVersion: 1, clientToken: 'tok-reply-b',
  }),
]);
ok(a.status === 201 && b.status === 409, '并发回复：一条成功一条乐观锁冲突（不覆盖）');
const retry = await j('POST', `/api/projects/${pid}/discussions/${d1}/messages`, {
  body: '并发回复 B', author: 'b', expectedVersion: 2, clientToken: 'tok-reply-b2',
});
ok(retry.status === 201, '冲突方刷新版本后重试成功（消息不丢）');
const d1detail = (await j('GET', `/api/projects/${pid}/discussions/${d1}`)).data;
const msgBodies = d1detail.events.filter((e) => e.kind === 'message').map((e) => e.body).sort();
ok(JSON.stringify(msgBodies) === JSON.stringify(['并发回复 A', '并发回复 B', '我觉得应该这样']),
  '三条回复全部保留（并发提交的落库顺序以服务端事务为准，消息不丢）');
ok(d1detail.events[0].kind === 'create', '首条事件为创建，其后按时间排列状态/定位/回复事件');

/* ---------- 解决 / 重新打开（含并发状态竞争） ---------- */
r = await j('POST', `/api/projects/${pid}/discussions/${d1}/resolve`, { author: 'bob', clientToken: 'tok-r1' });
ok(r.status === 200 && r.data.thread.thread.status === 'resolved', '解决讨论');
r = await j('POST', `/api/projects/${pid}/discussions/${d1}/resolve`, { author: 'bob', clientToken: 'tok-r1' });
ok(r.data.thread.thread.status === 'resolved', '重复解决请求幂等');
r = await j('POST', `/api/projects/${pid}/discussions/${d1}/reopen`, { author: 'alice', reason: '还有问题', clientToken: 'tok-o1' });
ok(r.status === 200 && r.data.thread.thread.status === 'open', '重新打开讨论');

// 并发解决 vs 重新打开：条件更新保证只有一个生效，另一个失配 409，最终状态确定
{
  const cur = (await j('GET', `/api/projects/${pid}/discussions/${d1}`)).data.thread.version;
  const [x, y] = await Promise.all([
    j('POST', `/api/projects/${pid}/discussions/${d1}/resolve`, { author: 'x', expectedVersion: cur, clientToken: 'tok-race-res' }),
    j('POST', `/api/projects/${pid}/discussions/${d1}/reopen`, { author: 'y', expectedVersion: cur, clientToken: 'tok-race-reo' }),
  ]);
  const codes = [x.status, y.status].sort().join(',');
  ok(codes === '200,409', `并发解决/重开：一个生效一个冲突（实际 ${codes}）`);
  const final = (await j('GET', `/api/projects/${pid}/discussions/${d1}`)).data.thread;
  ok(['open', 'resolved'].includes(final.status), '最终状态确定，未出现覆盖不一致');
  if (final.status === 'resolved') {
    await j('POST', `/api/projects/${pid}/discussions/${d1}/reopen`, { author: 'alice', clientToken: 'tok-o2' });
  }
}

/* ---------- 提交新版本：跟随 / orphan ---------- */
const { data: dDel } = await j('POST', `/api/projects/${pid}/discussions`, {
  anchorType: 'cue', cueId: 'c3', body: '这句要删了讨论怎么办', author: 'a', clientToken: 'tok-create-c3',
});
const d3id = dDel.thread.thread.id;
const { data: dSplit } = await j('POST', `/api/projects/${pid}/discussions`, {
  anchorType: 'cue', cueId: 'c4', body: '拆成两句的讨论', author: 'a', clientToken: 'tok-create-c4',
});
const d4id = dSplit.thread.thread.id;

const snap2 = {
  ...snap1,
  cues: [
    { id: 'c1', trackId: 't_main', start: 100, end: 1600, text: '第一句内容（修订）', locked: false },
    { id: 'c2', trackId: 't_main', start: 2200, end: 3600, text: '第二句内容', locked: false },
    { id: 'c5', trackId: 't_main', start: 4050, end: 5050, text: '要删除的句子（修订）', locked: false },
    { id: 'c6', trackId: 't_main', start: 6000, end: 6500, text: '要拆分的句子内容上', locked: false },
    { id: 'c7', trackId: 't_main', start: 6500, end: 7000, text: '要拆分的句子内容下', locked: false },
  ],
};
await submit(pid, rev1.id, snap2, 'alice', '第二版');

let { data: d1d } = await j('GET', `/api/projects/${pid}/discussions/${d1}`);
ok(d1d.thread.anchor_id === 'c1' && d1d.thread.anchor_start === 100, '编号保留的讨论自动跟随到新位置');
let { data: d3d } = await j('GET', `/api/projects/${pid}/discussions/${d3id}`);
ok(d3d.thread.anchor_status === 'anchored' && d3d.thread.anchor_id === 'c5', '唯一强匹配的讨论自动跟随（auto-follow）');
const autoEv = d3d.events.find((e) => e.kind === 'auto-follow');
ok(autoEv && autoEv.detail.old.cueId === 'c3' && autoEv.detail.new.cueId === 'c5', '自动跟随事件记录旧位置/新位置');

let { data: d4d } = await j('GET', `/api/projects/${pid}/discussions/${d4id}`);
ok(d4d.thread.anchor_status === 'orphan' && d4d.thread.orphan_reason === 'split', '拆分句的讨论进入待重新定位（split）');
ok(d4d.thread.last_anchor_id === 'c4' && d4d.thread.last_anchor_start === 6000, '孤儿保留旧位置记录');
ok(d4d.thread.orphan_detail.candidates.length === 2, '孤儿携带候选句子供人工选择');

let { data: d2d } = await j('GET', `/api/projects/${pid}/discussions/${d2}`);
ok(d2d.thread.anchor_status === 'anchored' && d2d.thread.anchor_start === 3000, '时间范围讨论坐标保留');

/* ---------- 合并提交（分叉）也跟随：以新 HEAD 为主父，锚点映射到合并结果 ---------- */
{
  // 基于 rev1 分叉提交一个新版本：只改 c2 文本（与 rev2 无句子冲突），服务端三向合并
  const branchSnap = {
    ...snap1,
    cues: snap1.cues.map((c) => (c.id === 'c2' ? { ...c, text: '第二句内容-分叉修改' } : c)),
  };
  const rMerge = await j('POST', `/api/projects/${pid}/revisions`, {
    baseRevId: rev1.id, snapshot: branchSnap, author: 'dave', message: '分叉修改c2',
  });
  ok(rMerge.status === 201 && rMerge.data.revision.kind === 'merge', '分叉提交经三向合并成为 merge 版本');
  const mergeRev = rMerge.data.revision;
  ok(mergeRev.parent2_id === rev1.id, 'merge 版本保留第二父关系');
  // d2 是 range，坐标保持；验证 d1（跟在 c1 上）在合并结果仍锚定 c1
  const { data: detail } = await j('GET', `/api/projects/${pid}/discussions/${d1}`);
  ok(detail.thread.anchor_status === 'anchored' && detail.thread.anchor_id === 'c1', '合并提交后讨论仍正确锚定');
  // 合并结果里 c2 文本应为分叉修改（三向合入）
  ok(mergeRev.snapshot.cues.find((c) => c.id === 'c2').text === '第二句内容-分叉修改', '分叉修改已并入 HEAD');
}

/* ---------- 未解决数量汇总 ---------- */
const { data: summary } = await j('GET', `/api/projects/${pid}/discussions/summary`);
ok(summary.orphan >= 1 && summary.unresolvedOrphan >= 1, `汇总含待重新定位数量：${JSON.stringify(summary)}`);

/* ---------- 人工重新定位 ---------- */
r = await j('POST', `/api/projects/${pid}/discussions/${d1}/relocate`, {
  targetType: 'cue', cueId: 'c2', author: 'bob', expectedVersion: d1d.thread.version, clientToken: 'tok-rel-1',
});
ok(r.status === 409, '已定位讨论不能重新定位');

r = await j('POST', `/api/projects/${pid}/discussions/${d4id}/relocate`, {
  targetType: 'cue', cueId: 'c6', author: 'bob', expectedVersion: d4d.thread.version, clientToken: 'tok-rel-2',
});
ok(r.status === 200 && r.data.thread.thread.anchor_id === 'c6', '人工重新定位到候选句');
const relEv = r.data.thread.events.find((e) => e.kind === 'relocate');
ok(relEv && relEv.detail.old.cueId === 'c4' && relEv.detail.new.cueId === 'c6' && relEv.actor === 'bob',
  '重新定位事件保留旧位置/新位置/操作者');

r = await j('POST', `/api/projects/${pid}/discussions/${d4id}/relocate`, {
  targetType: 'cue', cueId: 'c6', author: 'bob', clientToken: 'tok-rel-2',
});
ok(r.status === 200, '重复重新定位请求幂等');

// 乐观锁：用旧 version 重新定位已被处理的讨论 → 409 version-conflict 且返回当前状态
r = await j('POST', `/api/projects/${pid}/discussions/${d4id}/relocate`, {
  targetType: 'cue', cueId: 'c7', author: 'eve', expectedVersion: d4d.thread.version, clientToken: 'tok-rel-stale',
});
ok(r.status === 409 && r.data.code === 'version-conflict' && r.data.current.anchor_id === 'c6',
  '旧版本号的重新定位被拒（不覆盖，返回当前状态）');

/* ---------- 列表筛选 ---------- */
let { data: list } = await j('GET', `/api/projects/${pid}/discussions?anchorStatus=orphan`);
ok(list.discussions.every((x) => x.anchor_status === 'orphan'), '列表按待重新定位筛选');
({ data: list } = await j('GET', `/api/projects/${pid}/discussions?status=resolved`));
ok(list.discussions.every((x) => x.status === 'resolved'), '列表按已解决筛选');

/* ---------- 删除轨道 → range 讨论 orphan，可改挂时间范围 ---------- */
{
  const head = (await j('GET', `/api/projects/${pid}`)).data.head;
  const snap3 = {
    ...head.snapshot,
    tracks: [
      ...head.snapshot.tracks,
      { id: 't_extra', name: '附加轨', color: '#ff5d6c', mutexGroup: null },
    ],
  };
  const rev3 = await submit(pid, head.id, snap3, 'alice', '加轨');
  const createdRange = await j('POST', `/api/projects/${pid}/discussions`, {
    anchorType: 'range', start: 1000, end: 2000, trackId: 't_extra',
    body: '附加轨上的范围讨论', author: 'a', clientToken: 'tok-create-extra',
  });
  ok(createdRange.status === 201, '附加轨范围讨论已创建');
  const dExtra = createdRange.data.thread.thread.id;

  const snap4 = { ...rev3.snapshot, tracks: rev3.snapshot.tracks.filter((t) => t.id !== 't_extra') };
  await submit(pid, rev3.id, snap4, 'alice', '删轨');
  const { data: dExtraD } = await j('GET', `/api/projects/${pid}/discussions/${dExtra}`);
  ok(dExtraD.thread.anchor_status === 'orphan' && dExtraD.thread.orphan_reason === 'track-deleted',
    '轨道删除后范围讨论进入待重新定位');

  const rel = await j('POST', `/api/projects/${pid}/discussions/${dExtra}/relocate`, {
    targetType: 'range', start: 1000, end: 2000, trackId: '',
    author: 'bob', expectedVersion: dExtraD.thread.version, clientToken: 'tok-rel-extra',
  });
  ok(rel.status === 200 && rel.data.thread.thread.anchor_type === 'range' && !rel.data.thread.thread.anchor_track,
    '改挂为全部轨道的时间范围');

  /* ---------- 审计留痕：状态变化与定位历史在审计页可查 ---------- */
  const { data: auditPage } = await j('GET', `/api/projects/${pid}/audit?limit=300`);
  const actions = new Set(auditPage.audit.map((x) => x.action));
  for (const need of ['disc-create', 'disc-resolve', 'disc-reopen', 'disc-relocate', 'disc-orphan', 'disc-auto-follow']) {
    ok(actions.has(need), `审计包含 ${need}`);
  }
}

console.log('\n端到端结束，失败数：' + failures);
process.exit(failures ? 1 : 0);
