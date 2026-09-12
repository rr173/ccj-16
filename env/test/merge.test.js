'use strict';
const assert = require('assert');
const { mergeSnapshots } = require('../server/src/merge');
const { normalizeSnapshot, validate } = require('../server/src/validation');

const base = normalizeSnapshot({
  duration: 60000,
  tracks: [
    { id: 't1', name: '主轨', color: '#000', mutexGroup: null },
    { id: 't2', name: '副轨', color: '#111', mutexGroup: 'g1' },
    { id: 't3', name: '第三轨', color: '#222', mutexGroup: 'g1' },
  ],
  cues: [
    { id: 'c1', trackId: 't1', start: 0, end: 1000, text: 'A', locked: false },
    { id: 'c2', trackId: 't1', start: 2000, end: 3000, text: 'B', locked: false },
    { id: 'c3', trackId: 't1', start: 4000, end: 5000, text: 'C', locked: false },
  ],
});

// 我：改 c1 文本、删 c2；对方：改 c1 的 end、保留 c2 并改文本、新增 c4
const mine = {
  ...base,
  cues: [
    { ...base.cues[0], text: 'A-mine' },
    // c2 删除
    { ...base.cues[2] },
  ],
};
const theirs = {
  ...base,
  cues: [
    { ...base.cues[0], end: 1200 },
    { ...base.cues[1], text: 'B-theirs' },
    { ...base.cues[2] },
    { id: 'c4', trackId: 't1', start: 6000, end: 7000, text: 'D', locked: false },
  ],
};

const r = mergeSnapshots(base, mine, theirs);
const byId = Object.fromEntries(r.snapshot.cues.map((c) => [c.id, c]));

// c1：我改文本、对方改 end -> 字段级自动合并，无冲突
assert.strictEqual(byId.c1.text, 'A-mine');
assert.strictEqual(byId.c1.end, 1200);
assert.ok(!r.conflicts.some((c) => c.id === 'c1'), 'c1 不应冲突');

// c2：我删、对方编辑 -> 冲突
assert.ok(r.conflicts.some((c) => c.id === 'c2' && c.kind === 'delete-edit'), 'c2 应为 delete-edit 冲突');

// c4：对方单独新增 -> 自动并入
assert.strictEqual(byId.c4.text, 'D');

// c3：双方未动 -> 保留
assert.ok(byId.c3);

// 同字段两边不同值 -> edit/edit 冲突
const base2 = normalizeSnapshot({
  tracks: [{ id: 't1', name: 'x', color: '#000', mutexGroup: null }],
  cues: [{ id: 'c1', trackId: 't1', start: 0, end: 1000, text: 'A', locked: false }],
});
const mine2 = { ...base2, cues: [{ ...base2.cues[0], text: 'M' }] };
const theirs2 = { ...base2, cues: [{ ...base2.cues[0], text: 'T' }] };
const r2 = mergeSnapshots(base2, mine2, theirs2);
assert.strictEqual(r2.conflicts.length, 1);
assert.strictEqual(r2.conflicts[0].kind, 'edit-edit');
assert.deepStrictEqual(r2.conflicts[0].fields.map((f) => f.field), ['text']);
assert.strictEqual(r2.conflicts[0].fields[0].mine, 'M');
assert.strictEqual(r2.conflicts[0].fields[0].theirs, 'T');

// 校验：重叠 / 互斥 / 反向
const s = normalizeSnapshot({
  tracks: [
    { id: 'a', name: 'a', color: '#0', mutexGroup: 'g' },
    { id: 'b', name: 'b', color: '#0', mutexGroup: 'g' },
  ],
  cues: [
    { id: 'x', trackId: 'a', start: 0, end: 2000, text: '', locked: false },
    { id: 'y', trackId: 'a', start: 1000, end: 1500, text: '', locked: false },
    { id: 'z', trackId: 'b', start: 500, end: 1500, text: '', locked: false },
    { id: 'w', trackId: 'a', start: 9000, end: 8000, text: '', locked: false },
  ],
});
const v = validate(s);
assert.ok(v.violations.some((x) => x.type === 'overlap'), '应检出同轨重叠');
assert.ok(v.violations.some((x) => x.type === 'mutex'), '应检出跨轨互斥冲突');
assert.ok(v.hardErrors.some((x) => x.type === 'reverse'), '应检出反向区间');

// 长句覆盖多条短句：每一对重叠都要标出，不能只报相邻的一对
const span = normalizeSnapshot({
  tracks: [{ id: 'a', name: 'a', color: '#0', mutexGroup: null }],
  cues: [
    { id: 'long', trackId: 'a', start: 0, end: 10000, text: '', locked: false },
    { id: 's1', trackId: 'a', start: 1000, end: 2000, text: '', locked: false },
    { id: 's2', trackId: 'a', start: 3000, end: 4000, text: '', locked: false },
  ],
});
const spanOverlaps = validate(span).violations.filter((x) => x.type === 'overlap');
assert.strictEqual(spanOverlaps.length, 2, '长句与它被覆盖的每句都应各报一处重叠');
assert.deepStrictEqual(
  spanOverlaps.map((x) => x.cueIds.join('~')).sort(),
  ['long~s1', 'long~s2'],
);

// 互斥组同理：一条轨上的长句覆盖另一轨的两条短句，两对都要报；
// 且同轨句插在中间（a2）不应遮蔽跨轨重叠
const mutexSpan = normalizeSnapshot({
  tracks: [
    { id: 'a', name: 'a', color: '#0', mutexGroup: 'g' },
    { id: 'b', name: 'b', color: '#0', mutexGroup: 'g' },
  ],
  cues: [
    { id: 'a1', trackId: 'a', start: 0, end: 10000, text: '', locked: false },
    { id: 'a2', trackId: 'a', start: 10000, end: 11000, text: '', locked: false },
    { id: 'b1', trackId: 'b', start: 1000, end: 2000, text: '', locked: false },
    { id: 'b2', trackId: 'b', start: 3000, end: 4000, text: '', locked: false },
  ],
});
const mutexPairs = validate(mutexSpan)
  .violations.filter((x) => x.type === 'mutex')
  .map((x) => x.cueIds.join('~'))
  .sort();
assert.deepStrictEqual(mutexPairs, ['a1~b1', 'a1~b2'], '互斥长句与每条被覆盖句都应各报一处冲突');

// 首尾相接（end === start）不算重叠
const touching = normalizeSnapshot({
  tracks: [{ id: 'a', name: 'a', color: '#0', mutexGroup: null }],
  cues: [
    { id: 'p', trackId: 'a', start: 0, end: 1000, text: '', locked: false },
    { id: 'q', trackId: 'a', start: 1000, end: 2000, text: '', locked: false },
  ],
});
assert.strictEqual(validate(touching).violations.length, 0, '首尾相接不应报重叠');

console.log('全部合并/校验测试通过 ✓');
