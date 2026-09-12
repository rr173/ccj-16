'use strict';
// 批量导入：解析 / 字段映射 / 逐项校验 / 应用 / 回滚 单测
const assert = require('assert');
const { parseSubtitle, parseTimeMs, buildPreview, applyImport, planRollback } = require('../server/src/importer');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

/* ---- 时间解析 ---- */
assert.strictEqual(parseTimeMs('00:00:01,500'), 1500);
assert.strictEqual(parseTimeMs('00:00:01.500'), 1500); // VTT 点号
assert.strictEqual(parseTimeMs('1:2:3'), 3723000);
assert.strictEqual(parseTimeMs(2500), 2500);
assert.strictEqual(parseTimeMs('1:30,000'), 90000); // MM:SS,mmm
assert.strictEqual(parseTimeMs('abc'), null);
assert.strictEqual(parseTimeMs(''), null);

/* ---- SRT ---- */
const srt = `1
00:00:01,000 --> 00:00:02,000
唯一合法句

2
00:00:03,000 --> 00:00:04,000
第一行

3
xx --> yy
坏时间

4
00:00:05,000 --> 00:00:04,000
反向

5
00:00:06,000 --> 00:00:07,000
第一行
`;
const snap = {
  duration: 600000, settings: {},
  tracks: [
    { id: 't1', name: '主轨', color: '#000', mutexGroup: null },
    { id: 't2', name: '副轨', color: '#111', mutexGroup: null },
  ],
  cues: [
    { id: 'c1', trackId: 't1', start: 1000, end: 2000, text: '项目已有句', locked: false },
    { id: 'clocked', trackId: 't1', start: 9000, end: 10000, text: '锁定句', locked: true },
  ],
};
const pv = buildPreview(snap, srt, { defaultTrackId: 't1' }, 'a.srt');
ok(pv.format === 'srt', '识别为 SRT');
ok(pv.rows.length === 5, '解析出 5 行: ' + pv.rows.length);
const bySeq = Object.fromEntries(pv.rows.map((r) => [r.seq, r]));
ok(bySeq[1].startMs === 1000 && bySeq[1].endMs === 2000, '时间解析为毫秒');
ok(bySeq[5].issues.some((i) => i.code === 'dup-file'), '文件内重复检出');
ok(bySeq[3].issues.filter((i) => i.code === 'time-bad').length === 2, '起止均为非法时间');
ok(bySeq[4].issues.some((i) => i.code === 'time-reverse'), '反向区间检出');
ok(!bySeq[3].editable && !bySeq[4].editable && !bySeq[5].editable, '问题行（非法/反向/后现重复）不可勾选');
ok(bySeq[1].editable && bySeq[1].included, '合法行默认勾选');
ok(bySeq[2].editable, '重复文本的首次出现行本身合法');

// 项目内重复
const dup = buildPreview(snap, '1\n00:00:10,000 --> 00:00:11,000\n项目已有句\n', { defaultTrackId: 't1' });
ok(dup.rows[0].issues.some((i) => i.code === 'dup-project'), '项目内同文重复检出');
ok(!dup.rows[0].editable, '重复行不可勾选');

// 同槽锁定
const locked = buildPreview(snap, '1\n00:00:09,000 --> 00:00:10,000\n覆盖锁定句\n', { defaultTrackId: 't1' });
ok(locked.rows[0].issues.some((i) => i.code === 'locked'), '同槽锁定句检出');

// 同槽未锁定 -> 修改
const upd = buildPreview(snap, '1\n00:00:01,000 --> 00:00:02,000\n改写同槽\n', { defaultTrackId: 't1' });
ok(upd.rows[0].action === 'update' && upd.rows[0].targetCueId === 'c1', '同槽不同文识别为修改');

// 未知轨 / 自动建轨
const csvMulti = 'start,end,text,track\n00:00:01,000,00:00:02,000,句,日语';
const unknown = buildPreview(snap, csvMulti, {}, 'x.csv');
ok(unknown.rows[0].issues.some((i) => i.code === 'unknown-track'), '未知轨道报错');
const auto = buildPreview(snap, csvMulti, { createMissingTracks: true }, 'x.csv');
ok(auto.trackSources[0].status === 'new', 'createMissingTracks 时标记新建');
ok(auto.rows[0].trackId === '__new__', '新轨行 trackId 占位为 __new__');

/* ---- CSV 表头/位置/分隔符 ---- */
const csvCommaMs = 'start,end,text,track\n00:00:01,000,00:00:02,000,中文,主轨';
const p1 = buildPreview(snap, csvCommaMs, {}, 'x.csv');
ok(p1.rows[0].startMs === 1000 && p1.rows[0].endMs === 2000 && p1.rows[0].text === '中文', '未引用的逗号毫秒不错位列');

const tsv = '开始\t结束\t文本\n00:00:01,000\t00:00:02,000\tTSV句';
const p2 = buildPreview(snap, tsv, { defaultTrackId: 't1' }, 'x.tsv');
ok(p2.format === 'tsv' && p2.rows[0].text === 'TSV句' && p2.rows[0].startMs === 1000, 'TSV 表头识别');

const positional = '00:00:01,000,00:00:02,000,无表头句';
const p3 = buildPreview(snap, positional, { defaultTrackId: 't1' }, 'x.csv');
ok(p3.rows[0].text === '无表头句' && p3.rows[0].endMs === 2000, '无表头按位置猜测');

const badJson = buildPreview(snap, '{bad', { defaultTrackId: 't1' }, 'x.json');
ok(badJson.parseError, '坏 JSON 给出 parseError 而非抛异常');

const js = buildPreview(snap, JSON.stringify([{ start: 1000, end: 2000, text: 'J句' }]), { defaultTrackId: 't1' }, 'x.json');
ok(js.format === 'json' && js.rows[0].text === 'J句', 'JSON 数组解析');

/* ---- 应用：只应用合法勾选项，服务端强制 ---- */
let n = 100;
const idGen = (p) => p + (++n);
const inc = pv.rows.filter((r) => r.editable).map((r) => r.seq);
ok(JSON.stringify(inc) === JSON.stringify([1, 2]), '合法行为第 1、2 行: ' + JSON.stringify(inc));
// 客户端试图把非法/重复行也塞进 included，服务端必须拒绝
const evil = [...inc, 3, 4, 5];
const applied = applyImport(snap, pv, evil, idGen);
ok(applied.added.length === 1 && applied.updated.length === 1, '合法行 1 新增 1 修改，非法行不应用: a=' + applied.added.length + ' u=' + applied.updated.length);
ok(applied.skips.length === 3, '其余 3 行登记跳过: ' + applied.skips.length);
const reasons = new Set(applied.skips.map((s) => s.reason));
ok(reasons.has('dup-file') && reasons.has('time-bad') && reasons.has('time-reverse'), '跳过原因覆盖各类问题: ' + JSON.stringify([...reasons]));

// 新建轨道应用
const appliedAuto = applyImport(snap, auto, [1], idGen);
ok(appliedAuto.addedTracks.length === 1 && appliedAuto.addedTracks[0].name === '日语', '导入创建新轨');
ok(appliedAuto.snapshot.cues.find((c) => c.text === '句').trackId === appliedAuto.addedTracks[0].id, '新句落在新轨');

/* ---- 回滚 ---- */
const pre = snap;
const impSnap = applied.snapshot;
const meta = { addedCueIds: applied.added, updated: applied.updated, addedTracks: applied.addedTracks };
const rb = planRollback(pre, meta, JSON.parse(JSON.stringify(impSnap)));
ok(rb.rolledCueIds.length === 2, '干净回滚覆盖新增删除与修改恢复: ' + rb.rolledCueIds.length);
ok(rb.skipped.length === 0, '干净回滚无跳过');

// 导入后句子被修改 -> 跳过（两条导入句中改一条）
const changed = JSON.parse(JSON.stringify(impSnap));
changed.cues.find((c) => c.id === applied.added[0].cueId).text = '他人改了';
const rb2 = planRollback(pre, meta, changed);
ok(rb2.rolledCueIds.length === 1, '只回滚未被改动的另一条: ' + rb2.rolledCueIds.length);
ok(rb2.skipped[0].reason === 'changed-after-import', '跳过原因为 changed-after-import');

// 导入后新增句被删除 -> 跳过；修改句 c1 仍在 -> 照常回滚
const deleted = JSON.parse(JSON.stringify(impSnap));
deleted.cues = deleted.cues.filter((c) => c.id !== applied.added[0].cueId);
const rb3 = planRollback(pre, meta, deleted);
ok(rb3.skipped.length === 1 && rb3.skipped[0].reason === 'deleted-after-import', '已删除的新增句跳过原因正确');
ok(deleted.cues.find((c) => c.id === 'c1').text !== '项目已有句', '前提：删除快照中 c1 仍是导入值');

// 修改型导入的回滚
const updApplied = applyImport(snap, upd, [1], idGen);
const c1After = updApplied.snapshot.cues.find((c) => c.id === 'c1');
ok(c1After.text === '改写同槽' && c1After.start === 1000 && c1After.end === 2000, '修改型导入写入新文本');
const rb4 = planRollback(snap, { addedCueIds: [], updated: updApplied.updated, addedTracks: [] }, JSON.parse(JSON.stringify(updApplied.snapshot)));
const c1Restored = rb4.snapshot.cues.find((c) => c.id === 'c1');
ok(c1Restored.text === '项目已有句' && c1Restored.end === 2000, '回滚恢复修改前的值');

console.log(`导入/回滚 ${passed} 项测试全部通过 ✓`);
