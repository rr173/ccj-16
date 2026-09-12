'use strict';
const path = require('path');
const express = require('express');
const store = require('./store');
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

app.get('/api/revisions/:revId/violations', wrap((req, res) => {
  const rev = store.getRevision(req.params.revId);
  if (!rev) return res.status(404).json({ error: '版本不存在' });
  res.json(validate(rev.snapshot));
}));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`字幕校对服务已启动: http://localhost:${PORT}`));
