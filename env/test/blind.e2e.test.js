// 端到端：多版本字幕盲审对照
// 创建（冻结/校验）→ 盲审（匿名顺序/保存续作/幂等/并发提示）→ 提交 → 门槛前禁揭示禁关闭
// → 拒绝后重提 → 揭示来源 → 关闭生成冻结结果（平票保留）→ 关闭后只读 → 操作记录与审计
import match from '../server/src/blind/match.js';
const BASE = 'http://localhost:3000';

async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

let failures = 0;
function ok(cond, name, extra = '') {
  console.log(cond ? '  ✓' : '  ✗', name, cond ? '' : extra);
  if (!cond) failures++;
}

async function submit(pid, baseRevId, snapshot, author, message) {
  const r = await j('POST', `/api/projects/${pid}/revisions`, { baseRevId, snapshot, author, message });
  if (r.status !== 201) throw new Error('提交失败：' + JSON.stringify(r.data));
  return r.data.revision;
}

/* ---------- 准备：项目 + 三个版本 ---------- */
console.log('多版本字幕盲审对照：端到端');
const { data: created } = await j('POST', '/api/projects', { name: '盲审项目', author: '组织者' });
const pid = created.project.id;
const rev0 = created.revision;

const tracks = [{ id: 't_main', name: '主轨', color: '#4e8cff', mutexGroup: null }];
const snap1 = {
  ...rev0.snapshot,
  tracks,
  cues: [
    { id: 'c1', trackId: 't_main', start: 0, end: 1500, text: '开场白内容', locked: false },
    { id: 'c2', trackId: 't_main', start: 2000, end: 3500, text: '第二句需要校对的内容', locked: false },
    { id: 'c3', trackId: 't_main', start: 4000, end: 5000, text: '第三句保持原样', locked: false },
    { id: 'c4', trackId: 't_main', start: 6000, end: 7000, text: '第四句将被删除', locked: false },
    { id: 'c5', trackId: 't_main', start: 8000, end: 9000, text: '第五句大家一样', locked: false },
  ],
};
const rev1 = await submit(pid, rev0.id, snap1, '甲', '第一版');
const snap2 = {
  ...snap1,
  cues: [
    { id: 'c1', trackId: 't_main', start: 0, end: 1500, text: '开场白内容修订版', locked: false },
    { id: 'c2', trackId: 't_main', start: 2000, end: 3500, text: '第二句校对后的内容', locked: false },
    { id: 'c3', trackId: 't_main', start: 4000, end: 5000, text: '第三句略有改动', locked: false },
    { id: 'c5', trackId: 't_main', start: 8000, end: 9000, text: '第五句乙版修订', locked: false },
    { id: 'c6', trackId: 't_main', start: 10000, end: 11000, text: '第二版新增的句子', locked: false },
  ],
};
const rev2 = await submit(pid, rev1.id, snap2, '乙', '第二版');
const snap3 = {
  ...snap1,
  cues: [
    { id: 'c1', trackId: 't_main', start: 0, end: 1500, text: '开场白内容再修订', locked: false },
    { id: 'c2', trackId: 't_main', start: 2000, end: 3500, text: '第二句需要校对的内容', locked: false },
    { id: 'c3', trackId: 't_main', start: 4000, end: 5000, text: '第三句保持原样', locked: false },
    { id: 'c4', trackId: 't_main', start: 6000, end: 7000, text: '第四句将被删除', locked: false },
    { id: 'c5', trackId: 't_main', start: 8000, end: 9000, text: '第五句丙版调整', locked: false },
    { id: 'c7', trackId: 't_main', start: 12000, end: 13000, text: '第三版独有的一句新内容', locked: false },
  ],
};
const rev3 = await submit(pid, rev2.id, snap3, '丙', '第三版');

/* ---------- 创建：参数校验 ---------- */
let r = await j('POST', `/api/projects/${pid}/blind-rounds`, { revisionIds: [rev1.id], minSubmitters: 2, author: '组织者' });
ok(r.status === 400, '只选 1 个版本被拒绝');
r = await j('POST', `/api/projects/${pid}/blind-rounds`, { revisionIds: [rev1.id, rev2.id, rev3.id, rev0.id], minSubmitters: 2, author: '组织者' });
ok(r.status === 400, '超过 3 个版本被拒绝');
r = await j('POST', `/api/projects/${pid}/blind-rounds`, { revisionIds: [rev1.id, rev1.id], minSubmitters: 2, author: '组织者' });
ok(r.status === 400, '去重后不足 2 个版本被拒绝');
r = await j('POST', `/api/projects/${pid}/blind-rounds`, { revisionIds: [rev1.id, rev2.id], minSubmitters: 0, author: '组织者' });
ok(r.status === 400, '最少有效提交人数为 0 被拒绝');
const { data: other } = await j('POST', '/api/projects', { name: '别的项目', author: 'x' });
r = await j('POST', `/api/projects/${pid}/blind-rounds`, { revisionIds: [rev1.id, other.revision.id], minSubmitters: 1, author: '组织者' });
ok(r.status === 400, '跨项目版本被拒绝');

/* ---------- 创建：冻结与分组 ---------- */
r = await j('POST', `/api/projects/${pid}/blind-rounds`, {
  revisionIds: [rev1.id, rev2.id, rev3.id], minSubmitters: 2, title: '三版盲审', author: '组织者',
});
ok(r.status === 201 && r.data.round.id, '创建盲审轮次（3 个版本）');
const round = r.data.round;
const rid = round.id;
ok(round.item_count === 5 && round.unmatched_count === 2, `对照分组正确（5 组对照 + 2 条单列）`, `items=${round.item_count} unmatched=${round.unmatched_count}`);
ok(round.versions.length === 3 && round.items.find((i) => i.key === 'id:c4').candidates.length === 2,
  '创建响应向组织者回执冻结内容（c4 为两候选组）');

// 创建后项目继续编辑不影响轮次（冻结）
await submit(pid, rev3.id, { ...snap3, cues: [] }, '丁', '清空全部');
const frozenCheck = await j('GET', `/api/blind-rounds/${rid}/review?reviewer=审阅甲`);
ok(frozenCheck.data.items.length === 5, '项目后续编辑不影响已冻结的轮次内容');

/* ---------- 列表/详情/审阅视图不泄露来源 ---------- */
const list0 = await j('GET', `/api/projects/${pid}/blind-rounds`);
const listJson = JSON.stringify(list0.data);
ok(!listJson.includes(rev1.id) && !listJson.includes(rev2.id) && !listJson.includes(rev3.id),
  '轮次列表不含版本来源');
const detail0 = await j('GET', `/api/projects/${pid}/blind-rounds/${rid}`);
ok(!JSON.stringify(detail0.data).includes(rev1.id) && detail0.data.round.progress.minSubmitters === 2,
  '组织者详情含进度但揭示前不含来源');

const A = '审阅甲';
const B = '审阅乙';
const reviewA1 = await j('GET', `/api/blind-rounds/${rid}/review?reviewer=${encodeURIComponent(A)}`);
ok(reviewA1.status === 200 && reviewA1.data.items.length === 5, '审阅人进入看到 5 个对照项');
const reviewJson = JSON.stringify(reviewA1.data);
ok(!reviewJson.includes(rev1.id) && !reviewJson.includes(rev2.id) && !reviewJson.includes(rev3.id)
  && !reviewJson.includes('"slot"') && !reviewJson.includes('revisionId') && !reviewJson.includes('cueId'),
  '审阅视图不含版本来源/槽位/句子编号');
ok(reviewA1.data.items.every((it) => it.candidates.every((c) => /^[ABC]$/.test(c.label))),
  '候选以匿名标签 A/B/C 呈现');
ok(reviewA1.data.unmatched.length === 2 && !JSON.stringify(reviewA1.data.unmatched).includes('revisionId'),
  '无法配对内容单列展示且不含来源');

// 同一审阅人顺序稳定；不同审阅人顺序彼此独立（4 个对照项候选文本两版间有差异，可区分顺序）
const reviewA2 = await j('GET', `/api/blind-rounds/${rid}/review?reviewer=${encodeURIComponent(A)}`);
ok(JSON.stringify(reviewA2.data.items) === JSON.stringify(reviewA1.data.items), '同一审阅人候选顺序稳定');
const reviewB1 = await j('GET', `/api/blind-rounds/${rid}/review?reviewer=${encodeURIComponent(B)}`);
const reviewC1 = await j('GET', `/api/blind-rounds/${rid}/review?reviewer=${encodeURIComponent('审阅丙')}`);
const orderOf = (d) => d.data.items.map((it) => it.candidates.map((c) => `${c.label}:${c.text}`).join('|')).join('/');
const orders = [orderOf(reviewA1), orderOf(reviewB1), orderOf(reviewC1)];
ok(new Set(orders).size > 1, '不同审阅人的匿名候选顺序彼此独立');

/* ---------- 保存：续作 / 幂等 / 并发提示 ---------- */
const items = reviewA1.data.items;
const answersA = {};
for (const it of items) answersA[it.key] = { choice: 'equal', candidate: null, comment: '' };
// 先保存一部分（只有 2 项作答）
const partial = {};
const keys = items.map((i) => i.key);
partial[keys[0]] = answersA[keys[0]];
partial[keys[1]] = answersA[keys[1]];
const tokenA1 = 'token-a-1';
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: A, baseVersion: 0, answers: partial, clientToken: tokenA1 });
ok(r.status === 200 && r.data.submission.version === 1 && r.data.submission.answered === 2, '保存部分进度（草稿）');
r = await j('POST', `/api/blind-rounds/${rid}/submit`, { reviewer: A, expectedVersion: 1 });
ok(r.status === 400 && r.data.missing === 3, '未全部作答不能提交');
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: A, baseVersion: 0, answers: partial, clientToken: tokenA1 });
ok(r.status === 200 && r.data.deduplicated === true && r.data.submission.version === 1,
  '同一保存请求重复发送：幂等返回，不产生重复记录');
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: A, baseVersion: 0, answers: partial, clientToken: 'token-a-2' });
ok(r.status === 409 && r.data.current?.version === 1, '过期 baseVersion 并发保存：409 并返回当前结果');
// 刷新后接着原进度继续（重新进入可读到已答 2 项）
const reviewA3 = await j('GET', `/api/blind-rounds/${rid}/review?reviewer=${encodeURIComponent(A)}`);
ok(reviewA3.data.submission.answered === 2 && reviewA3.data.items.find((i) => i.key === keys[0]).myAnswer.choice === 'equal',
  '刷新/重新进入后接着原进度');
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: A, baseVersion: 1, answers: answersA, clientToken: 'token-a-3' });
ok(r.status === 200 && r.data.submission.version === 2 && r.data.submission.answered === 5, '基于最新版本继续保存全部作答');
// 非法选择
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: A, baseVersion: 2, answers: { [keys[0]]: { choice: 'better', candidate: 'Z' } } });
ok(r.status === 400, '非法候选标签被拒绝');
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: A, baseVersion: 2, answers: { 'id:不存在': { choice: 'equal' } } });
ok(r.status === 400, '未知对照项被拒绝');

/* ---------- 提交：需全部作答 ---------- */
const answersB = {};
for (const it of reviewB1.data.items) answersB[it.key] = { choice: 'equal', candidate: null, comment: '' };
r = await j('POST', `/api/blind-rounds/${rid}/submit`, { reviewer: B, clientToken: 'token-b-0' });
ok(r.status === 400, '未作答不能提交');
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: B, baseVersion: 0, answers: answersB, clientToken: 'token-b-1' });
ok(r.status === 200 && r.data.submission.answered === 5, '审阅乙保存全部作答');

/* ---------- 按测试构造投票（甲/乙对部分项投不同候选 → 平票保留） ---------- */
// 用服务端同一套确定性映射，把「想投的槽位」翻译成各审阅人的匿名标签
const slotsByKey = {};
for (const it of round.items) slotsByKey[it.key] = it.candidates.map((c) => c.slot);
const labelFor = (reviewer, key, slot) => match.encodeSlot(rid, reviewer, key, slotsByKey[key], slot);
const voteA = { ...answersA };
voteA['id:c1'] = { choice: 'better', candidate: labelFor(A, 'id:c1', 0), comment: '两个版本各有千秋，略倾向这版' };
voteA['id:c2'] = { choice: 'better', candidate: labelFor(A, 'id:c2', 2), comment: '' };
voteA['id:c4'] = { choice: 'better', candidate: labelFor(A, 'id:c4', 0), comment: '' };
voteA['id:c5'] = { choice: 'unknown', candidate: null, comment: '无法判断哪版更好' };
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: A, baseVersion: 2, answers: voteA, clientToken: 'token-a-4' });
ok(r.status === 200 && r.data.submission.version === 3, '审阅甲按构造投票保存');
const voteB = { ...answersB };
voteB['id:c1'] = { choice: 'better', candidate: labelFor(B, 'id:c1', 1), comment: '' };
voteB['id:c2'] = { choice: 'better', candidate: labelFor(B, 'id:c2', 2), comment: '' };
voteB['id:c4'] = { choice: 'better', candidate: labelFor(B, 'id:c4', 0), comment: '' };
voteB['id:c5'] = { choice: 'better', candidate: labelFor(B, 'id:c5', 1), comment: '这版时间更准' };
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: B, baseVersion: 1, answers: voteB, clientToken: 'token-b-2' });
ok(r.status === 200, '审阅乙按构造投票保存');

r = await j('POST', `/api/blind-rounds/${rid}/submit`, { reviewer: A, expectedVersion: 3, clientToken: 'token-a-5' });
ok(r.status === 200 && r.data.submission.status === 'submitted', '审阅甲提交');
r = await j('POST', `/api/blind-rounds/${rid}/submit`, { reviewer: A, expectedVersion: 4, clientToken: 'token-a-6' });
ok(r.status === 200 && r.data.deduplicated === true, '重复提交幂等返回，不产生重复记录');
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: A, baseVersion: 4, answers: voteA });
ok(r.status === 409, '提交后不能再修改');

/* ---------- 门槛前：不能揭示来源 / 不能关闭 ---------- */
r = await j('POST', `/api/blind-rounds/${rid}/reveal`, { author: '组织者' });
ok(r.status === 403 && r.data.validSubmitters === 1, '未达最少有效提交人数：揭示来源被禁止');
r = await j('POST', `/api/blind-rounds/${rid}/close`, { author: '组织者' });
ok(r.status === 403, '未达最少有效提交人数：关闭被禁止');
const prog1 = await j('GET', `/api/projects/${pid}/blind-rounds/${rid}`);
ok(prog1.data.round.progress.validSubmitters === 1 && prog1.data.round.progress.totalReviewers === 2
  && prog1.data.round.progress.thresholdMet === false, '进度：总人数/有效提交/达标状态');
ok(prog1.data.round.progress.thresholdCompletionPct === 50, '进度含门槛完成比例（1/2 = 50%）');
const rvA = prog1.data.round.progress.reviewers.find((x) => x.reviewer === A);
ok(rvA && rvA.answered === 5 && rvA.completionPct === 100, '审阅人逐项完成比例（5/5 = 100%）');
// 门槛前操作记录不得透露任何版本来源（即便创建时选过版本）
const eventsBlind = await j('GET', `/api/blind-rounds/${rid}/events`);
const eventsBlindJson = JSON.stringify(eventsBlind.data);
ok(!eventsBlindJson.includes(rev1.id) && !eventsBlindJson.includes(rev2.id) && !eventsBlindJson.includes(rev3.id)
  && !eventsBlindJson.includes('revisionId'),
  '达到门槛前操作记录不透露任何版本来源（revisionIds 已抹除）');
const auditBlind = await j('GET', `/api/projects/${pid}/audit`);
const blindCreateEntry = auditBlind.data.audit.find((a) => a.action === 'blind-create'
  && a.new_value && a.new_value.includes(round.title));
ok(blindCreateEntry && !blindCreateEntry.new_value.includes(rev1.id) && blindCreateEntry.new_value.includes('versionCount'),
  '达到门槛前盲审审计只记版本数量，不含版本 id');
const itemProg = prog1.data.round.progress.perItem.find((p) => p.key === 'id:c1');
ok(itemProg && itemProg.better === 1 && !JSON.stringify(prog1.data.round.progress.perItem).includes('"slot"'),
  '逐项分歧程度为匿名聚合（不含候选归属）');

/* ---------- 拒绝：必填理由；拒绝后可改后重提 ---------- */
r = await j('POST', `/api/blind-rounds/${rid}/reject`, { reviewer: B, reason: '尝试拒绝草稿', author: '组织者' });
ok(r.status === 409, '未提交的记录不能拒绝');
r = await j('POST', `/api/blind-rounds/${rid}/submit`, { reviewer: B, expectedVersion: 2, clientToken: 'token-b-3' });
ok(r.status === 200 && r.data.submission.status === 'submitted', '审阅乙提交');
r = await j('POST', `/api/blind-rounds/${rid}/reject`, { reviewer: B, reason: '', author: '组织者' });
ok(r.status === 400, '拒绝必须填写理由');
r = await j('POST', `/api/blind-rounds/${rid}/reject`, { reviewer: B, reason: '抽查发现未逐项查看', author: '组织者' });
ok(r.status === 200 && r.data.submission.status === 'rejected', '组织者拒绝乙的提交');
const prog2 = await j('GET', `/api/projects/${pid}/blind-rounds/${rid}`);
ok(prog2.data.round.progress.validSubmitters === 1, '被拒绝的提交不计入有效人数');
r = await j('POST', `/api/blind-rounds/${rid}/close`, { author: '组织者' });
ok(r.status === 403, '拒绝后重回门槛以下：仍不能关闭');
// 乙修改后重新提交
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: B, baseVersion: 4, answers: voteB, clientToken: 'token-b-4' });
ok(r.status === 200 && r.data.submission.status === 'draft', '被拒绝后可继续保存（回到草稿）');
r = await j('POST', `/api/blind-rounds/${rid}/submit`, { reviewer: B, clientToken: 'token-b-5' });
ok(r.status === 200 && r.data.submission.status === 'submitted', '乙重新提交成功');

/* ---------- 达标后：揭示来源（幂等） ---------- */
r = await j('POST', `/api/blind-rounds/${rid}/reveal`, { author: '组织者' });
ok(r.status === 200 && r.data.versions.length === 3 && r.data.versions[0].revisionId === rev1.id,
  '达到门槛后可揭示来源');
r = await j('POST', `/api/blind-rounds/${rid}/reveal`, { author: '组织者' });
ok(r.status === 200 && r.data.deduplicated === true, '重复揭示返回同一映射（幂等）');
const listRevealed = await j('GET', `/api/projects/${pid}/blind-rounds`);
ok(JSON.stringify(listRevealed.data).includes(rev1.id), '揭示后列表可展示来源');

/* ---------- 关闭：冻结结果（平票保留），重复关闭返回同一结果 ---------- */
r = await j('POST', `/api/blind-rounds/${rid}/close`, { author: '组织者' });
ok(r.status === 201 && r.data.round.status === 'closed' && r.data.round.result, '关闭轮次并生成冻结结果');
const result = r.data.round.result;
const itemC1 = result.items.find((i) => i.key === 'id:c1');
ok(itemC1.outcome === 'tie' && itemC1.winnerSlot === null && itemC1.votes.bySlot[0] === 1 && itemC1.votes.bySlot[1] === 1,
  '平票明确保留为平票（1:1）');
const itemC2 = result.items.find((i) => i.key === 'id:c2');
ok(itemC2.outcome === 'winner' && itemC2.winnerSlot === 2 && itemC2.votes.bySlot[2] === 2, '胜出版本正确（2 票）');
const itemC3 = result.items.find((i) => i.key === 'id:c3');
ok(itemC3.outcome === 'tie' && itemC3.votes.equal === 2, '全判相当记为平票');
const itemC5 = result.items.find((i) => i.key === 'id:c5');
ok(itemC5.outcome === 'winner' && itemC5.winnerSlot === 1 && itemC5.votes.unknown === 1, '无法判断不计入票数');
ok(itemC1.opinions.some((o) => o.reviewer === A && o.comment.includes('各有千秋'))
  && itemC5.opinions.some((o) => o.reviewer === B && o.comment.includes('时间更准')), '结果含逐项意见与署名');
ok(result.unmatched.length === 2
  && result.unmatched.find((u) => u.cueId === 'c6').revisionId === rev2.id
  && result.unmatched.find((u) => u.cueId === 'c7').revisionId === rev3.id,
  '无法可靠配对内容单列并揭示来源版本');
ok(result.summary.tieCount === 2 && result.versions.length === 3, '结果汇总（平票数/版本）');

const r2 = await j('POST', `/api/blind-rounds/${rid}/close`, { author: '组织者' });
ok(r2.status === 200 && r2.data.deduplicated === true
  && JSON.stringify(r2.data.round.result) === JSON.stringify(result), '重复关闭返回同一份冻结结果');

/* ---------- 关闭后：只读 ---------- */
r = await j('PUT', `/api/blind-rounds/${rid}/responses`, { reviewer: A, baseVersion: 4, answers: voteA });
ok(r.status === 409, '关闭后不再接受新选择');
r = await j('POST', `/api/blind-rounds/${rid}/submit`, { reviewer: B });
ok(r.status === 409, '关闭后不再接受提交');
r = await j('POST', `/api/blind-rounds/${rid}/reject`, { reviewer: A, reason: 'x', author: '组织者' });
ok(r.status === 409, '关闭后不能再拒绝');
const frozen = await j('GET', `/api/blind-rounds/${rid}/result`);
ok(frozen.status === 200 && frozen.data.result.summary.itemCount === 5, '冻结结果可查询');

/* ---------- 操作记录与审计 ---------- */
const events = await j('GET', `/api/blind-rounds/${rid}/events`);
const actions = new Set(events.data.events.map((e) => e.action));
ok(['create', 'save', 'submit', 'reject', 'reveal', 'close'].every((a) => actions.has(a)),
  '操作记录覆盖创建/保存/提交/拒绝/揭示/关闭');
ok(events.data.events.filter((e) => e.action === 'close').length === 1, '重复关闭不产生重复操作记录');
// 揭示/关闭后操作记录可展示来源（创建事件的版本数量始终在；来源 id 仅揭示后出现）
const createEvent = events.data.events.find((e) => e.action === 'create');
ok(createEvent.detail.versionCount === 3 && JSON.stringify(createEvent.detail).includes(rev1.id),
  '揭示后操作记录可回看版本来源（创建事件携带版本数量与 revisionIds）');
const audit = await j('GET', `/api/projects/${pid}/audit`);
const auditActions = new Set(audit.data.audit.map((a) => a.action));
ok(['blind-create', 'blind-save', 'blind-submit', 'blind-reject', 'blind-reveal', 'blind-close'].every((a) => auditActions.has(a)),
  '审计表包含全部盲审操作');

/* ---------- 另一个轮次：已被揭示的映射不影响新轮次盲态 ---------- */
r = await j('POST', `/api/projects/${pid}/blind-rounds`, { revisionIds: [rev1.id, rev3.id], minSubmitters: 1, title: '两版盲审', author: '组织者' });
ok(r.status === 201 && r.data.round.version_count === 2, '两版本盲审轮次可创建');
const rid2 = r.data.round.id;
const rv = await j('GET', `/api/blind-rounds/${rid2}/review?reviewer=${encodeURIComponent(A)}`);
ok(rv.data.items.every((it) => it.candidates.length === 2 && it.candidates.every((c) => /^[AB]$/.test(c.label))),
  '两版本对照项只出现 A/B 两个匿名候选');

console.log(failures ? `\n${failures} 项失败` : '\n盲审对照端到端测试全部通过');
process.exit(failures ? 1 : 0);
