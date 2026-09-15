// 分段协作校对 数据层单元测试（进程内直接驱动）
// 过期场景通过直接把 claim_expires_at 改到过去来模拟（服务重启后期限来自落盘值，同理可验）。
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-unit-'));
process.env.DATA_DIR = dir;

const store = (await import('../server/src/store.js'));
const { db } = await import('../server/src/db.js');
const proof = (await import('../server/src/proof/store.js'));

let passed = 0;
function ok(cond, name, extra) {
  assert(cond, name + (extra ? ' ' + JSON.stringify(extra) : ''));
  passed++;
  console.log('  ✓', name);
}
function throws(fn, re, name) {
  assert.throws(fn, re);
  passed++;
  console.log('  ✓', name);
}

const TTL = 60 * 1000;
function cue(id, start, end, text) {
  return { id, trackId: 't_main', start, end, text: text ?? `句子${id}`, locked: false };
}
function revSnapshot(cues) {
  return {
    duration: 600000,
    tracks: [{ id: 't_main', name: '主轨', color: '#4e8cff', mutexGroup: null }],
    cues,
    settings: {},
  };
}
function commit(pid, base, cues, author, msg) {
  const r = store.submitRevision(pid, { baseRevId: base, snapshot: revSnapshot(cues), author, message: msg });
  if (r.status !== 'committed') throw new Error('准备版本失败：' + JSON.stringify(r).slice(0, 300));
  return r.revision;
}
function expireClaim(segId, at = Date.now() - 1) {
  db.prepare('UPDATE proof_segments SET claim_expires_at=? WHERE id=?').run(at, segId);
}

/* ---------- 准备项目与版本 ---------- */
const { project, revision: rev0 } = store.createProject('协作校对单测', '组织者');
const pid = project.id;
const cuesV1 = [
  cue('c1', 0, 1500, '第一句'),
  cue('c2', 2000, 3500, '第二句'),
  cue('c3', 10000, 11500, '第三句'),
  cue('c4', 12000, 13500, '第四句'),
  cue('c5', 30000, 31500, '第五句'),
];
const rev1 = commit(pid, rev0.id, cuesV1, '组织者', '基准版');
// 在旧版本 rev1 上再往前走两步（批次基于历史版本 rev1 创建）
const cuesV2 = cuesV1.map((c) => (c.id === 'c2' ? cue('c2', 2000, 3500, '第二句-v2') : c));
const rev2 = commit(pid, rev1.id, cuesV2, '甲', '改了第二句');
const cuesV3 = cuesV2.map((c) => (c.id === 'c4' ? cue('c4', 12000, 13500, '第四句-v3') : c));
const rev3 = commit(pid, rev2.id, cuesV3, '乙', '改了第四句');

/* ---------- 创建：任意历史版本 + 冻结 + 自动切片 ---------- */
throws(() => proof.createBatch(pid, { revisionId: 'nope', gapMs: 2000, maxSegmentMs: 30000, ttlMs: TTL }, '组织者'),
  /基准版本无效/, '基准版本无效被拒绝');
const created = proof.createBatch(pid, { revisionId: rev1.id, title: '首批', gapMs: 2000, maxSegmentMs: 8000, ttlMs: TTL }, '组织者');
const batchId = created.batch.id;
ok(created.batch.baseRevId === rev1.id, '批次挂在任意历史版本 rev1');
const detail = proof.batchDetail(proof.getBatchRow(batchId), {});
// c1,c2（间隔 500）一段；c3,c4（间隔 500）一段；c5 距离 c4 16.5s 一段
ok(detail.segments.length === 3, `按空隙切成 3 段（实际 ${detail.segments.length}）`, detail.segments.map((s) => s.cueIds));
ok(detail.segments[0].cueIds.join() === 'c1,c2' && detail.segments[1].cueIds.join() === 'c3,c4'
  && detail.segments[2].cueIds[0] === 'c5', '片段句子归属正确');
ok(detail.batch.progress.counts.unclaimed === 3, '初始全部未领取');
ok(detail.segments[1].baseChanged === true, 'c4 在 HEAD 已变化：片段标注 baseChanged');
ok(detail.segments[0].baseChanged === true, 'c2 在 HEAD 已变化：片段标注 baseChanged');
ok(detail.segments[2].baseChanged === false, 'c5 未变化');
// 冻结：创建后项目继续编辑不影响批次
commit(pid, rev3.id, cuesV3.map((c) => (c.id === 'c1' ? cue('c1', 0, 1500, '第一句-HEAD再改') : c)), '丁', '再改第一句');
const d0 = proof.segmentDetail(pid, batchId, detail.segments[0].id, '');
ok(d0.segment.baseline.find((b) => b.cue.id === 'c1').cue.text === '第一句', '片段基准内容冻结，不随后续编辑变化');

/* ---------- 领取：并发只有一方成功；本人重复幂等；别人领取中被拒 ---------- */
const [s1, s2, s3] = detail.segments;
const c1 = proof.claim(pid, batchId, s1.id, '审校甲', { clientToken: 'tok-claim-1' });
ok(c1.segment.status === 'editing' && c1.segment.assignee === '审校甲' && c1.segment.claimExpiresAt > Date.now(),
  '审校甲领取成功并带到期时间');
const c1dup = proof.claim(pid, batchId, s1.id, '审校甲', { clientToken: 'tok-claim-1' });
ok(c1dup.deduplicated === true, '同令牌重复领取幂等');
throws(() => proof.claim(pid, batchId, s1.id, '审校乙'), /已被 审校甲 领取/, '并发另一方被拒');

/* ---------- 草稿：只允许本人、校验句子集合/反向区间、乐观锁、令牌幂等 ---------- */
const base1 = s1.cueIds.map((id) => d0.segment.baseline.find((b) => b.cue.id === id).cue);
let ds = proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校甲', content: base1.map((c) => ({ ...c })), baseVersion: 0, clientToken: 'tok-draft-1',
});
ok(ds.draftVersion === 1, '首次保存草稿 version=1');
const dsDup = proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校甲', content: base1.map((c) => ({ ...c })), baseVersion: 0, clientToken: 'tok-draft-1',
});
ok(dsDup.deduplicated === true && dsDup.draftVersion === 1, '同令牌重复保存不产生新版本');
throws(() => proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校乙', content: base1, baseVersion: 0,
}), /只能编辑自己当前领取/, '非领取人不能保存草稿');
throws(() => proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校甲', content: base1.slice(0, 1), baseVersion: 1,
}), /句子集合/, '草稿删句被拒绝');
const added = [...base1, cue('cx', 0, 1, '新句')];
throws(() => proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校甲', content: added, baseVersion: 1,
}), /句子集合/, '草稿加句被拒绝');
throws(() => proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校甲', content: base1.map((c) => c.id === 'c1' ? { ...c, end: 0 } : c), baseVersion: 1,
}), /反向/, '反向区间草稿被拒绝');
proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校甲', content: base1.map((c) => ({ ...c })), baseVersion: 1,
});
ok(true, '正确 baseVersion 可保存');
// 乐观锁失配
throws(() => proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校甲', content: base1.map((c) => ({ ...c })), baseVersion: 1,
}), /别处已被更新/, '过期 baseVersion 被拒（409）');

/* ---------- 过期：迟到提交被拒、不能覆盖新人草稿；旧草稿保留并在重新领取时续作 ---------- */
expireClaim(s1.id);
throws(() => proof.submit(pid, batchId, s1.id, { reviewer: '审校甲', clientToken: 'tok-late' }),
  /领取已过期/, '过期领取的提交被拒绝');
// 审校乙趁过期领取；甲的迟到保存也必须拒绝
const c2b = proof.claim(pid, batchId, s1.id, '审校乙');
ok(c2b.segment.assignee === '审校乙' && c2b.segment.status === 'editing', '过期后审校乙领取成功（claim_seq +1）');
throws(() => proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校甲', content: base1.map((c) => ({ ...c })), baseVersion: 2,
}), /(只能编辑自己当前领取|领取已过期)/, '旧领取人迟到保存被拒绝，不能覆盖乙的工作区');
// 乙保存自己的草稿；片段当前草稿是乙的
const bContent = base1.map((c) => c.id === 'c1' ? { ...c, text: '乙改第一句' } : c);
proof.saveDraft(pid, batchId, s1.id, { reviewer: '审校乙', content: bContent, baseVersion: 0 });
const segForB = proof.segmentDetail(pid, batchId, s1.id, '审校乙');
ok(segForB.segment.currentDraft[0].text === '乙改第一句', '当前工作草稿属于乙');
// 甲的草稿仍在（按人保留），但不会被当前工作区引用
const segForA = proof.segmentDetail(pid, batchId, s1.id, '审校甲');
ok(segForA.segment.myDraft && segForA.segment.myDraft.content[0].text === '第一句', '甲的草稿按人保留');
ok(segForA.segment.currentDraft === null, '甲看不到乙的草稿内容');
// 乙释放，甲再领取：恢复甲自己的草稿（不会拿到乙的）
proof.release(pid, batchId, s1.id, '审校乙');
const reA = proof.claim(pid, batchId, s1.id, '审校甲');
const segA2 = proof.segmentDetail(pid, batchId, s1.id, '审校甲');
ok(reA.segment.assignee === '审校甲' && segA2.segment.currentDraft[0].text === '第一句',
  '甲重新领取后恢复的是自己的草稿，不是乙的');

/* ---------- 续期 / 释放 ---------- */
const oldExp = reA.segment.claimExpiresAt;
expireClaim(s1.id);
throws(() => proof.renew(pid, batchId, s1.id, '审校甲'), /过期或不存在/, '过期后续期被拒');
const c3a = proof.claim(pid, batchId, s1.id, '审校甲');
const rn = proof.renew(pid, batchId, s1.id, '审校甲', { clientToken: 'tok-renew' });
ok(rn.segment.claimExpiresAt >= c3a.segment.claimExpiresAt, '续期后到期时间延后');
const rnDup = proof.renew(pid, batchId, s1.id, '审校甲', { clientToken: 'tok-renew' });
ok(rnDup.deduplicated === true, '续期重复请求幂等');
throws(() => proof.renew(pid, batchId, s1.id, '审校乙'), /只有当前领取人/, '他人不能续期');
proof.release(pid, batchId, s1.id, '审校甲', { clientToken: 'tok-release' });
const relDup = proof.release(pid, batchId, s1.id, '审校甲', { clientToken: 'tok-release' });
ok(relDup.deduplicated === true, '释放重复请求幂等');
ok(proof.batchDetail(proof.getBatchRow(batchId), {}).segments[0].status === 'unclaimed', '释放后回到未领取');

/* ---------- 提交 / 退回附理由 / 再次提交 ---------- */
proof.claim(pid, batchId, s1.id, '审校甲');
proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校甲',
  content: base1.map((c) => c.id === 'c1' ? { ...c, text: '第一句-校对' } : c),
  baseVersion: 2,
});
const sub1 = proof.submit(pid, batchId, s1.id, { reviewer: '审校甲', clientToken: 'tok-submit-1' });
ok(sub1.submission.status === 'submitted' && sub1.submission.seq === 1 && sub1.segment.status === 'review', '提交成功进入待审核');
const sub1dup = proof.submit(pid, batchId, s1.id, { reviewer: '审校甲', clientToken: 'tok-submit-1' });
ok(sub1dup.deduplicated === true && sub1dup.submission.seq === 1, '同令牌重复提交不产生重复记录');
throws(() => proof.submit(pid, batchId, s1.id, { reviewer: '审校甲' }), /已提交/, '审核中再次提交被拒');
throws(() => proof.saveDraft(pid, batchId, s1.id, {
  reviewer: '审校甲', content: base1, baseVersion: 3,
}), /待审核/, '待审核片段不能再改草稿');
throws(() => proof.returnSegment(pid, batchId, s1.id, { reason: '' }, '组织者'), /退回必须填写理由/, '退回无理由被拒');
const ret = proof.returnSegment(pid, batchId, s1.id, { reason: '第一句术语不对' }, '组织者');
ok(ret.segment.status === 'returned' && ret.segment.returnReason === '第一句术语不对'
  && ret.segment.claimExpiresAt > Date.now(), '退回附理由并给领取人新一轮有效期');
// 改后再次提交：新一行记录
const retContent = base1.map((c) => c.id === 'c1' ? { ...c, text: '第一句-校对修订' } : c);
proof.saveDraft(pid, batchId, s1.id, { reviewer: '审校甲', content: retContent, baseVersion: 3 });
const sub2 = proof.submit(pid, batchId, s1.id, { reviewer: '审校甲', clientToken: 'tok-submit-2' });
ok(sub2.submission.seq === 2, '退回后再次提交生成 seq=2 的新记录');
const subs = proof.segmentDetail(pid, batchId, s1.id, '审校甲').segment.submissions;
ok(subs.length === 2 && subs[0].status === 'returned' && subs[1].status === 'submitted', '提交历史：退回 + 新提交');

/* ---------- 组织者指派 / 重新指派 ---------- */
// 空闲片段指派给乙
const a2 = proof.assign(pid, batchId, s2.id, { assignee: '审校乙' }, '组织者');
ok(a2.segment.assignee === '审校乙' && a2.segment.status === 'editing' && a2.reassigned === false, '空闲片段指派');
// 改派：乙 -> 丙（乙的草稿保留）
const base2 = proof.segmentDetail(pid, batchId, s2.id, '审校乙').segment.baseline;
proof.saveDraft(pid, batchId, s2.id, {
  reviewer: '审校乙', content: base2.map((x) => x.cue), baseVersion: 0,
});
const ra = proof.assign(pid, batchId, s2.id, { assignee: '审校丙' }, '组织者');
ok(ra.reassigned === true && ra.segment.assignee === '审校丙', '重新指派给丙');
const sd2 = proof.segmentDetail(pid, batchId, s2.id, '审校乙');
ok(sd2.segment.myDraft !== null && sd2.segment.currentDraft === null, '改派后乙草稿保留但不占工作区');
// 丙改派回乙：恢复乙草稿
proof.assign(pid, batchId, s2.id, { assignee: '审校乙' }, '组织者');
const sd2b = proof.segmentDetail(pid, batchId, s2.id, '审校乙');
ok(sd2b.segment.currentDraft !== null && sd2b.segment.draftVersion === 1, '改派回乙时恢复其草稿');
throws(() => proof.assign(pid, batchId, s2.id, { assignee: '审校乙' }, '组织者'), /无需指派/, '指派给当前持有人被拒');

/* ---------- 合并 / 拆分：只允许空闲且无工作历史 ---------- */
throws(() => proof.mergeAdjacent(pid, batchId, s2.id, '组织者'), /领取中/, '领取中片段不能合并');
throws(() => proof.splitSegment(pid, batchId, s2.id, { cueIdsFirst: s2.cueIds.slice(0, 1) }, '组织者'), /领取中/, '领取中片段不能拆分');
// 专用批次：首段含两句，拆分后应是两个片段；再与下一段合并复原
const splitBatch = proof.createBatch(pid, { revisionId: rev1.id, title: '拆分批', gapMs: 2000, maxSegmentMs: 8000, ttlMs: TTL }, '组织者').batch.id;
const sbSegs = proof.batchDetail(proof.getBatchRow(splitBatch), {}).segments;
const [sb1, sb2, sb3] = sbSegs;
const beforeSplit = sbSegs.length;
const split = proof.splitSegment(pid, splitBatch, sb1.id, { cueIdsFirst: sb1.cueIds.slice(0, 1) }, '组织者');
ok(split.segments.length === beforeSplit + 1, '拆分后片段数 +1');
// 后半段仍含两句（c3,c4）：空/跳句的前缀校验对准它
const sbTail = split.segments.find((s) => s.cueIds.join() === 'c3,c4');
throws(() => proof.splitSegment(pid, splitBatch, sbTail.id, { cueIdsFirst: [] }, '组织者'), /非空前缀|缺少/, '空前缀被拒');
throws(() => proof.splitSegment(pid, splitBatch, sbTail.id, { cueIdsFirst: sbTail.cueIds.slice().reverse() }, '组织者'), /连续/, '跳过中间句被拒');
const splitSegs = proof.batchDetail(proof.getBatchRow(splitBatch), {}).segments;
const merged = proof.mergeAdjacent(pid, splitBatch, splitSegs[0].id, '组织者');
ok(merged.segments.length === beforeSplit, '与下一段合并后数量复原');
ok(merged.segments.map((s) => s.seq).join() === '1,2,3', '合并/拆分后序号连续重排');

/* ---------- 接受：多片段 → 一个新版本；HEAD 已变化时逐段报告冲突且不部分写入 ---------- */
// s2 由乙提交（c3,c4；c4 与 HEAD 的 v3 改动会冲突）
const base2c = proof.segmentDetail(pid, batchId, s2.id, '审校乙').segment.baseline.map((x) => x.cue);
proof.saveDraft(pid, batchId, s2.id, {
  reviewer: '审校乙',
  content: base2c.map((c) => c.id === 'c3' ? { ...c, text: '第三句-乙校对' } : { ...c, text: '第四句-乙校对' }),
  baseVersion: 1,
});
const subS2 = proof.submit(pid, batchId, s2.id, { reviewer: '审校乙' });
ok(subS2.segment.status === 'review', 's2 提交待审');
const headBefore = store.getProject(pid).head_id;
const acceptAttempt = () => proof.accept(pid, {
  batchId, segmentIds: [s1.id, s2.id], author: '组织者', clientToken: 'tok-accept-1',
});
let conflictErr;
try { acceptAttempt(); } catch (e) { conflictErr = e; }
ok(conflictErr && conflictErr.status === 409 && conflictErr.extra.code === 'conflicts', '存在冲突：返回 409');
const rep = conflictErr.extra.report;
ok(rep.length === 2, '逐段报告（2 段）');
const rS1 = rep.find((x) => x.segmentId === s1.id);
const rS2 = rep.find((x) => x.segmentId === s2.id);
ok(rS1.result === 'conflict' && rS1.conflicts.some((c) => c.cueId === 'c1'), 's1：c1 与 HEAD 双方修改 → 冲突');
ok(rS2.result === 'conflict' && rS2.conflicts.some((c) => c.cueId === 'c4'), 's2：c4 与 HEAD 双方修改 → 冲突');
ok(store.getProject(pid).head_id === headBefore, '冲突时未产生新版本（无部分写入）');
ok(db.prepare("SELECT COUNT(*) n FROM proof_segments WHERE status='merged'").get().n === 0, '冲突时没有任何片段被标记合入');

// 携带逐段人工选择后重新接受 → 一个新版本
const resolutions = {
  [s1.id]: { c1: 'mine' },       // c1 采用审校稿（HEAD 的改动放弃）
  [s2.id]: { c3: 'mine', c4: 'theirs' }, // c3 用审校稿，c4 保留 HEAD
};
const acc = proof.accept(pid, {
  batchId, segmentIds: [s1.id, s2.id], resolutions, author: '组织者', message: '接受前两段', clientToken: 'tok-accept-2',
});
ok(acc.status === 'committed', '冲突全部解决：接受成功');
ok(acc.revision.kind === 'proof', '生成 kind=proof 新版本');
const head = store.getRevision(store.getProject(pid).head_id);
const byId = Object.fromEntries(head.snapshot.cues.map((c) => [c.id, c]));
ok(byId.c1.text === '第一句-校对修订', 'c1 采用审校稿（mine）');
ok(byId.c3.text === '第三句-乙校对', 'c3 自动合入审校稿');
ok(byId.c4.text === '第四句-v3', 'c4 按选择保留 HEAD（theirs）');
ok(byId.c5.text === '第五句', '未接受的 s3 保持 HEAD 原样');
const after = proof.batchDetail(proof.getBatchRow(batchId), {});
ok(after.segments.find((x) => x.id === s1.id).status === 'merged'
  && after.segments.find((x) => x.id === s2.id).status === 'merged', '两段标记已合入');
ok(after.segments.find((x) => x.id === s1.id).mergedRevId === acc.revision.id, '片段记录合入版本');

// 接受令牌幂等：重发不产生新版本
const accDup = proof.accept(pid, {
  batchId, segmentIds: [s1.id, s2.id], resolutions, author: '组织者', clientToken: 'tok-accept-2',
});
// 片段已 merged，正常路径会 400；令牌检查在前，返回幂等结果
ok(accDup.deduplicated === true && accDup.revisionId === acc.revision.id, '接受重复请求幂等（不产生新版本）');

/* ---------- 无变化片段接受：不标记 merged，不产生空版本 ---------- */
const created2 = proof.createBatch(pid, { revisionId: head.id, title: '次批', gapMs: 2000, maxSegmentMs: 30000, ttlMs: TTL }, '组织者');
const b2 = created2.batch.id;
const [u1] = proof.batchDetail(proof.getBatchRow(b2), {}).segments;
proof.claim(pid, b2, u1.id, '审校甲');
const ub = proof.segmentDetail(pid, b2, u1.id, '审校甲').segment.baseline.map((x) => x.cue);
proof.saveDraft(pid, b2, u1.id, { reviewer: '审校甲', content: ub, baseVersion: 0 });
proof.submit(pid, b2, u1.id, { reviewer: '审校甲' });
throws(() => proof.accept(pid, { batchId: b2, segmentIds: [u1.id], author: '组织者' }), /没有可合入的修改/,
  '内容与基准一致的片段不会产生空版本');

/* ---------- 个人待办：编辑中/退回/待审核/可领取 ---------- */
// 让 s3 走一个退回流程，验证 todos 分类
proof.claim(pid, batchId, s3.id, '审校丙');
const base3 = proof.segmentDetail(pid, batchId, s3.id, '审校丙').segment.baseline.map((x) => x.cue);
proof.saveDraft(pid, batchId, s3.id, { reviewer: '审校丙', content: base3, baseVersion: 0 });
proof.submit(pid, batchId, s3.id, { reviewer: '审校丙' });
proof.returnSegment(pid, batchId, s3.id, { reason: '再检查' }, '组织者');
const todos = proof.myTodos('审校丙', pid);
ok(todos.todos.returned.some((s) => s.id === s3.id), '个人待办：退回片段');
ok(todos.todos.claimable.length >= 0, '个人待办：可领取列表');

/* ---------- 过滤：按状态 / 按人员 ---------- */
const fStatus = proof.batchDetail(proof.getBatchRow(batchId), { status: 'merged' });
ok(fStatus.segments.every((s) => s.status === 'merged') && fStatus.segments.length === 2, '按状态过滤（已合入）');
const fAssignee = proof.batchDetail(proof.getBatchRow(batchId), { assignee: '审校丙' });
ok(fAssignee.segments.every((s) => s.assignee === '审校丙'), '按人员过滤');

/* ---------- 审计顺序：事件自增、动作齐全 ---------- */
const events = proof.listEvents(pid, { batchId }).events;
ok(events.every((e, i) => i === 0 || e.id > events[i - 1].id), '事件 id 严格递增');
const actions = new Set(events.map((e) => e.action));
const splitActions = new Set(proof.listEvents(pid, { batchId: splitBatch }).events.map((e) => e.action));
for (const a of ['create', 'claim', 'renew', 'release', 'assign', 'reassign',
  'draft-save', 'submit', 'return', 'accept']) {
  ok(actions.has(a), `事件流含 ${a}`);
}
ok(splitActions.has('merge') && splitActions.has('split'), '事件流含 merge / split');

/* ---------- 合入后批次完成态 ---------- */
// s3 修改后提交接受（批次首批仅剩它）
const c5new = base3.map((c) => c.id === 'c5' ? { ...c, text: '第五句-校对' } : c);
proof.saveDraft(pid, batchId, s3.id, { reviewer: '审校丙', content: c5new, baseVersion: 1 });
proof.submit(pid, batchId, s3.id, { reviewer: '审校丙' });
const fin = proof.accept(pid, { batchId, segmentIds: [s3.id], author: '组织者' });
ok(fin.batchCompleted === true && proof.getBatchRow(batchId).status === 'completed', '全部合入后批次完成');
ok(store.getRevision(fin.revision.id).snapshot.cues.find((c) => c.id === 'c5').text === '第五句-校对', '最后一段内容合入');

// 事件统计在所有写入完成后采集，供重启一致性比对
const finalEvents = proof.listEvents(pid, { batchId }).events;

/* ---------- edit-delete 冲突：HEAD 删除句子而审校稿改了它，可选择恢复或接受删除 ---------- */
{
  const baseHead = store.getRevision(store.getProject(pid).head_id);
  const delCues = baseHead.snapshot.cues.filter((c) => c.id !== 'c5');
  commit(pid, baseHead.id, delCues, '其他人', 'HEAD 删除 c5');
  const bDel = proof.createBatch(pid, { revisionId: baseHead.id, title: '删除冲突批', gapMs: 100000, maxSegmentMs: 100000, ttlMs: TTL }, '组织者').batch.id;
  const segDel = proof.batchDetail(proof.getBatchRow(bDel), {}).segments[0];
  proof.claim(pid, bDel, segDel.id, '审校甲');
  const baseDel = proof.segmentDetail(pid, bDel, segDel.id, '审校甲').segment.baseline.map((x) => x.cue);
  proof.saveDraft(pid, bDel, segDel.id, {
    reviewer: '审校甲',
    content: baseDel.map((c) => (c.id === 'c5' ? { ...c, text: '第五句-校对恢复' } : c)),
    baseVersion: 0,
  });
  proof.submit(pid, bDel, segDel.id, { reviewer: '审校甲' });
  let delErr;
  try { proof.accept(pid, { batchId: bDel, segmentIds: [segDel.id], author: '组织者' }); } catch (e) { delErr = e; }
  ok(delErr?.status === 409 && delErr.extra.report[0].conflicts.some((c) => c.kind === 'edit-delete' && c.cueId === 'c5'),
    'HEAD 删除 / 审校修改 → edit-delete 冲突逐段报告');
  const accMine = proof.accept(pid, {
    batchId: bDel, segmentIds: [segDel.id],
    resolutions: { [segDel.id]: { c5: 'mine' } }, author: '组织者',
  });
  const restored = store.getRevision(accMine.revision.id).snapshot.cues.find((c) => c.id === 'c5');
  ok(restored && restored.text === '第五句-校对恢复', '选择 mine：恢复审校稿中的句子');
}

/* ---------- 持久化：跨进程重启后期限/草稿/提交/事件顺序一致（子进程新打开同一 DB）---------- */
const { execFileSync } = await import('child_process');
const probe = execFileSync(process.execPath, ['-e', `
  const proof = require(${JSON.stringify(path.resolve('server/src/proof/store.js'))});
  const { db } = require(${JSON.stringify(path.resolve('server/src/db.js'))});
  const reopened = proof.batchDetail(proof.getBatchRow(${JSON.stringify(batchId)}), {});
  const out = {
    allMerged: reopened.segments.every((s) => s.status === 'merged'),
    segCount: reopened.segments.length,
    eventCount: proof.listEvents(${JSON.stringify(pid)}, { batchId: ${JSON.stringify(batchId)} }).events.length,
    firstEventId: db.prepare('SELECT MIN(id) a FROM proof_events WHERE batch_id=?').get(${JSON.stringify(batchId)}).a,
    lastEventId: db.prepare('SELECT MAX(id) a FROM proof_events WHERE batch_id=?').get(${JSON.stringify(batchId)}).a,
    submissions: db.prepare('SELECT COUNT(*) n FROM proof_submissions WHERE batch_id=?').get(${JSON.stringify(batchId)}).n,
    drafts: db.prepare('SELECT COUNT(*) n FROM proof_drafts WHERE batch_id=?').get(${JSON.stringify(batchId)}).n,
    batchStatus: proof.getBatchRow(${JSON.stringify(batchId)}).status,
  };
  process.stdout.write(JSON.stringify(out));
`], { encoding: 'utf8' });
const persisted = JSON.parse(probe);
ok(persisted.allMerged && persisted.batchStatus === 'completed', '重启后片段状态与批次完成态保持');
ok(persisted.eventCount === finalEvents.length
  && persisted.firstEventId === finalEvents[0].id && persisted.lastEventId === finalEvents.at(-1).id,
  '重启后事件数量与顺序一致');
ok(persisted.submissions >= 4, '重启后提交记录保持');
ok(persisted.drafts >= 3, '重启后草稿保持（按人保留）');

console.log(`\n分段协作校对数据层单元测试全部通过（${passed} 项断言）`);
