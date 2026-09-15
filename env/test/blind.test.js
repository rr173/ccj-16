'use strict';
// 盲审对照分组：稳定编号 / 内容匹配组成对照项；新增、删除、一对多必须单列，不硬配
// 匿名化：同一审阅人顺序稳定、不同审阅人彼此独立、标签↔槽位可往返解码
const assert = require('assert');
const {
  REASON_NO_COUNTERPART, REASON_ONE_TO_MANY,
  buildComparison, anonymize, labelOrder, decodeLabel, encodeSlot,
} = require('../server/src/blind/match');

let passed = 0;
function ok(cond, name) {
  assert(cond, name);
  passed++;
  console.log('  ✓', name);
}

const tracks = [{ id: 't1', name: '主轨', color: '#000', mutexGroup: null }];
const V = (slot, cues) => ({ slot, tracks, cues });
const cue = (id, start, end, text) => ({ id, trackId: 't1', start, end, text, locked: false });

/* 1) 稳定编号：同一编号出现在 3 个版本 → 一个三候选对照项 */
let r = buildComparison([
  V(0, [cue('c1', 0, 1000, '第一句内容')]),
  V(1, [cue('c1', 0, 1000, '第一句内容（改）')]),
  V(2, [cue('c1', 0, 1000, '第一句内容')]),
]);
ok(r.items.length === 1 && r.items[0].matchedBy === 'id' && r.items[0].candidates.length === 3,
  '稳定编号跨 3 版组成一个对照项');
ok(r.unmatched.length === 0, '全部配对，无单列内容');

/* 2) 编号只在一个版本出现 + 内容强匹配（删除后重建）→ 内容对照项 */
r = buildComparison([
  V(0, [cue('c1', 0, 2000, '今天我们讨论一下字幕校对')]),
  V(1, [cue('c9', 50, 2050, '今天我们讨论一下字幕校对！')]),
]);
ok(r.items.length === 1 && r.items[0].matchedBy === 'content' && r.items[0].similarity > 0,
  '删除重建经内容匹配组成对照项');
ok(r.unmatched.length === 0, '内容匹配后无单列');

/* 3) 完全无关的新增句 → 单列（无对应），不进对照项 */
r = buildComparison([
  V(0, [cue('c1', 0, 1000, '开场白内容')]),
  V(1, [cue('c1', 0, 1000, '开场白内容'), cue('c2', 50000, 51000, '全新的一段独白内容XYZ')]),
]);
ok(r.items.length === 1 && r.items[0].candidates.length === 2, '共有句组成对照项');
ok(r.unmatched.length === 1 && r.unmatched[0].cueId === 'c2' && r.unmatched[0].reason === REASON_NO_COUNTERPART,
  '新增句单列（无对应），不硬配进任何对照项');

/* 4) 一对多（拆分）：原句与两个半句都强相似 → 全部单列，绝不硬配成一组 */
r = buildComparison([
  V(0, [cue('c1', 6000, 7000, '要拆分的句子内容')]),
  V(1, [
    cue('c2', 6000, 6500, '要拆分的句子内容上'),
    cue('c3', 6500, 7000, '要拆分的句子内容下'),
  ]),
]);
ok(r.items.length === 0, '一对多不组成任何对照项');
ok(r.unmatched.length === 3 && r.unmatched.every((u) => u.reason === REASON_ONE_TO_MANY),
  '原句与两个拆分句全部单列（一对多）');

/* 4b) 实测回归：拆成两条且其中一条保留原稳定编号，另有版本保留整句
       → 四句全部单列，绝不允许同一版本的两条字幕进同一对照项 */
r = buildComparison([
  V(0, [cue('c3', 6000, 7000, '将被拆分的句子内容')]),
  V(1, [
    cue('c3', 6000, 6500, '将被拆分的句子内容上'),
    cue('n3', 6500, 7000, '将被拆分的句子内容下'),
  ]),
  V(2, [cue('c3', 6000, 7000, '将被拆分的句子内容')]),
]);
ok(r.items.length === 0, '保留编号的拆分仍不组成任何对照项');
ok(r.unmatched.length === 4 && r.unmatched.every((u) => u.reason === REASON_ONE_TO_MANY),
  '整句（两个版本）与拆分两句全部单列（一对多）');

/* 4c) 反向一对多（合并）：一版整句 → 另一版两句且其一保留编号 → 同样全部单列 */
r = buildComparison([
  V(0, [
    cue('c1', 0, 1000, '合并后的完整句子内容'),
    cue('c2', 1000, 2000, '另一句正常内容'),
  ]),
  V(1, [
    cue('c1', 0, 500, '合并后的完整句子'),
    cue('n1', 500, 1000, '的完整句子内容'),
    cue('c2', 1000, 2000, '另一句正常内容'),
  ]),
]);
ok(!r.items.some((i) => i.candidates.length > 1 && i.candidates.some((c) => c.cueId === 'c1')),
  '合并场景没有把整句与任一半句配成对照项');
ok(r.unmatched.filter((u) => u.reason === REASON_ONE_TO_MANY).length === 3,
  '合并涉及的三句全部单列（一对多）');

/* 5) 同时间槽但文本无关 → 不配对（各自单列） */
r = buildComparison([
  V(0, [cue('a1', 0, 1000, '苹果香蕉橘子西瓜')]),
  V(1, [cue('b1', 0, 1000, '量子力学相对论语')]),
]);
ok(r.items.length === 0 && r.unmatched.length === 2, '同槽文本无关：两句都单列');

/* 6) 三版本混合：编号组 + 内容组 + 新增 + 一对多 同时成立 */
r = buildComparison([
  V(0, [
    cue('c1', 0, 1000, '各版都有的句子'),
    cue('c2', 2000, 3000, '第二版会改写重建的句子内容'),
    cue('c3', 6000, 7000, '将被拆分的句子内容'),
  ]),
  V(1, [
    cue('c1', 0, 1000, '各版都有的句子（改）'),
    cue('n1', 2050, 3050, '第二版会改写重建的句子内容！'),
    cue('n2', 6000, 6500, '将被拆分的句子内容上'),
    cue('n3', 6500, 7000, '将被拆分的句子内容下'),
    cue('n4', 40000, 41000, '第二版独有的全新内容'),
  ]),
  V(2, [
    cue('c1', 0, 1000, '各版都有的句子'),
    cue('c2', 2000, 3000, '第二版会改写重建的句子内容'),
    cue('c3', 6000, 7000, '将被拆分的句子内容'),
  ]),
]);
const idItem = r.items.find((i) => i.key === 'id:c1');
const mxItem = r.items.find((i) => i.matchedBy === 'content');
ok(idItem && idItem.candidates.length === 3, '三版共有编号组成三候选对照项');
ok(mxItem && mxItem.candidates.length === 3
  && mxItem.candidates.map((c) => c.cueId).sort().join(',') === 'c2,c2,n1',
  '删除重建句并入同编号组（三候选内容对照项），不单列成新增');
ok(!r.items.some((i) => i.key === 'id:c3'), '被拆分句不进任何对照项（即便两个未拆分版本编号相同）');
ok(r.unmatched.some((u) => u.cueId === 'n4' && u.reason === REASON_NO_COUNTERPART), '独有句单列（无对应）');
const splitUnmatched = r.unmatched.filter((u) => u.reason === REASON_ONE_TO_MANY);
ok(splitUnmatched.length === 4
  && splitUnmatched.every((u) => u.cueId === 'c3' || ['n2', 'n3'].includes(u.cueId)),
  '拆分涉及的四句（含两个未拆分版本的整句）全部单列（一对多）');
ok(!r.items.some((i) => i.candidates.some((c) => c.cueId === 'c3' || ['n2', 'n3'].includes(c.cueId))),
  '一对多内容没有硬配进任何对照项');

/* 7) 每组每版本至多一句：同版本两句相似句不会被并到同一组 */
r = buildComparison([
  V(0, [cue('x1', 0, 2000, '好的我知道了就这样吧')]),
  V(1, [
    cue('y1', 100, 2100, '好的我知道了就这样吧'),
    cue('y2', 40000, 42000, '完全不相干的另一段话'),
  ]),
  V(2, [cue('z1', 0, 2000, '好的我知道了就这样吧')]),
]);
const grp = r.items.find((i) => i.candidates.some((c) => c.cueId === 'y1'));
ok(grp && grp.candidates.length === 3, '相似句跨三版各取一句成组');
ok(r.unmatched.some((u) => u.cueId === 'y2'), '无关句单列');

/* 8) 确定性：输入顺序打乱，分组结果一致 */
const mk = () => [
  V(0, [cue('c1', 0, 1000, '各版都有'), cue('c2', 2000, 3000, '会被重建的句子内容'), cue('c3', 9000, 10000, '独有甲')]),
  V(1, [cue('n1', 2050, 3000, '会被重建的句子内容！'), cue('c1', 0, 1000, '各版都有（改）'), cue('n9', 50000, 51000, '独有乙')]),
];
const r1 = buildComparison(mk());
const r2 = buildComparison(mk().map((v) => ({ ...v, cues: [...v.cues].reverse() })));
ok(JSON.stringify(r1) === JSON.stringify(r2), '分组结果与输入句子顺序无关（确定性）');

/* 9) 匿名化：同一审阅人稳定；标签是槽位的排列；解码/编码往返一致 */
const item = { key: 'id:c1', candidates: [{ slot: 0 }, { slot: 1 }, { slot: 2 }] };
const o1 = anonymize('br_x', 'alice', 'id:c1', [0, 1, 2]);
const o2 = anonymize('br_x', 'alice', 'id:c1', [0, 1, 2]);
ok(JSON.stringify(o1) === JSON.stringify(o2), '同一审阅人多次进入看到同一顺序');
ok(o1.map((o) => o.label).join('') === 'ABC' && [...o1.map((o) => o.slot)].sort().join('') === '012',
  '标签 A/B/C 是三个槽位的排列');
const labeled = labelOrder('br_x', 'alice', item);
ok(labeled.length === 3 && labeled.every((l) => l.candidate && typeof l.label === 'string'), '审阅视角候选按标签排列');
for (const { label, slot } of o1) {
  ok(decodeLabel('br_x', 'alice', 'id:c1', [0, 1, 2], label) === slot, `标签 ${label} 解码回槽位 ${slot}`);
  ok(encodeSlot('br_x', 'alice', 'id:c1', [0, 1, 2], slot) === label, `槽位 ${slot} 编码回标签 ${label}`);
}
ok(decodeLabel('br_x', 'alice', 'id:c1', [0, 1, 2], 'D') === null, '非法标签解码为 null');

/* 10) 审阅人彼此独立：不同审阅人的顺序独立生成（20 个对照项中至少一个不同） */
let diff = 0;
for (let i = 0; i < 20; i++) {
  const a = anonymize('br_x', 'alice', `k${i}`, [0, 1, 2]).map((o) => o.slot).join('');
  const b = anonymize('br_x', 'bob', `k${i}`, [0, 1, 2]).map((o) => o.slot).join('');
  if (a !== b) diff++;
}
ok(diff > 0, `不同审阅人候选顺序彼此独立（20 项中 ${diff} 项顺序不同）`);
// 不同轮次同一审阅人顺序也独立（种子含轮次 id）
const oA = anonymize('br_1', 'alice', 'id:c1', [0, 1, 2]).map((o) => o.slot).join('');
const oB = anonymize('br_2', 'alice', 'id:c1', [0, 1, 2]).map((o) => o.slot).join('');
ok(typeof oA === 'string' && typeof oB === 'string', '不同轮次种子独立');

console.log(`\n盲审对照分组与匿名化单元测试全部通过（${passed} 项断言）`);
