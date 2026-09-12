// 端到端：两人基于同一版本并发保存，自动合并无冲突句，冲突句走裁决接口
const BASE = 'http://localhost:3000';

async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

const { data: created } = await j('POST', '/api/projects', { name: '并发测试', author: 'alice' });
const pid = created.project.id;
const createId = created.revision.id;
const createSnap = created.revision.snapshot;

// 种子版本：两人共同拉取过的版本
const seedSnap = {
  ...createSnap,
  tracks: [
    { id: 't_main', name: '主轨', color: '#4e8cff', mutexGroup: 'g1' },
    { id: 't_sub', name: '副轨', color: '#ff9a3c', mutexGroup: 'g1' },
  ],
  cues: [
    { id: 'c1', trackId: 't_main', start: 0, end: 1000, text: '第一句', locked: false },
    { id: 'c2', trackId: 't_main', start: 2000, end: 3000, text: '共同句', locked: false },
  ],
};
const seed = await j('POST', `/api/projects/${pid}/revisions`, {
  baseRevId: createId, snapshot: seedSnap, author: 'alice', message: '种子版本',
});
const baseId = seed.data.revision.id;
const baseSnap = seedSnap;

const snapA = {
  ...baseSnap,
  cues: [
    { ...baseSnap.cues[0], text: 'alice 改的第一句' },
    { ...baseSnap.cues[1], end: 3500, text: 'alice 改的共同句' }, // end 自动合并；text 与 bob 冲突
  ],
};

// alice 先保存（快进）
const r1 = await j('POST', `/api/projects/${pid}/revisions`, {
  baseRevId: baseId, snapshot: snapA, author: 'alice', message: 'alice 建句',
});
console.log('alice 保存:', r1.status, r1.data.status || r1.data.error);

// bob 基于种子版本：只改 c2 文本并新增 c3（与 alice 对 c1 的改动不冲突）
const snapB = {
  ...baseSnap,
  cues: [
    baseSnap.cues[0],
    { ...baseSnap.cues[1], text: 'bob 改的共同句' },
    { id: 'c3', trackId: 't_main', start: 5000, end: 6000, text: 'bob 新增句', locked: false },
  ],
};
const r2 = await j('POST', `/api/projects/${pid}/revisions`, {
  baseRevId: baseId, snapshot: snapB, author: 'bob', message: 'bob 并发保存',
});
console.log('bob 保存:', r2.status, r2.data.status, '冲突数=', r2.data.conflicts?.length);

// 预期 409：1 个 edit-edit（c2.text）；c1/tracks 自动并入，c3 自动并入
const conflict = r2.data.conflicts.find((c) => c.id === 'c2');
console.log('冲突点:', conflict.kind, conflict.id, conflict.fields?.map((f) => f.field));
const mergedCueIds = r2.data.merged.cues.map((c) => c.id).sort();
console.log('自动合并后句子:', mergedCueIds.join(','));

// bob 裁决：c2 用自己的（mine = 提交方 bob）
const resolved = r2.data.merged;
const c2 = resolved.cues.find((c) => c.id === 'c2');
c2.text = conflict.fields[0].mine;

const r3 = await j('POST', `/api/projects/${pid}/resolve`, {
  parentRevId: r2.data.head.id,
  otherRevId: baseId,
  resolvedSnapshot: resolved,
  conflictKeys: ['cue:c2:text'],
  author: 'bob',
  message: 'bob 裁决保留己方',
});
console.log('裁决提交:', r3.status, r3.data.status);
const head = r3.data.revision;
const finalTexts = Object.fromEntries(head.snapshot.cues.map((c) => [c.id, c.text]));
console.log('最终文本:', JSON.stringify(finalTexts));
console.log('合并提交父节点:', head.parent1_id, '+', head.parent2_id, 'kind=', head.kind);

// 反向区间必须被拒
const bad = JSON.parse(JSON.stringify(head.snapshot));
bad.cues[0].end = bad.cues[0].start - 1;
const r4 = await j('POST', `/api/projects/${pid}/revisions`, {
  baseRevId: head.id, snapshot: bad, author: 'bob',
});
console.log('反向区间提交:', r4.status, r4.data.error);

// 审计
const { data: auditData } = await j('GET', `/api/projects/${pid}/audit`);
const resolveEntry = auditData.audit.find((a) => a.action === 'resolve');
console.log('审计含冲突裁决:', Boolean(resolveEntry), '，审计条数=', auditData.audit.length);

// 校验最终结果
const ok =
  r1.status === 201 &&
  r2.status === 409 &&
  r2.data.conflicts.length === 1 &&
  conflict.kind === 'edit-edit' &&
  conflict.fields[0].field === 'text' &&
  mergedCueIds.join() === 'c1,c2,c3' &&
  r3.status === 201 &&
  finalTexts.c2 === 'bob 改的共同句' &&
  head.snapshot.cues.find((c) => c.id === 'c2').end === 3500 && // 不同字段自动合并
  head.snapshot.cues.find((c) => c.id === 'c1').text === 'alice 改的第一句' &&
  head.kind === 'merge' && head.parent1_id === r1.data.revision.id && head.parent2_id === baseId &&
  r4.status === 400 &&
  Boolean(resolveEntry);
console.log(ok ? '\n端到端并发场景全部通过 ✓' : '\n存在失败项 ✗');
process.exit(ok ? 0 : 1);
