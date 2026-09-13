'use strict';
// 版本差异报告：句子匹配 / 逐项对比 / 筛选 / CSV 导出 单测
const assert = require('assert');
const { textSimilarity, timeProximity, matchCues, computeDiff } = require('../server/src/report/match');
const { normalizeFilters, applyFilters, toCsv } = require('../server/src/report/store');

let passed = 0;
function ok(cond, name) {
  assert(cond, name);
  passed++;
  console.log('  ✓', name);
}

/* ---------------- 文本相似度 / 时间接近度 ---------------- */
assert.strictEqual(textSimilarity('你好世界', '你好世界'), 1);
assert.strictEqual(textSimilarity('', 'abc'), 0);
assert.strictEqual(textSimilarity('abc', 'xyz'), 0);
ok(textSimilarity('今天天气不错', '今天天气很不错') > 0.7, '轻微改动的文本相似度高');
ok(textSimilarity('今天天气不错', '完全无关的话') < 0.2, '无关文本相似度低');

assert.strictEqual(timeProximity({ start: 0, end: 1000 }, { start: 0, end: 1000 }), 1);
assert.strictEqual(timeProximity({ start: 0, end: 1000 }, { start: 500, end: 1500 }), 1 / 3);
ok(timeProximity({ start: 0, end: 1000 }, { start: 1500, end: 2000 }) > 0, '邻近但不重叠仍有部分分');
assert.strictEqual(timeProximity({ start: 0, end: 1000 }, { start: 99000, end: 100000 }), 0);
ok(true, '时间接近度边界正确');

/* ---------------- 句子匹配：稳定编号优先，内容兜底 ---------------- */
const A = [
  { id: 'c1', trackId: 't1', start: 0, end: 1000, text: '第一句', locked: false },
  { id: 'c2', trackId: 't1', start: 2000, end: 3000, text: '第二句', locked: false },
  { id: 'c3', trackId: 't1', start: 4000, end: 5000, text: '第三句', locked: false },
];
// B：顺序打乱 + c2 跨轨 + c3 删除后以新 id 重建（文本略改）
const B = [
  { id: 'c9', trackId: 't2', start: 4000, end: 5000, text: '第三句！', locked: false },
  { id: 'c2', trackId: 't2', start: 2000, end: 3000, text: '第二句', locked: false },
  { id: 'c1', trackId: 't1', start: 0, end: 1000, text: '第一句', locked: false },
];
const m = matchCues(A, B);
ok(m.pairs.length === 3, '三句全部配对成功（顺序变化不影响）');
ok(m.pairs.find((p) => p.a.id === 'c2').matchedBy === 'id', '跨轨移动仍按稳定编号配对');
const c3pair = m.pairs.find((p) => p.a.id === 'c3');
ok(c3pair && c3pair.b.id === 'c9' && c3pair.matchedBy === 'content', '删除重建的句子按内容配对而非新增+删除');
ok(m.added.length === 0 && m.deleted.length === 0, '无误报的新增/删除');

// 真正的新增/删除不能被内容匹配吞掉
const m2 = matchCues(A, [
  ...A.map((c) => ({ ...c })),
  { id: 'cX', trackId: 't1', start: 60000, end: 61000, text: '完全不同的新句子', locked: false },
]);
ok(m2.added.length === 1 && m2.added[0].id === 'cX' && m2.deleted.length === 0, '真正的新增保持新增');

// 同一时间槽但文本完全无关：不得强行配对
const m3 = matchCues(
  [{ id: 'a1', trackId: 't1', start: 0, end: 1000, text: '苹果香蕉橘子西瓜', locked: false }],
  [{ id: 'b1', trackId: 't1', start: 0, end: 1000, text: '量子力学相对论语', locked: false }],
);
ok(m3.added.length === 1 && m3.deleted.length === 1, '文本无关的同槽句子不配对');

/* ---------------- 逐项差异展开 ---------------- */
const from = {
  duration: 600000,
  tracks: [
    { id: 't1', name: '主轨', color: '#111', mutexGroup: null },
    { id: 't2', name: '副轨', color: '#222', mutexGroup: null },
  ],
  cues: [
    { id: 'c1', trackId: 't1', start: 0, end: 1000, text: '原文', locked: false },      // 文本修改
    { id: 'c2', trackId: 't1', start: 2000, end: 3000, text: '移动', locked: false },   // 时间修改
    { id: 'c3', trackId: 't1', start: 4000, end: 5000, text: '锁我', locked: false },   // 锁定修改
    { id: 'c4', trackId: 't1', start: 6000, end: 7000, text: '换轨', locked: false },   // 跨轨移动
    { id: 'c5', trackId: 't1', start: 8000, end: 9000, text: '不变', locked: true },    // 未变化
    { id: 'c6', trackId: 't2', start: 10000, end: 11000, text: '删掉', locked: false }, // 删除
  ],
};
const to = {
  duration: 600000,
  tracks: from.tracks,
  cues: [
    { id: 'c1', trackId: 't1', start: 0, end: 1000, text: '改后', locked: false },
    { id: 'c2', trackId: 't1', start: 2500, end: 3500, text: '移动', locked: false },
    { id: 'c3', trackId: 't1', start: 4000, end: 5000, text: '锁我', locked: true },
    { id: 'c4', trackId: 't2', start: 6000, end: 7000, text: '换轨', locked: false },
    { id: 'c5', trackId: 't1', start: 8000, end: 9000, text: '不变', locked: true },
    { id: 'c7', trackId: 't2', start: 12000, end: 13000, text: '新加', locked: false },   // 新增
  ],
};
const { items, summary } = computeDiff(from, to);
const byType = (t) => items.filter((i) => i.type === t);
ok(byType('text').length === 1 && byType('text')[0].oldValue === '原文' && byType('text')[0].newValue === '改后', '文本修改项含旧值/新值');
ok(byType('time').length === 1 && byType('time')[0].oldValue.start === 2000 && byType('time')[0].newValue.start === 2500, '时间修改项含旧/新时间');
ok(byType('lock').length === 1 && byType('lock')[0].oldValue === false && byType('lock')[0].newValue === true, '锁定状态修改项');
ok(byType('track').length === 1 && byType('track')[0].oldValue === 't1' && byType('track')[0].newValue === 't2', '跨轨移动项');
ok(byType('unchanged').length === 1 && byType('unchanged')[0].cueIdFrom === 'c5', '未变化项');
ok(byType('added').length === 1 && byType('added')[0].cueIdTo === 'c7', '新增项');
ok(byType('deleted').length === 1 && byType('deleted')[0].cueIdFrom === 'c6', '删除项');
ok(summary.total === 7 && summary.matched.byId === 5 && summary.matched.byContent === 0, '统计正确');
ok(byType('track')[0].trackName === '副轨', '项带所属轨道名');

// 确定性：同一输入两次计算结果逐项一致
const again = computeDiff(from, to);
assert.deepStrictEqual(again.items, items);
ok(true, '同一输入输出确定（可幂等复用）');

/* ---------------- 筛选 ---------------- */
const f0 = normalizeFilters({});
assert.deepStrictEqual(f0, { trackId: '', types: [], keyword: '' });
const f1 = normalizeFilters({ trackId: 't1', types: ['text', 'time'], keyword: ' 改 ' });
assert.deepStrictEqual(f1, { trackId: 't1', types: ['text', 'time'], keyword: '改' });
const f2 = normalizeFilters({ types: 'text,lock' }); // 查询串形式
assert.deepStrictEqual(f2.types, ['lock', 'text']);
for (const bad of [
  { types: ['nope'] }, { trackId: 123 }, { keyword: 'x'.repeat(201) }, { types: 'text,,bogus' }, [],
]) {
  assert.throws(() => normalizeFilters(bad), (e) => e.status === 400);
}
ok(true, '非法筛选参数全部抛 400');

const onlyT1 = applyFilters(items, normalizeFilters({ trackId: 't1' }));
// t1 上：text/time/lock/unchanged 各 1，跨轨移动的 c4 旧侧在 t1 也算入；c6/c7 在 t2
ok(onlyT1.every((i) => i.trackId === 't1' || i.trackIdFrom === 't1') && onlyT1.length === 5, '按轨道筛选');
const onlyText = applyFilters(items, normalizeFilters({ types: ['text'] }));
ok(onlyText.length === 1 && onlyText[0].type === 'text', '按差异类型筛选');
const kw = applyFilters(items, normalizeFilters({ keyword: '改后' }));
ok(kw.length === 1 && kw[0].type === 'text', '按关键词筛选（命中新值）');
const combo = applyFilters(items, normalizeFilters({ trackId: 't1', types: ['time', 'text'], keyword: '' }));
ok(combo.length === 2, '轨道+类型组合筛选');

/* ---------------- CSV 导出 ---------------- */
const csv = toCsv(items);
const lines = csv.trim().split('\r\n');
ok(lines.length === items.length + 1, 'CSV 行数 = 表头 + 项数');
ok(lines[0].includes('差异类型') && lines[0].includes('旧值') && lines[0].includes('新值'), 'CSV 表头完整');
ok(csv.charCodeAt(0) === 0xfeff, 'CSV 带 BOM（Excel 兼容）');
const csvEsc = toCsv([{ ...byType('text')[0], newValue: '含,逗"号\n换行' }]);
ok(csvEsc.includes('"含,逗""号\n换行"'), 'CSV 特殊字符正确转义');

console.log(`\n差异报告单元测试通过：${passed + 1} 项断言`);
