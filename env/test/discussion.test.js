'use strict';
// 讨论锚点跨版本跟随匹配：唯一对应才跟随；删除/拆分/无法唯一匹配必须进入待重新定位
const assert = require('assert');
const { resolveCueAnchor } = require('../server/src/discussion/match');

let passed = 0;
function ok(cond, name) {
  assert(cond, name);
  passed++;
  console.log('  ✓', name);
}

const snap = (cues, tracks) => ({
  duration: 100000,
  tracks: tracks || [{ id: 't1', name: '主轨', color: '#000', mutexGroup: null }],
  cues,
});

/* 1) 稳定编号仍在：直接跟随（即使文本/时间/轨道都改了） */
let r = resolveCueAnchor(
  { id: 'c1', trackId: 't1', start: 0, end: 1000, text: '原句' },
  snap([{ id: 'c1', trackId: 't2', start: 5000, end: 6000, text: '完全改写' }]),
);
ok(r.outcome === 'follow' && r.cueId === 'c1' && r.via === 'id', '编号保留即跟随（含跨轨/改写/移时）');

/* 2) 编号消失 + 唯一强匹配（删除后重建）：自动跟随，via=content */
r = resolveCueAnchor(
  { id: 'c1', trackId: 't1', start: 0, end: 2000, text: '今天我们讨论一下字幕校对' },
  snap([{ id: 'c9', trackId: 't1', start: 50, end: 2050, text: '今天我们讨论一下字幕校对！' }]),
);
ok(r.outcome === 'follow' && r.cueId === 'c9' && r.via === 'content', '删除后唯一强匹配自动跟随');

/* 3) 编号消失 + 两个强候选（拆分）：orphan split，绝不二选一悄悄挂上 */
r = resolveCueAnchor(
  { id: 'c4', trackId: 't1', start: 6000, end: 7000, text: '要拆分的句子内容' },
  snap([
    { id: 'c6', trackId: 't1', start: 6000, end: 6500, text: '要拆分的句子内容上' },
    { id: 'c7', trackId: 't1', start: 6500, end: 7000, text: '要拆分的句子内容下' },
  ]),
);
ok(r.outcome === 'orphan' && r.reason === 'split' && r.candidates.length === 2,
  '一句变多句时 orphan(split) 并保留两个候选');

/* 4) 编号消失且没有任何相似句子：orphan deleted */
r = resolveCueAnchor(
  { id: 'c3', trackId: 't1', start: 40000, end: 41000, text: '完全独特的句子内容XYZ' },
  snap([{ id: 'n1', trackId: 't1', start: 0, end: 1000, text: '毫不相干的开场白啊啊啊' }]),
);
ok(r.outcome === 'orphan' && r.reason === 'deleted' && r.candidates.length === 0,
  '对应字幕删除且无相似句：orphan(deleted)');

/* 5) 同时间槽但文本无关：不能当成同一句跟随 */
r = resolveCueAnchor(
  { id: 'a1', trackId: 't1', start: 0, end: 1000, text: '苹果香蕉橘子西瓜' },
  snap([{ id: 'b1', trackId: 't1', start: 0, end: 1000, text: '量子力学相对论语' }]),
);
ok(r.outcome === 'orphan' && r.reason === 'deleted', '同槽文本无关：不跟随（deleted）');

/* 6) 唯一候选但证据不足（不能唯一确认）：orphan ambiguous */
// 文本近似但时间隔得远：候选被收集（score≥0.4），但未同时满足强匹配门槛
r = resolveCueAnchor(
  { id: 'c1', trackId: 't1', start: 0, end: 1000, text: '这是一段普通对白内容需要校对' },
  snap([{ id: 'c2', trackId: 't1', start: 2000, end: 3000, text: '这是一段普通对白内容还需校对' }]),
);
ok(r.outcome === 'orphan' && r.reason === 'ambiguous' && r.candidates.length === 1,
  '时间证据不足的唯一候选：orphan(ambiguous)，不强挂');
// 时间贴近但文本只泛泛相似：同样不能唯一确认
r = resolveCueAnchor(
  { id: 'c1', trackId: 't1', start: 0, end: 2000, text: '好的我知道了就这样吧' },
  snap([{ id: 'c2', trackId: 't1', start: 500, end: 2500, text: '好吧我知道啦就这样' }]),
);
ok(r.outcome === 'orphan' && r.reason === 'ambiguous', '文本证据不足的唯一候选：orphan(ambiguous)');

/* 7) 确定性：同一输入无论候选数组顺序如何，候选排序结果一致 */
const oldCue = { id: 'c4', trackId: 't1', start: 6000, end: 7000, text: '要拆分的句子内容' };
const candsA = [
  { id: 'c6', trackId: 't1', start: 6000, end: 6500, text: '要拆分的句子内容上' },
  { id: 'c7', trackId: 't1', start: 6500, end: 7000, text: '要拆分的句子内容下' },
];
const rForward = resolveCueAnchor(oldCue, snap(candsA));
const rReversed = resolveCueAnchor(oldCue, snap([...candsA].reverse()));
ok(JSON.stringify(rReversed.candidates.map((c) => c.cueId)) === JSON.stringify(rForward.candidates.map((c) => c.cueId)),
  '候选顺序确定，与输入数组顺序无关');

console.log(`\n讨论锚点匹配单元测试全部通过（${passed} 项断言）`);
