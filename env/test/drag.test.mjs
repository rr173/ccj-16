// 前端拖动推挤规则的单元测试（在 node 中以 ESM 方式运行）
import assert from 'node:assert';
import { dragLeft, dragRight, dragMove, detectViolations, violatedCueIds } from '../client/js/rules.js';
import serverValidation from '../server/src/validation.js';

const { validate: serverValidate, normalizeSnapshot } = serverValidation;

const tracks = [
  { id: 'a', name: 'A', color: '#000', mutexGroup: null },
  { id: 'b', name: 'B', color: '#000', mutexGroup: 'g' },
  { id: 'c', name: 'C', color: '#000', mutexGroup: 'g' },
];
const cue = (id, trackId, start, end, locked = false) => ({ id, trackId, start, end, text: id, locked });

// 1) 左边界向左拖到 2000（位移 -1000），紧邻句同步平移并恰好触 0，保持接触不重叠
{
  const cues = [cue('x', 'a', 3000, 4000), cue('p', 'a', 1000, 3000)];
  const r = dragLeft('x', 2000, cues, tracks);
  assert.strictEqual(r.get('x').start, 2000);
  assert.strictEqual(r.get('p').end, 2000);
  assert.strictEqual(r.get('p').start, 0);
}

// 1b) 继续往左，前句左端触 0 后整体停住：x 只能到 2000（前句占满 [0,2000]）
{
  const cues = [cue('x', 'a', 3000, 4000), cue('p', 'a', 1000, 3000)];
  const r = dragLeft('x', -5000, cues, tracks);
  assert.strictEqual(r.get('p').start, 0);
  assert.strictEqual(r.get('p').end, 2000);
  assert.strictEqual(r.get('x').start, 2000);
}

// 2) 左边界向左拖，前句锁定 -> 完全不能推，停在锁定句边界
{
  const cues = [cue('x', 'a', 2000, 3000), cue('p', 'a', 0, 2000, true)];
  const r = dragLeft('x', 500, cues, tracks);
  assert.strictEqual(r.get('x').start, 2000);
  assert.ok(!r.has('p'), '锁定句不可出现在拖动结果中');
}

// 3) 右边界向右拖，后续句链刚体推动
{
  const cues = [cue('x', 'a', 0, 1000), cue('q', 'a', 1000, 2000)];
  const r = dragRight('x', 1500, cues, tracks, 600000);
  assert.strictEqual(r.get('x').end, 1500);
  assert.strictEqual(r.get('q').start, 1500);
  assert.strictEqual(r.get('q').end, 2500);
}

// 4) 右边界推动链上有锁定句 -> 链不移动
{
  const cues = [cue('x', 'a', 0, 1000), cue('q', 'a', 1000, 2000, true)];
  const r = dragRight('x', 3000, cues, tracks, 600000);
  assert.strictEqual(r.get('x').end, 1000);
  assert.ok(!r.has('q'));
}

// 5) 左边界向右收窄受最小句长（100ms）限制
{
  const cues2 = [cue('x', 'a', 0, 3000), cue('q', 'a', 3500, 5000)];
  const r = dragLeft('x', 3600, cues2, tracks);
  assert.strictEqual(r.get('x').start, 2900);
  assert.strictEqual(r.get('x').end, 3000);
  assert.ok(!r.has('q'), '收窄不应推动相邻句');
}

// 5b) 左边界向右收窄，左邻句不阻挡
{
  const cues = [cue('x', 'a', 3000, 4000), cue('p', 'a', 0, 2500)];
  const r = dragLeft('x', 3700, cues, tracks);
  assert.strictEqual(r.get('x').start, 3700);
}

// 6) 跨轨互斥组：左扩撞到互斥句 -> 停在其 end
{
  const cues = [cue('x', 'b', 3000, 5000), cue('m', 'c', 0, 2000)];
  const r = dragLeft('x', 1000, cues, tracks);
  assert.strictEqual(r.get('x').start, 2000);
}

// 7) 非互斥跨轨句不形成约束
{
  const cues = [cue('x', 'a', 3000, 5000), cue('m', 'c', 0, 4000)];
  const r = dragLeft('x', 1000, cues, tracks);
  assert.strictEqual(r.get('x').start, 1000);
}

// 8) 整体平移不推挤，撞到同轨句停在其外侧
{
  const cues = [cue('x', 'a', 0, 1000), cue('q', 'a', 3000, 4000)];
  const r = dragMove('x', 2500, cues, tracks, 600000);
  assert.strictEqual(r.get('x').start, 2000);
  assert.strictEqual(r.get('x').end, 3000);
}

// 9) 锁定句不能整体拖动
{
  const cues = [cue('x', 'a', 0, 1000, true)];
  const r = dragMove('x', 3000, cues, tracks, 600000);
  assert.strictEqual(r.size, 0);
}

// 10) 右扩推动链遇链外锁定句停止
{
  const cues = [cue('x', 'a', 0, 1000), cue('q', 'a', 1000, 2000), cue('z', 'a', 3000, 4000, true)];
  const r = dragRight('x', 5000, cues, tracks, 600000);
  assert.strictEqual(r.get('x').end, 2000);
  assert.strictEqual(r.get('q').end, 3000);
}

console.log('拖动规则 10 项测试全部通过 ✓');

// 11) 长句覆盖多条短句：客户端即时标红必须标出每一对重叠，而非只有相邻的一对
{
  const snap = {
    tracks: [{ id: 'a', name: 'a', color: '#000', mutexGroup: null }],
    cues: [
      cue('long', 'a', 0, 10000),
      cue('s1', 'a', 1000, 2000),
      cue('s2', 'a', 3000, 4000),
    ],
  };
  const overlaps = detectViolations(snap).filter((x) => x.type === 'overlap');
  assert.strictEqual(overlaps.length, 2, '长句与它被覆盖的每句都应各报一处重叠');
  assert.deepStrictEqual(overlaps.map((x) => x.cueIds.join('~')).sort(), ['long~s1', 'long~s2']);

  const marks = violatedCueIds(snap);
  for (const id of ['long', 's1', 's2']) {
    assert.ok(marks.get(id)?.has('overlap'), `${id} 应被标红`);
  }
}

// 12) 客户端与服务端校验结果一致（保存前后提示一致）
{
  const snap = normalizeSnapshot({
    tracks: [
      { id: 'a', name: 'a', color: '#000', mutexGroup: 'g' },
      { id: 'b', name: 'b', color: '#000', mutexGroup: 'g' },
      { id: 'c', name: 'c', color: '#000', mutexGroup: null },
    ],
    cues: [
      { id: 'long', trackId: 'a', start: 0, end: 10000, text: '', locked: false },
      { id: 's1', trackId: 'a', start: 1000, end: 2000, text: '', locked: false },
      { id: 's2', trackId: 'a', start: 3000, end: 4000, text: '', locked: false },
      { id: 'm1', trackId: 'b', start: 1500, end: 2500, text: '', locked: false },
      { id: 'm2', trackId: 'b', start: 5000, end: 6000, text: '', locked: false },
      { id: 'free', trackId: 'c', start: 100, end: 9900, text: '', locked: false },
      { id: 'rev', trackId: 'c', start: 20000, end: 19000, text: '', locked: false },
    ],
  });
  const key = (x) => `${x.type}:${x.cueIds.join('~')}`;
  const clientSide = detectViolations(snap).map(key).sort();
  const serverSide = [...serverValidate(snap).violations, ...serverValidate(snap).hardErrors]
    .map((x) => `${x.type}:${(x.cueIds || [x.cueId]).join('~')}`)
    .sort();
  assert.deepStrictEqual(clientSide, serverSide, '客户端与服务端检出的违规应完全一致');
}

console.log('重叠检测与前后端一致性测试全部通过 ✓');
