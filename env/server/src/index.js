'use strict';
const path = require('path');
const express = require('express');
const store = require('./store');
const qc = require('./qc/store');
const diffreport = require('./report/store');
const gate = require('./gate/store');
const { validate } = require('./validation');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'client')));

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ...(e.extra || {}) });
  }
};

app.get('/api/projects', wrap((req, res) => {
  res.json({ projects: store.listProjects() });
}));

app.post('/api/projects', wrap((req, res) => {
  const author = String(req.body?.author || '匿名');
  const name = String(req.body?.name || '未命名字幕项目');
  const { project, revision } = store.createProject(name, author);
  res.status(201).json({ project, revision });
}));

app.get('/api/projects/:id', wrap((req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  const head = store.getRevision(project.head_id);
  res.json({ project, head });
}));

app.get('/api/projects/:id/revisions', wrap((req, res) => {
  res.json({ revisions: store.listRevisions(req.params.id) });
}));

app.get('/api/revisions/:revId', wrap((req, res) => {
  const rev = store.getRevision(req.params.revId);
  if (!rev) return res.status(404).json({ error: '版本不存在' });
  res.json({ revision: rev });
}));

app.post('/api/projects/:id/revisions', wrap((req, res) => {
  const { baseRevId, snapshot, author, message } = req.body || {};
  if (!baseRevId || !snapshot) return res.status(400).json({ error: '缺少 baseRevId 或 snapshot' });
  const result = store.submitRevision(req.params.id, {
    baseRevId,
    snapshot,
    author: String(author || '匿名'),
    message: String(message || ''),
  });
  res.status(result.status === 'conflict' ? 409 : 201).json(result);
}));

app.post('/api/projects/:id/resolve', wrap((req, res) => {
  const { parentRevId, otherRevId, resolvedSnapshot, conflictKeys, author, message } = req.body || {};
  if (!parentRevId || !otherRevId || !resolvedSnapshot) {
    return res.status(400).json({ error: '缺少 parentRevId / otherRevId / resolvedSnapshot' });
  }
  const result = store.resolveRevision(req.params.id, {
    parentRevId,
    otherRevId,
    resolvedSnapshot,
    conflictKeys: conflictKeys || [],
    author: String(author || '匿名'),
    message: String(message || ''),
  });
  res.status(result.status === 'conflict' ? 409 : 201).json(result);
}));

app.get('/api/projects/:id/audit', wrap((req, res) => {
  res.json({ audit: store.listAudit(req.params.id, Number(req.query.limit) || 300) });
}));

// ---- 批量导入：预览（基于用户当前看到的版本校验，不写入） ----
app.post('/api/projects/:id/import/preview', wrap((req, res) => {
  const { baseRevId, content, filename, options } = req.body || {};
  if (!baseRevId || content == null) return res.status(400).json({ error: '缺少 baseRevId 或 content' });
  const result = store.previewImport(req.params.id, { baseRevId, content, filename, options });
  res.json(result);
}));

// ---- 批量导入：只应用用户勾选的合法条目；并发新版本时按句三向合并，冲突返回 409 ----
app.post('/api/projects/:id/import/commit', wrap((req, res) => {
  const { baseRevId, content, filename, options, included, author, message } = req.body || {};
  if (!baseRevId || content == null || !Array.isArray(included)) {
    return res.status(400).json({ error: '缺少 baseRevId / content / included' });
  }
  const result = store.commitImport(req.params.id, {
    baseRevId,
    content,
    filename: String(filename || ''),
    options: options || {},
    included,
    author: String(author || '匿名'),
    message: String(message || ''),
  });
  res.status(result.status === 'conflict' ? 409 : 201).json(result);
}));

// ---- 导入冲突的人工裁决提交（jobId 指向暂存的导入上下文） ----
app.post('/api/projects/:id/import/resolve', wrap((req, res) => {
  const { jobId, resolvedSnapshot, conflictKeys, author, message } = req.body || {};
  if (!jobId || !resolvedSnapshot) return res.status(400).json({ error: '缺少 jobId 或 resolvedSnapshot' });
  const result = store.resolveImportJob(req.params.id, {
    jobId,
    resolvedSnapshot,
    conflictKeys: conflictKeys || [],
    author: String(author || '匿名'),
    message: String(message || ''),
  });
  res.status(result.status === 'conflict' ? 409 : 201).json(result);
}));

// ---- 撤销最近一次导入（本身生成新版本） ----
app.post('/api/projects/:id/import/undo', wrap((req, res) => {
  const result = store.undoLastImport(req.params.id, {
    author: String(req.body?.author || '匿名'),
    message: String(req.body?.message || ''),
  });
  res.status(201).json(result);
}));

app.get('/api/revisions/:revId/violations', wrap((req, res) => {
  const rev = store.getRevision(req.params.revId);
  if (!rev) return res.status(404).json({ error: '版本不存在' });
  res.json(validate(rev.snapshot));
}));

/* ==================== 交付质检与发布快照 ==================== */

// ---- 质量规则：项目级（trackId=''）与轨道级覆盖 ----
app.get('/api/projects/:id/qc/rules', wrap((req, res) => {
  res.json(qc.getRulesPayload(req.params.id));
}));

app.put('/api/projects/:id/qc/rules', wrap((req, res) => {
  const { trackId, rules, author } = req.body || {};
  try {
    res.json(qc.putRules(req.params.id, { trackId: String(trackId || ''), rules, author: String(author || '匿名') }));
  } catch (e) {
    if (!e.status) e.status = 400; // 规则参数校验错误
    throw e;
  }
}));

// ---- 质检任务：发起（同版本同规则运行中去重）、进度、取消、历史 ----
app.post('/api/projects/:id/qc/jobs', wrap((req, res) => {
  const { revisionId, author } = req.body || {};
  if (!revisionId) return res.status(400).json({ error: '缺少 revisionId' });
  const result = qc.startJob(req.params.id, { revisionId, author: String(author || '匿名') });
  res.status(result.deduplicated ? 200 : 202).json(result);
}));

app.get('/api/projects/:id/qc/jobs', wrap((req, res) => {
  res.json({ jobs: qc.listJobs(req.params.id) });
}));

app.get('/api/projects/:id/qc/jobs/:jobId', wrap((req, res) => {
  const job = qc.getJob(req.params.jobId);
  if (!job || job.project_id !== req.params.id) return res.status(404).json({ error: '质检任务不存在' });
  res.json({ job });
}));

app.post('/api/projects/:id/qc/jobs/:jobId/cancel', wrap((req, res) => {
  res.json({ job: qc.cancelJob(req.params.id, req.params.jobId, String(req.body?.author || '匿名')) });
}));

// ---- 质检结果：筛选（轨道/严重级别/状态组合）、单条历史、某句完整历史 ----
app.get('/api/projects/:id/qc/jobs/:jobId/findings', wrap((req, res) => {
  res.json({
    findings: qc.listFindings(req.params.id, req.params.jobId, {
      trackId: req.query.trackId || '',
      severity: req.query.severity || '',
      status: req.query.status || '',
    }),
  });
}));

app.get('/api/projects/:id/qc/findings/:findingId', wrap((req, res) => {
  res.json(qc.findingDetail(req.params.id, req.params.findingId));
}));

app.get('/api/projects/:id/qc/cues/:cueId/history', wrap((req, res) => {
  res.json({ history: qc.cueHistory(req.params.id, req.params.cueId) });
}));

// ---- 处理工作流：批量忽略 / 批量接受建议修复（均要求 baseRevId == HEAD） ----
app.post('/api/projects/:id/qc/findings/decide', wrap((req, res) => {
  const { findingIds, action, reason, baseRevId, author } = req.body || {};
  if (action !== 'ignore') return res.status(400).json({ error: '暂支持 action=ignore' });
  const result = qc.ignoreFindings(req.params.id, {
    findingIds, baseRevId, reason: String(reason || ''), author: String(author || '匿名'),
  });
  res.json(result);
}));

app.post('/api/projects/:id/qc/findings/fix', wrap((req, res) => {
  const { findingIds, baseRevId, reason, author } = req.body || {};
  const result = qc.applyFixes(req.params.id, {
    findingIds, baseRevId, reason: String(reason || ''), author: String(author || '匿名'),
  });
  res.status(201).json(result);
}));

// ---- 发布审批：预检 → 发布申请 → 批准/驳回 →（批准且未失效）发布 ----
app.get('/api/projects/:id/releases/preflight', wrap((req, res) => {
  res.json(qc.preflight(req.params.id, String(req.query.revisionId || '')));
}));

// 创建发布申请（同版本有待处理/已批准申请时幂等返回）
app.post('/api/projects/:id/release-requests', wrap((req, res) => {
  const { revisionId, confirmations, author, message } = req.body || {};
  if (!revisionId) return res.status(400).json({ error: '缺少 revisionId' });
  const result = qc.createRequest(req.params.id, {
    revisionId,
    confirmations: Array.isArray(confirmations) ? confirmations : [],
    author: String(author || '匿名'),
    message: String(message || ''),
  });
  res.status(result.deduplicated ? 200 : 201).json(result);
}));

app.get('/api/projects/:id/release-requests', wrap((req, res) => {
  res.json({ requests: qc.listRequests(req.params.id) });
}));

app.post('/api/release-requests/:rid/approve', wrap((req, res) => {
  const rq = qc.getRequest(req.params.rid);
  if (!rq) return res.status(404).json({ error: '发布申请不存在' });
  res.json(qc.decideRequest(rq.project_id, req.params.rid, {
    action: 'approve',
    comment: String(req.body?.comment || ''),
    author: String(req.body?.author || '匿名'),
  }));
}));

app.post('/api/release-requests/:rid/reject', wrap((req, res) => {
  const rq = qc.getRequest(req.params.rid);
  if (!rq) return res.status(404).json({ error: '发布申请不存在' });
  res.json(qc.decideRequest(rq.project_id, req.params.rid, {
    action: 'reject',
    comment: String(req.body?.comment || ''),
    author: String(req.body?.author || '匿名'),
  }));
}));

// ---- 发布快照：凭已批准的申请发布（同版本去重）、列表、撤销、逐句对比、文件下载 ----
app.post('/api/projects/:id/releases', wrap((req, res) => {
  const { requestId, author } = req.body || {};
  if (!requestId) return res.status(400).json({ error: '缺少 requestId（需先提交发布申请并获得批准）' });
  const result = qc.publish(req.params.id, {
    requestId,
    author: String(author || '匿名'),
  });
  res.status(result.deduplicated ? 200 : 201).json(result);
}));

app.get('/api/projects/:id/releases', wrap((req, res) => {
  res.json({ releases: qc.listReleases(req.params.id) });
}));

app.get('/api/releases/:rid', wrap((req, res) => {
  const rel = qc.getRelease(req.params.rid);
  if (!rel) return res.status(404).json({ error: '发布快照不存在' });
  res.json({ release: rel });
}));

app.post('/api/releases/:rid/withdraw', wrap((req, res) => {
  const rel = qc.getRelease(req.params.rid);
  if (!rel) return res.status(404).json({ error: '发布快照不存在' });
  res.json({ release: qc.withdrawRelease(rel.project_id, req.params.rid, {
    author: String(req.body?.author || '匿名'), reason: String(req.body?.reason || '') }) });
}));

app.get('/api/releases/:rid/diff', wrap((req, res) => {
  const rel = qc.getRelease(req.params.rid);
  if (!rel) return res.status(404).json({ error: '发布快照不存在' });
  res.json(qc.diffRelease(rel.project_id, req.params.rid, String(req.query.against || '')));
}));

app.get('/api/releases/:rid/files/:fmt/:trackId', wrap((req, res) => {
  const rel = qc.getRelease(req.params.rid);
  if (!rel) return res.status(404).json({ error: '发布快照不存在' });
  if (rel.status !== 'published') return res.status(410).json({ error: '该发布已撤销，文件不可下载' });
  const fmt = req.params.fmt === 'vtt' ? 'vtt' : req.params.fmt === 'srt' ? 'srt' : null;
  if (!fmt) return res.status(400).json({ error: '格式应为 srt 或 vtt' });
  const trackId = req.params.trackId || 'all';
  const content = rel.files?.[fmt]?.[trackId];
  if (content == null) return res.status(404).json({ error: '文件不存在（轨道 id 无效）' });
  res.setHeader('Content-Type', fmt === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${rel.label}_${trackId}.${fmt}"`);
  res.send(content);
}));

/* ==================== 版本差异报告 ==================== */

// 生成报告：任意两个历史版本或发布快照；同版本对 + 同筛选条件幂等返回同一报告
app.post('/api/projects/:id/diff-reports', wrap((req, res) => {
  const { fromKind, fromRef, toKind, toRef, filters, author } = req.body || {};
  const result = diffreport.createReport(req.params.id, {
    fromKind, fromRef, toKind, toRef,
    filters: filters || {},
    author: String(author || '匿名'),
  });
  res.status(result.deduplicated ? 200 : 201).json(result);
}));

app.get('/api/projects/:id/diff-reports', wrap((req, res) => {
  res.json({ reports: diffreport.listReports(req.params.id) });
}));

// 详情：可用 trackId / types（逗号分隔）/ keyword 覆盖冻结筛选；每次查看写审计
app.get('/api/diff-reports/:rid', wrap((req, res) => {
  const hasOverride = ['trackId', 'types', 'keyword'].some((k) => req.query[k] != null && req.query[k] !== '');
  res.json(diffreport.getReport(req.params.rid, {
    filterOverrides: hasOverride
      ? { trackId: req.query.trackId, types: req.query.types, keyword: req.query.keyword }
      : null,
    author: String(req.query.author || '匿名'),
  }));
}));

// 导出当前筛选结果（json / csv），写审计
app.get('/api/diff-reports/:rid/export', wrap((req, res) => {
  const hasOverride = ['trackId', 'types', 'keyword'].some((k) => req.query[k] != null && req.query[k] !== '');
  const out = diffreport.exportReport(req.params.rid, {
    format: req.query.format,
    filterOverrides: hasOverride
      ? { trackId: req.query.trackId, types: req.query.types, keyword: req.query.keyword }
      : null,
    author: String(req.query.author || '匿名'),
  });
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.send(out.content);
}));

// 删除：软删除并清空内容，此后内容不可再读（410），审计保留
app.delete('/api/diff-reports/:rid', wrap((req, res) => {
  res.json(diffreport.deleteReport(req.params.rid, String(req.body?.author || '匿名')));
}));

/* ==================== 发布回归门禁与变更订阅 ==================== */

// ---- 订阅：创建（基线 revision|release + 关注轨道/差异类型/关键词/质检级别）/ 列表 / 修改 / 暂停 / 恢复 ----
app.get('/api/projects/:id/gate/subscriptions', wrap((req, res) => {
  res.json({ subscriptions: gate.listSubscriptions(req.params.id) });
}));

app.post('/api/projects/:id/gate/subscriptions', wrap((req, res) => {
  const b = req.body || {};
  const result = gate.createSubscription(req.params.id, {
    name: b.name,
    baselineKind: b.baselineKind,
    baselineRef: b.baselineRef,
    trackIds: b.trackIds,
    diffTypes: b.diffTypes,
    keyword: b.keyword,
    qcSeverities: b.qcSeverities,
  }, String(b.author || '匿名'));
  res.status(201).json(result);
}));

app.put('/api/projects/:id/gate/subscriptions/:sid', wrap((req, res) => {
  const b = req.body || {};
  res.json(gate.updateSubscription(req.params.id, req.params.sid, b, String(b.author || '匿名')));
}));

app.post('/api/projects/:id/gate/subscriptions/:sid/pause', wrap((req, res) => {
  res.json(gate.setPaused(req.params.id, req.params.sid, true, String(req.body?.author || '匿名')));
}));

app.post('/api/projects/:id/gate/subscriptions/:sid/resume', wrap((req, res) => {
  res.json(gate.setPaused(req.params.id, req.params.sid, false, String(req.body?.author || '匿名')));
}));

// ---- 评估事件：列表（可按订阅/状态/门禁/趋势/触发/版本筛选）、详情（逐项证据 + 筛选）、重跑、失败重试 ----
app.get('/api/projects/:id/gate/evaluations', wrap((req, res) => {
  res.json({
    evaluations: gate.listEvaluations(req.params.id, {
      subscriptionId: req.query.subscriptionId || '',
      status: req.query.status || '',
      gateHit: req.query.gateHit || '',
      trend: req.query.trend || '',
      trigger: req.query.trigger || '',
      revisionId: req.query.revisionId || '',
    }),
  });
}));

app.get('/api/projects/:id/gate/evaluations/:eid', wrap((req, res) => {
  res.json(gate.getEvaluationDetail(req.params.id, req.params.eid, {
    trend: req.query.trend || '',
    kind: req.query.kind || '',
    trackId: req.query.trackId || '',
    keyword: req.query.keyword || '',
  }));
}));

// 手动重跑：已结束事件 → 新事件（新编号）；进行中 → 幂等复用
app.post('/api/projects/:id/gate/evaluations/:eid/rerun', wrap((req, res) => {
  const result = gate.rerun(req.params.id, req.params.eid, String(req.body?.author || '匿名'));
  res.status(result.deduplicated ? 200 : 202).json(result);
}));

// 失败重试：复用同一事件行
app.post('/api/projects/:id/gate/evaluations/:eid/retry', wrap((req, res) => {
  res.status(202).json(gate.retry(req.params.id, req.params.eid, String(req.body?.author || '匿名')));
}));

// ---- 门禁状态：某版本当前是否被拦截（供发布页/申请页展示）----
app.get('/api/projects/:id/gate/status', wrap((req, res) => {
  const revisionId = String(req.query.revisionId || '');
  if (!revisionId) return res.status(400).json({ error: '缺少 revisionId' });
  const { pending, subscriptionCount } = gate.ensureEvaluated(req.params.id, revisionId, String(req.query.author || '匿名'));
  const result = gate.checkGate(req.params.id, revisionId);
  res.json({ ...result, pending, subscriptionCount });
}));

// ---- 具名豁免：创建（必填名称与理由，严格绑定事件+版本）/ 列表 / 撤销 ----
app.get('/api/projects/:id/gate/exemptions', wrap((req, res) => {
  res.json({ exemptions: gate.listExemptions(req.params.id) });
}));

app.post('/api/projects/:id/gate/evaluations/:eid/exemptions', wrap((req, res) => {
  const b = req.body || {};
  const result = gate.createExemption(req.params.id, req.params.eid, {
    name: b.name, reason: b.reason,
  }, String(b.author || '匿名'));
  res.status(201).json(result);
}));

app.post('/api/gate/exemptions/:xid/revoke', wrap((req, res) => {
  const row = gate.getExemption(req.params.xid);
  if (!row) return res.status(404).json({ error: '豁免不存在' });
  res.json(gate.revokeExemption(row.project_id, req.params.xid, { reason: req.body?.reason }, String(req.body?.author || '匿名')));
}));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`字幕校对服务已启动: http://localhost:${PORT}`));
