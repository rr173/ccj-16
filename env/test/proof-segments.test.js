'use strict';
// 自动切片：按字幕空隙与最大时长切成连续且不重叠的片段
const assert = require('assert');
const { planSegments, normalizeParams } = require('../server/src/proof/segments');

let passed = 0;
function ok(cond, name) {
  assert(cond, name);
  passed++;
  console.log('  ✓', name);
}

const tracks = [
  { id: 't1', name: '主轨', color: '#000', mutexGroup: null },
  { id: 't2', name: '副轨', color: '#111', mutexGroup: null },
];
const cue = (id, trackId, start, end, text = '内容') => ({ id, trackId, start, end, text, locked: false });

const snap = (cues) => ({ duration: 100000, tracks, cues, settings: {} });

/* 1) 参数校验 */
assert.throws(() => normalizeParams({ gapMs: -1 }), /空隙/);
ok(true, '负空隙阈值被拒绝');
assert.throws(() => normalizeParams({ maxSegmentMs: 10 }), /最大片段/);
ok(true, '过小最大时长被拒绝');
assert.throws(() => normalizeParams({ maxSegmentMs: 99999999999 }), /最大片段/);
ok(true, '过大最大时长被拒绝');
ok(normalizeParams({}).gapMs === 2000 && normalizeParams({}).maxSegmentMs === 30000, '默认参数');

/* 2) 空隙切分：间隔超过阈值则断开 */
let r = planSegments(snap([
  cue('a', 't1', 0, 1000),
  cue('b', 't1', 1500, 2500),    // 与 a 间隔 500
  cue('c', 't1', 10000, 11000),  // 与 b 间隔 7500 > 2000
]), { gapMs: 2000, maxSegmentMs: 30000 });
ok(r.segments.length === 2, '大空隙处切成两段');
ok(r.segments[0].cueIds.join() === 'a,b' && r.segments[1].cueIds[0] === 'c', '切分归属正确');
ok(r.segments[0].endMs <= r.segments[1].startMs, '片段时间区间不重叠');

/* 3) 最大时长切分：与空隙无关 */
r = planSegments(snap([
  cue('a', 't1', 0, 1000),
  cue('b', 't1', 1200, 2200),
  cue('c', 't1', 2400, 3400),
  cue('d', 't1', 3600, 4600),
]), { gapMs: 0, maxSegmentMs: 3000 });
ok(r.segments.length === 2 && r.segments[0].cueIds.join() === 'a,b' && r.segments[1].cueIds.join() === 'c,d',
  '超过最大时长在下一句前切开');
ok(r.segments.every((s) => s.endMs - s.startMs <= 3000), '每段跨度不超过最大时长');

/* 4) 跨轨时间交叠的字幕必须在同一片段，即便跨度超限 */
r = planSegments(snap([
  cue('a', 't1', 0, 20000),     // 主轨长句
  cue('b', 't2', 5000, 6000),    // 副轨与之交叠
  cue('c', 't1', 40000, 41000),  // 之后无关句
]), { gapMs: 2000, maxSegmentMs: 10000 });
ok(r.segments[0].cueIds.sort().join() === 'a,b', '跨轨交叠字幕落在同一片段');
ok(r.segments.length === 2, '交叠例外后仍正常切分');

/* 5) 连续且不重叠：随机排布后相邻片段首尾不交叉且覆盖全部句子 */
const cues = [];
for (let i = 0; i < 40; i++) {
  const start = i * 1500;
  cues.push(cue('q' + i, 't1', start, start + 1000));
}
r = planSegments(snap(cues), { gapMs: 100000, maxSegmentMs: 12000 });
const allIds = r.segments.flatMap((s) => s.cueIds);
ok(allIds.length === 40 && new Set(allIds).size === 40, '每句恰好出现一次');
for (let i = 1; i < r.segments.length; i++) {
  ok(r.segments[i - 1].endMs <= r.segments[i].startMs, `片段 ${i} 与前一段不重叠`);
}
ok(r.segments.every((s) => s.endMs - s.startMs <= 12000 || s.cues.some((c) => c.cue.start < s.endMs && c.cue.end > s.startMs && c.cue.trackId !== s.cues[0].cue.trackId)),
  '超限片段只可能由跨轨交叠导致');

/* 6) 轨道过滤 */
r = planSegments(snap([
  cue('a', 't1', 0, 1000),
  cue('x', 't2', 0, 90000),
  cue('b', 't1', 5000, 6000),
]), { gapMs: 2000, maxSegmentMs: 30000, trackIds: ['t1'] });
ok(r.segments.length === 2 && r.segments.every((s) => s.cues.every((c) => c.cue.trackId === 't1')), '只切所选轨道');
assert.throws(() => planSegments(snap([cue('a', 't1', 0, 1000)]), { trackIds: ['nope'] }), /轨道/);
ok(true, '所选轨道不存在被拒绝');

/* 7) baseline 带轨道名，seq 从 1 连续 */
r = planSegments(snap([cue('a', 't2', 0, 1000)]), {});
ok(r.segments[0].seq === 1 && r.segments[0].cues[0].trackName === '副轨', '片段含序号与轨道名');

/* 8) 空内容：切不出片段（由批次创建层拒绝） */
ok(planSegments(snap([]), {}).segments.length === 0, '无字幕时切片为空');

console.log(`\n自动切片单元测试全部通过（${passed} 项断言）`);
