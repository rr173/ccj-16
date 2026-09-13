// 质检规则引擎 + 导出/对比 单元测试
const assert = require('assert');
const rules = require('../server/src/qc/rules');
const { renderSrt, renderVtt, renderFiles } = require('../server/src/qc/exporter');
const { diffSnapshots } = require('../server/src/qc/diff');

let passed = 0;
function ok(cond, name) {
  assert(cond, name);
  passed++;
  console.log('  ✓', name);
}

const snap = {
  duration: 600000,
  tracks: [
    { id: 't1', name: '主轨', color: '#fff', mutexGroup: null },
    { id: 't2', name: '副轨', color: '#eee', mutexGroup: null },
  ],
  cues: [
    { id: 'c1', trackId: 't1', start: 0, end: 200, text: '太短', locked: false },          // 时长过短
    { id: 'c2', trackId: 't1', start: 1000, end: 12000, text: '这句太长了', locked: false }, // 时长过长
    { id: 'c3', trackId: 't1', start: 12100, end: 13000, text: '间隔不足', locked: false },  // 与 c2 间隔 100ms
    { id: 'c4', trackId: 't1', start: 20000, end: 21000, text: '阅读速度超标的一段文字内容', locked: false }, // 12字/1s = 12cps
    { id: 'c5', trackId: 't1', start: 30000, end: 31000, text: 'x'.repeat(50), locked: false }, // 单行 50 字符
    { id: 'c6', trackId: 't1', start: 40000, end: 41000, text: '正常句', locked: false },
    { id: 'd1', trackId: 't2', start: 40050, end: 41130, text: '跨轨未对齐', locked: false }, // 与 c6 起点差 50/终点差 130
  ],
  settings: {},
};

const scoped = {
  '': {
    duration: { enabled: true, severity: 'blocker', params: { minMs: 500, maxMs: 10000 } },
    cps: { enabled: true, severity: 'warning', params: { maxCps: 10 } },
    line_chars: { enabled: true, severity: 'warning', params: { maxChars: 42 } },
    gap: { enabled: true, severity: 'warning', params: { minGapMs: 200 } },
    align: { enabled: true, severity: 'blocker', params: { toleranceMs: 100, trackA: '', trackB: '' } },
  },
};

console.log('质检规则引擎');
const findings = rules.computeFindings(snap, scoped);
const byCueRule = (cue, rule) => findings.filter((f) => f.cueId === cue && f.ruleKey === rule);

ok(byCueRule('c1', 'duration').length === 1, 'c1 时长过短被检出');
ok(byCueRule('c1', 'duration')[0].severity === 'blocker', 'c1 时长问题为阻断级');
ok(byCueRule('c1', 'duration')[0].suggestion.safe === true, 'c1 延长结束安全（后方无冲突）');
ok(byCueRule('c1', 'duration')[0].suggestion.patch.end === 500, 'c1 建议延长到 start+minMs');

ok(byCueRule('c2', 'duration').length === 1, 'c2 时长过长被检出');
ok(byCueRule('c2', 'duration')[0].suggestion.patch.end === 11000, 'c2 建议缩短到 start+maxMs');

ok(byCueRule('c2', 'gap').length === 1, 'c2 与 c3 间隔不足被检出（挂在 c2 上）');
ok(byCueRule('c2', 'gap')[0].actual.value === 100, '间隔实际值 100ms');
ok(byCueRule('c2', 'gap')[0].suggestion.patch.end === 11900, '间隔建议提前结束留出 200ms');

ok(byCueRule('c4', 'cps').length === 1, 'c4 阅读速度超标被检出');
ok(byCueRule('c4', 'cps')[0].actual.value === 13, 'cps 实际值 13 字/秒');
ok(byCueRule('c4', 'cps')[0].suggestion.patch.end === 21300, 'cps 建议延长结束到 字/上限 时长');

ok(byCueRule('c5', 'line_chars').length === 1, 'c5 单行字符超标被检出');
ok(byCueRule('c5', 'line_chars')[0].suggestion.kind === 'manual', '断行只能人工处理');
ok(byCueRule('c5', 'line_chars')[0].suggestion.safe === false, '人工项不可自动修复');

ok(byCueRule('c6', 'align').length === 1, 'c6 与 d1 跨轨对齐误差被检出');
ok(byCueRule('c6', 'align')[0].actual.endDiff === 130, '终点差 130ms');
ok(byCueRule('c6', 'align')[0].suggestion.patch.start === 40050, '对齐建议贴到对方起止');

ok(byCueRule('c6', 'duration').length === 0, '正常句不误报');
ok(findings.every((f) => f.basis && typeof f.basis.start === 'number' && typeof f.basis.text === 'string'), '每条 finding 带句子基准值');
ok(findings.every((f) => f.evidence && f.evidence.length > 0), '每条 finding 带证据');

// 轨道级覆盖：t1 的 cps 放宽到 20 后 c4 不再报
const scoped2 = JSON.parse(JSON.stringify(scoped));
scoped2.t1 = { cps: { enabled: true, severity: 'warning', params: { maxCps: 20 } } };
const f2 = rules.computeFindings(snap, scoped2);
ok(!f2.some((f) => f.cueId === 'c4' && f.ruleKey === 'cps'), '轨道级覆盖生效（t1 放宽 cps）');
ok(f2.some((f) => f.cueId === 'c1'), '覆盖一条规则不影响其他规则');

// 锁定句不提供安全自动修复
const snapLocked = JSON.parse(JSON.stringify(snap));
snapLocked.cues[0].locked = true;
const f3 = rules.computeFindings(snapLocked, scoped);
ok(f3.find((f) => f.cueId === 'c1').suggestion.safe === false, '锁定句建议标记为不安全');

// 延长会撞上后句时不安全
const snapCrowd = JSON.parse(JSON.stringify(snap));
snapCrowd.cues[1].start = 300; // c2 挪到 c1 后方 300ms 处
const f4 = rules.computeFindings(snapCrowd, scoped);
ok(f4.find((f) => f.cueId === 'c1' && f.ruleKey === 'duration').suggestion.safe === false, '延长撞上后句时标记不安全');

// 规则校验
assert.throws(() => rules.normalizeRulesConfig({ duration: { params: { minMs: 9000, maxMs: 100 } } }), /下限不能大于上限/);
ok(true, '时长下限>上限被拒绝');
assert.throws(() => rules.normalizeRulesConfig({ cps: { severity: 'fatal' } }), /严重级别/);
ok(true, '非法严重级别被拒绝');

console.log('SRT/VTT 渲染');
const files = renderFiles(snap);
ok(files.srt.all.startsWith('1\n00:00:00,000 --> 00:00:00,200\n太短'), 'SRT 序号/时间格式正确');
ok(files.vtt.all.startsWith('WEBVTT\n\n00:00:00,000.000'.replace(',000.', '.')), 'VTT 头正确');
ok(files.vtt.all.includes('00:00:00.000 --> 00:00:00.200'), 'VTT 时间用点号毫秒');
ok(files.srt.t1.includes('正常句') && !files.srt.t1.includes('跨轨未对齐'), '按轨道拆分文件');
ok(files.srt.t2.includes('跨轨未对齐'), '副轨文件包含副轨句');

console.log('快照逐句对比');
const later = JSON.parse(JSON.stringify(snap));
later.cues[0].text = '改过的文本';
later.cues[1].end = 11500;
later.cues.push({ id: 'c9', trackId: 't1', start: 50000, end: 51000, text: '新增', locked: false });
later.cues = later.cues.filter((c) => c.id !== 'c6');
const d = diffSnapshots(snap, later);
ok(d.summary.cues.changed === 2 && d.summary.cues.added === 1 && d.summary.cues.removed === 1, '差异统计正确');
ok(d.cues.find((c) => c.id === 'c1').changes.text.to === '改过的文本', '文本变更逐字段记录');
ok(d.cues.find((c) => c.id === 'c2').changes.end.to === 11500, '时间变更逐字段记录');
ok(d.cues.find((c) => c.id === 'c9').type === 'added' && d.cues.find((c) => c.id === 'c6').type === 'removed', '新增/删除识别');

console.log(`\n全部通过（${passed + 2} 项断言）`);
