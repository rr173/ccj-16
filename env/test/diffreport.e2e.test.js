// 端到端：版本差异报告
// 生成（冻结/幂等）→ 逐项差异（含跨轨移动/删除重建的内容匹配）→ 组合筛选 → 导出 JSON/CSV
// → 各类 4xx → 发布快照对比 → 删除后内容不可读 → 审计留痕
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

async function waitJob(pid, jobId) {
  for (let i = 0; i < 200; i++) {
    const { data } = await j('GET', `/api/projects/${pid}/qc/jobs/${jobId}`);
    if (data.job.status === 'done') return data.job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('等待质检任务超时');
}

/* ---------- 准备：项目 + 两个差异丰富的版本 ---------- */
console.log('版本差异报告：端到端');
const { data: created } = await j('POST', '/api/projects', { name: '差异报告', author: 'alice' });
const pid = created.project.id;
const rev0 = created.revision;

const snap1 = {
  ...rev0.snapshot,
  tracks: [
    { id: 't_main', name: '主轨', color: '#4e8cff', mutexGroup: null },
    { id: 't_sub', name: '副轨', color: '#ff9a3c', mutexGroup: null },
  ],
  cues: [
    { id: 'c1', trackId: 't_main', start: 0, end: 1500, text: '开场白', locked: false },
    { id: 'c2', trackId: 't_main', start: 2000, end: 3500, text: '要改文本', locked: false },
    { id: 'c3', trackId: 't_main', start: 4000, end: 5000, text: '要改时间', locked: false },
    { id: 'c4', trackId: 't_main', start: 6000, end: 7000, text: '要锁定', locked: false },
    { id: 'c5', trackId: 't_main', start: 8000, end: 9000, text: '要跨轨', locked: false },
    { id: 'c6', trackId: 't_main', start: 10000, end: 11000, text: '保持原样', locked: true },
    { id: 'c7', trackId: 't_sub', start: 12000, end: 13000, text: '要被删除', locked: false },
    { id: 'c8', trackId: 't_main', start: 14000, end: 15000, text: '重建的句子内容', locked: false },
  ],
};
const rev1 = await submit(pid, rev0.id, snap1, 'alice', '第一版');

// 第二版：文本/时间/锁定/跨轨/删除/新增/删除后重建（新 id）/顺序打乱
const snap2 = {
  ...snap1,
  cues: [
    { id: 'c9', trackId: 't_main', start: 14000, end: 15000, text: '重建的句子内容！', locked: false }, // c8 删除重建
    { id: 'c6', trackId: 't_main', start: 10000, end: 11000, text: '保持原样', locked: true },
    { id: 'c5', trackId: 't_sub', start: 8000, end: 9000, text: '要跨轨', locked: false },              // 跨轨移动
    { id: 'c1', trackId: 't_main', start: 0, end: 1500, text: '开场白', locked: false },
    { id: 'c2', trackId: 't_main', start: 2000, end: 3500, text: '文本已修改', locked: false },          // 文本
    { id: 'c3', trackId: 't_main', start: 4500, end: 5500, text: '要改时间', locked: false },            // 时间
    { id: 'c4', trackId: 't_main', start: 6000, end: 7000, text: '要锁定', locked: true },               // 锁定
    { id: 'c10', trackId: 't_sub', start: 16000, end: 17000, text: '全新句子', locked: false },          // 新增
    // c7 被删除
  ],
};
const rev2 = await submit(pid, rev1.id, snap2, 'bob', '第二版');

/* ---------- 生成报告：逐项差异正确 ---------- */
const gen = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'revision', fromRef: rev1.id, toKind: 'revision', toRef: rev2.id, author: 'carol',
});
ok(gen.status === 201 && gen.data.report.id, '生成差异报告');
const rid = gen.data.report.id;
const sum = gen.data.report.summary;
// text=2（c2 改文本 + c8→c9 重建句文本变化）、unchanged=2（c1、c6），其余各 1
ok(sum.byType.text === 2 && sum.byType.time === 1 && sum.byType.lock === 1 && sum.byType.track === 1
  && sum.byType.added === 1 && sum.byType.deleted === 1 && sum.byType.unchanged === 2,
  '七类差异统计正确', JSON.stringify(sum.byType));
ok(sum.matched.byContent === 1, '删除重建的句子经内容匹配配对');

const detail0 = await j('GET', `/api/diff-reports/${rid}?author=carol`);
ok(detail0.status === 200 && detail0.data.report.items.length === sum.total, '详情返回全量项（默认冻结筛选）');
const items = detail0.data.report.items;
const trackItem = items.find((i) => i.type === 'track');
ok(trackItem.cueIdFrom === 'c5' && trackItem.oldValue === 't_main' && trackItem.newValue === 't_sub'
  && trackItem.trackName === '副轨', '跨轨移动项：旧轨→新轨 + 轨道名');
const rebuilt = items.find((i) => i.cueIdFrom === 'c8');
ok(rebuilt && rebuilt.type === 'text' && rebuilt.cueIdTo === 'c9' && rebuilt.matchedBy === 'content',
  '删除重建报为文本修改（内容匹配），而非删除+新增');
ok(!items.some((i) => (i.type === 'added' || i.type === 'deleted') && (i.cueIdFrom === 'c8' || i.cueIdTo === 'c8')),
  '重建句不产生额外的新增/删除项');
const timeItem = items.find((i) => i.type === 'time');
ok(timeItem.oldValue.start === 4000 && timeItem.newValue.start === 4500, '时间修改项含旧/新时间');
ok(detail0.data.report.from_rev_id === rev1.id && detail0.data.report.to_rev_id === rev2.id, '报告带可定位的版本链接');
ok(detail0.data.report.tracks.length === 2, '报告带轨道并集（供筛选）');

/* ---------- 幂等：同版本对 + 同筛选重复生成返回同一报告 ---------- */
const genDup = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'revision', fromRef: rev1.id, toKind: 'revision', toRef: rev2.id, author: 'dave',
});
ok(genDup.status === 200 && genDup.data.deduplicated === true && genDup.data.report.id === rid, '重复生成幂等返回同一报告');
const listAfterDup = await j('GET', `/api/projects/${pid}/diff-reports`);
ok(listAfterDup.data.reports.filter((r) => r.status === 'active').length === 1, '不产生重复记录');

// 筛选条件不同 → 是另一份报告
const genFiltered = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'revision', fromRef: rev1.id, toKind: 'revision', toRef: rev2.id,
  filters: { types: ['text'] }, author: 'carol',
});
ok(genFiltered.status === 201 && genFiltered.data.report.id !== rid, '筛选条件不同生成新报告');
const ridFiltered = genFiltered.data.report.id;
const detFiltered = await j('GET', `/api/diff-reports/${ridFiltered}`);
ok(detFiltered.data.report.items.every((i) => i.type === 'text'), '冻结筛选在详情默认生效');

/* ---------- 冻结：生成后项目继续编辑，报告内容不变 ---------- */
const snap3 = { ...snap2, cues: snap2.cues.map((c) => (c.id === 'c1' ? { ...c, text: '又改了' } : c)) };
const rev3 = await submit(pid, rev2.id, snap3, 'alice', '第三版');
const detailFrozen = await j('GET', `/api/diff-reports/${rid}`);
const frozenText = detailFrozen.data.report.items.find((i) => i.type === 'text');
ok(frozenText.oldValue === '要改文本' && frozenText.newValue === '文本已修改', '报告内容冻结，不受后续编辑影响');
ok(detailFrozen.data.report.created_at === detail0.data.report.created_at, '生成时间冻结');

/* ---------- 组合筛选（详情查询参数覆盖） ---------- */
const fTrack = await j('GET', `/api/diff-reports/${rid}?trackId=t_sub`);
ok(fTrack.data.report.items.every((i) => i.trackId === 't_sub' || i.trackIdFrom === 't_sub')
  && fTrack.data.report.items.length === 3, '按轨道筛选（含跨轨移动的旧侧）');
const fType = await j('GET', `/api/diff-reports/${rid}?types=text,time`);
ok(fType.data.report.items.length === 3 && fType.data.report.items.every((i) => ['text', 'time'].includes(i.type)), '按差异类型组合筛选');
const fKw = await j('GET', `/api/diff-reports/${rid}?keyword=全新`);
ok(fKw.data.report.items.length === 1 && fKw.data.report.items[0].type === 'added', '按关键词筛选');
const fCombo = await j('GET', `/api/diff-reports/${rid}?trackId=t_main&types=lock,text`);
ok(fCombo.data.report.items.length === 3, '轨道+类型组合筛选');
const fBad = await j('GET', `/api/diff-reports/${rid}?types=bogus`);
ok(fBad.status === 400, '非法差异类型筛选返回 400');
const fBad2 = await j('GET', `/api/diff-reports/${rid}?trackId=${'x'.repeat(200)}`);
ok(fBad2.status === 400, '非法轨道筛选返回 400');

/* ---------- 导出 ---------- */
const expJson = await fetch(`${BASE}/api/diff-reports/${rid}/export?format=json&types=text&author=carol`);
const expJsonBody = await expJson.json();
ok(expJson.status === 200 && expJsonBody.items.length === 2 && expJsonBody.items.every((i) => i.type === 'text')
  && expJsonBody.report.effectiveFilters.types.includes('text'), '导出 JSON 为当前筛选结果');
ok((expJson.headers.get('content-disposition') || '').includes('diffreport_'), 'JSON 导出带下载文件名');
const expCsv = await fetch(`${BASE}/api/diff-reports/${rid}/export?format=csv`);
const csvText = await expCsv.text();
ok(expCsv.status === 200 && csvText.includes('差异类型') && csvText.split('\r\n').length === sum.total + 2, '导出 CSV 全量');
ok(csvText.includes('跨轨移动') && csvText.includes('00:00:04,500 → 00:00:05,500'), 'CSV 含中文类型与格式化时间');
const expBad = await j('GET', `/api/diff-reports/${rid}/export?format=xlsx`);
ok(expBad.status === 400 && /不支持/.test(expBad.data.error), '不支持的导出格式返回 400');

/* ---------- 4xx：版本不存在 / 跨项目 / 同版本 / 非法类型 ---------- */
const e404 = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'revision', fromRef: 'r_nonexistent', toKind: 'revision', toRef: rev2.id,
});
ok(e404.status === 404, '版本不存在返回 404');
const { data: other } = await j('POST', '/api/projects', { name: '另一个项目', author: 'alice' });
const eCross = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'revision', fromRef: other.revision.id, toKind: 'revision', toRef: rev2.id,
});
ok(eCross.status === 400 && /不同项目/.test(eCross.data.error), '跨项目版本对比返回 400');
const eSame = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'revision', fromRef: rev1.id, toKind: 'revision', toRef: rev1.id,
});
ok(eSame.status === 400, '同一版本对比返回 400');
const eKind = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'branch', fromRef: rev1.id, toKind: 'revision', toRef: rev2.id,
});
ok(eKind.status === 400, '非法对比类型返回 400');
const eFilter = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'revision', fromRef: rev1.id, toKind: 'revision', toRef: rev2.id, filters: { types: ['nope'] },
});
ok(eFilter.status === 400, '生成时非法筛选返回 400');
const eMissing = await j('GET', '/api/diff-reports/dr_nonexistent');
ok(eMissing.status === 404, '报告不存在返回 404');

/* ---------- 发布快照作为对比方 ---------- */
await j('PUT', `/api/projects/${pid}/qc/rules`, {
  trackId: '', author: 'alice',
  rules: {
    duration: { enabled: false, severity: 'warning', params: { minMs: 500, maxMs: 10000 } },
    cps: { enabled: false, severity: 'warning', params: { maxCps: 20 } },
    line_chars: { enabled: false, severity: 'warning', params: { maxChars: 42 } },
    gap: { enabled: false, severity: 'warning', params: { minGapMs: 200 } },
    align: { enabled: false, severity: 'warning', params: { toleranceMs: 100, trackA: '', trackB: '' } },
  },
});
const jobStart = await j('POST', `/api/projects/${pid}/qc/jobs`, { revisionId: rev3.id, author: 'alice' });
await waitJob(pid, jobStart.data.job.id);
const reqCreate = await j('POST', `/api/projects/${pid}/release-requests`, { revisionId: rev3.id, author: 'alice', confirmations: [] });
ok(reqCreate.status === 201, '发布申请已创建');
const approve = await j('POST', `/api/release-requests/${reqCreate.data.request.id}/approve`, { author: 'bob' });
ok(approve.status === 200, '申请已批准');
const pub = await j('POST', `/api/projects/${pid}/releases`, { requestId: reqCreate.data.request.id, author: 'bob' });
ok(pub.status === 201 && pub.data.release.label, '发布快照已生成');
const rel = pub.data.release;

const genRel = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'release', fromRef: rel.id, toKind: 'revision', toRef: rev2.id, author: 'carol',
});
ok(genRel.status === 201, '发布快照与历史版本可对比');
const relReport = genRel.data.report;
ok(relReport.from_label.includes(rel.label) && relReport.from_rev_id === rev3.id, '快照侧标签与定位版本正确');
const relItems = (await j('GET', `/api/diff-reports/${relReport.id}`)).data.report.items;
ok(relItems.some((i) => i.type === 'text' && i.cueIdFrom === 'c1'), '快照→旧版本差异项正确（c1 在快照中被改过）');
const eRel404 = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'release', fromRef: 'rel_nonexistent', toKind: 'revision', toRef: rev2.id,
});
ok(eRel404.status === 404, '发布快照不存在返回 404');

/* ---------- 删除：内容不可再读，审计留痕 ---------- */
const viewBefore = await j('GET', `/api/projects/${pid}/audit?limit=500`);
ok(viewBefore.data.audit.some((a) => a.action === 'diff-create' && a.field === `diffreport:${rid}`), '审计含创建记录');
ok(viewBefore.data.audit.some((a) => a.action === 'diff-view' && a.field === `diffreport:${rid}`), '审计含查看记录');
ok(viewBefore.data.audit.some((a) => a.action === 'diff-export' && a.field === `diffreport:${rid}`), '审计含导出记录');

const del = await j('DELETE', `/api/diff-reports/${rid}`, { author: 'carol' });
ok(del.status === 200 && del.data.deleted === true, '删除报告');
const getDeleted = await j('GET', `/api/diff-reports/${rid}`);
ok(getDeleted.status === 410, '删除后详情不可再读（410）');
const expDeleted = await j('GET', `/api/diff-reports/${rid}/export?format=json`);
ok(expDeleted.status === 410, '删除后导出不可再读（410）');
const delAgain = await j('DELETE', `/api/diff-reports/${rid}`, { author: 'carol' });
ok(delAgain.status === 400, '重复删除返回 400');
const listAfterDel = await j('GET', `/api/projects/${pid}/diff-reports`);
ok(listAfterDel.data.reports.find((r) => r.id === rid)?.status === 'deleted', '列表中保留已删除占位');

// 删除后同条件重新生成 → 新报告（不复活已删除记录）
const genAgain = await j('POST', `/api/projects/${pid}/diff-reports`, {
  fromKind: 'revision', fromRef: rev1.id, toKind: 'revision', toRef: rev2.id, author: 'carol',
});
ok(genAgain.status === 201 && genAgain.data.report.id !== rid, '删除后同条件可重新生成新报告');

const auditFinal = await j('GET', `/api/projects/${pid}/audit?limit=500`);
ok(auditFinal.data.audit.some((a) => a.action === 'diff-delete' && a.field === `diffreport:${rid}`), '审计含删除记录');

console.log(failures ? `\n失败 ${failures} 项` : '\n差异报告端到端测试全部通过');
process.exit(failures ? 1 : 0);
