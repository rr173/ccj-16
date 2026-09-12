// 端到端：批量导入 -> 预览逐项提示 -> 提交生成 import 版本 -> 并发冲突逐句裁决 -> 审计 -> 撤销生成 rollback 版本
const BASE = 'http://localhost:3000';

async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };

const { data: created } = await j('POST', '/api/projects', { name: '导入E2E', author: 'alice' });
const pid = created.project.id;
const createId = created.revision.id;

// 种子：主轨 + English 轨
const seed = {
  ...created.revision.snapshot,
  tracks: [
    { id: 't_main', name: '主轨', color: '#4e8cff', mutexGroup: null },
    { id: 't_en', name: 'English', color: '#34c77b', mutexGroup: null },
  ],
  cues: [{ id: 'c1', trackId: 't_main', start: 1000, end: 2000, text: '共同句', locked: false }],
};
const seedRes = await j('POST', `/api/projects/${pid}/revisions`, { baseRevId: createId, snapshot: seed, author: 'alice' });
const baseId = seedRes.data.revision.id;

// 1) 预览：SRT 中包含 合法新增 / 反向 / 坏时间 / 文件内重复 / 项目内重复
const srt = `1
00:00:05,000 --> 00:00:06,000
新句子A

2
00:00:07,000 --> 00:00:08,000
新句子B

3
00:00:09,000 --> 00:00:08,000
反向句

4
00:00:07,000 --> 00:00:08,000
新句子B

5
00:00:10,000 --> 00:00:11,000
共同句
`;
const pv = await j('POST', `/api/projects/${pid}/import/preview`, {
  baseRevId: baseId, content: srt, filename: 'a.srt', options: { defaultTrackId: 't_main' },
});
assert(pv.status === 200, '预览 200');
assert(pv.data.preview.rows[2].issues.some((i) => i.code === 'time-reverse'), '反向区间逐项提示');
assert(pv.data.preview.rows[3].issues.some((i) => i.code === 'dup-file'), '文件内重复逐项提示');
assert(pv.data.preview.rows[4].issues.some((i) => i.code === 'dup-project'), '项目内重复逐项提示');
assert(pv.data.preview.summary.add === 2, '只有 2 条合法新增: ' + pv.data.preview.summary.add);
assert(pv.data.stale === false, '基于当前看到的版本，不陈旧');

// 2) 提交：即使 included 里混入非法行，服务端只应用合法条目
const commit = await j('POST', `/api/projects/${pid}/import/commit`, {
  baseRevId: baseId, content: srt, filename: 'a.srt', options: { defaultTrackId: 't_main' },
  included: [1, 2, 3, 4, 5], author: 'alice',
});
assert(commit.status === 201, '导入提交 201');
assert(commit.data.revision.kind === 'import', '生成 import 版本');
assert(commit.data.report.added === 2 && commit.data.report.skipped === 3, '新增 2 / 跳过 3: ' + JSON.stringify(commit.data.report));
const impId = commit.data.revision.id;

// 3) 审计：add 与逐条 skip 都在
let audit = await j('GET', `/api/projects/${pid}/audit?limit=500`);
const impAudit = audit.data.audit.filter((a) => a.revision_id === impId || a.field.startsWith('import:'));
assert(impAudit.some((a) => a.action === 'add'), '审计记录新增');
const skipReasons = impAudit.filter((a) => a.action === 'skip').map((a) => JSON.parse(a.new_value).reason).sort();
assert(skipReasons.join(',') === 'dup-file,dup-project,time-reverse', '审计逐条记录跳过原因: ' + skipReasons);

// 4) 并发：bob 在旧 base 上把 c1 改成自己的文本并先保存
const bobSnap = JSON.parse(JSON.stringify(seed));
bobSnap.cues[0].text = '共同句-bob';
await j('POST', `/api/projects/${pid}/revisions`, { baseRevId: baseId, snapshot: bobSnap, author: 'bob', message: 'bob改c1' });

// alice 基于导入版本再导入：同槽 c1 改文本 -> 与 bob 冲突；另加无冲突新句
const srt2 = `1
00:00:01,000 --> 00:00:02,000
共同句-导入

2
00:00:20,000 --> 00:00:21,000
并发期新句
`;
const pv2 = await j('POST', `/api/projects/${pid}/import/preview`, {
  baseRevId: impId, content: srt2, filename: 'b.srt', options: { defaultTrackId: 't_main' },
});
assert(pv2.data.stale === true, '预览标注项目已有新版本');
const commit2 = await j('POST', `/api/projects/${pid}/import/commit`, {
  baseRevId: impId, content: srt2, filename: 'b.srt', options: { defaultTrackId: 't_main' },
  included: pv2.data.preview.rows.filter((r) => r.included).map((r) => r.seq), author: 'alice',
});
assert(commit2.status === 409, '并发导入返回 409');
assert(commit2.data.conflicts.length === 1 && commit2.data.conflicts[0].id === 'c1', '冲突定位到 c1: ' + commit2.data.conflicts.map((c) => c.id));
assert(Boolean(commit2.data.jobId), '返回导入裁决会话 jobId');
assert(commit2.data.merged.cues.some((c) => c.text === '并发期新句'), '无冲突句已自动合并，未被覆盖');

// 5) 逐句裁决：c1 采用导入方（mine）
const resolved = commit2.data.merged;
for (const conf of commit2.data.conflicts) {
  const t = resolved.cues.find((c) => c.id === conf.id);
  for (const f of conf.fields) t[f.field] = f.mine;
}
const resolveRes = await j('POST', `/api/projects/${pid}/import/resolve`, {
  jobId: commit2.data.jobId, resolvedSnapshot: resolved, conflictKeys: ['cue:c1:text'], author: 'alice',
});
assert(resolveRes.status === 201, '裁决提交 201');
assert(resolveRes.data.revision.kind === 'import', '裁决后仍是 import 版本');
assert(resolveRes.data.revision.parent2_id === impId, '第二父节点指向用户的基点，保留版本关系');
assert(resolveRes.data.revision.snapshot.cues.find((c) => c.id === 'c1').text === '共同句-导入', '冲突按人工选择落定');
assert(resolveRes.data.revision.snapshot.cues.some((c) => c.text === '并发期新句'), '自动合并的句子保留');
const headAfterMerge = resolveRes.data.revision.id;

// 6) 撤销最近一次导入：无改动条目全部回滚（c1 恢复为 bob 版本——当前 HEAD 中 c1 的"导入前"形态）
const undo = await j('POST', `/api/projects/${pid}/import/undo`, { author: 'alice' });
assert(undo.status === 201, '撤销 201');
assert(undo.data.revision.kind === 'rollback', '撤销生成 rollback 新版本');
assert(undo.data.revision.parent1_id === headAfterMerge, '回滚版本挂在最新版本之后');
const texts = undo.data.revision.snapshot.cues.map((c) => c.text);
// c1 的"导入前"是导入主父（bob 的 merge 版本）中的值；撤销恢复对方版本
assert(texts.includes('共同句-bob'), '修改句恢复到导入主父（对方并发版本）的值: ' + texts);
assert(!texts.includes('共同句-导入') && !texts.includes('并发期新句'), '导入新增句已删除');

// 7) 重复撤销被拒，不产生空版本
const undo2 = await j('POST', `/api/projects/${pid}/import/undo`, { author: 'alice' });
assert(undo2.status === 400, '重复撤销被拒: ' + undo2.data.error);

// 8) 版本链可回看
const revs = await j('GET', `/api/projects/${pid}/revisions`);
const kinds = revs.data.revisions.map((r) => r.kind);
// rollback <- 导入裁决(import) <- bob 提交时自动并入导入1的新句(merge) <- 导入1(import)
assert(kinds.slice(0, 3).join(',') === 'rollback,import,merge', '版本链头部为 rollback/import/merge: ' + kinds.slice(0, 3));
const importRev = revs.data.revisions.find((r) => r.id === impId);
assert(importRev.meta?.kind === 'import' && Array.isArray(importRev.meta.skips), '版本 meta 记录导入清单');
const rollbackRev = revs.data.revisions.find((r) => r.kind === 'rollback');
assert(rollbackRev.meta.undoneRevisionId === headAfterMerge, 'rollback meta 指向被撤销的导入版本');

audit = await j('GET', `/api/projects/${pid}/audit?limit=500`);
assert(audit.data.audit.some((a) => a.action === 'rollback'), '审计含回滚记录');
assert(audit.data.audit.some((a) => a.action === 'resolve'), '审计含冲突裁决记录');

console.log(process.exitCode ? '\n导入端到端存在失败项 ✗' : '\n导入端到端全部通过 ✓');
