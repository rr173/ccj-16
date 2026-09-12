'use strict';
const crypto = require('crypto');
const { db } = require('./db');
const { mergeSnapshots } = require('./merge');
const { normalizeSnapshot, validate, diffForAudit } = require('./validation');

const now = () => Date.now();
const rid = () => 'r_' + crypto.randomBytes(9).toString('hex');

function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
function getRevision(revId) {
  const row = db.prepare('SELECT * FROM revisions WHERE id = ?').get(revId);
  if (row) row.snapshot = JSON.parse(row.snapshot);
  return row;
}

function writeAudit(projectId, revisionId, entries, author) {
  const stmt = db.prepare(
    `INSERT INTO audit (project_id, revision_id, field, action, old_value, new_value, author, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const t = now();
  for (const e of entries) {
    stmt.run(projectId, revisionId, e.field, e.action, e.oldValue ?? null, e.newValue ?? null, author, t);
  }
}

const insertRevision = db.prepare(
  `INSERT INTO revisions (id, project_id, parent1_id, parent2_id, kind, snapshot, author, message, created_at)
   VALUES (@id, @project_id, @parent1_id, @parent2_id, @kind, @snapshot, @author, @message, @created_at)`,
);
const setHead = db.prepare('UPDATE projects SET head_id = ? WHERE id = ?');

function commitRevision({ projectId, parent1, parent2, kind, snapshot, author, message, auditAgainst }) {
  const id = rid();
  insertRevision.run({
    id,
    project_id: projectId,
    parent1_id: parent1,
    parent2_id: parent2,
    kind,
    snapshot: JSON.stringify(snapshot),
    author,
    message: message || '',
    created_at: now(),
  });
  setHead.run(id, projectId);
  if (auditAgainst) {
    writeAudit(projectId, id, diffForAudit(auditAgainst, snapshot), author);
  }
  return getRevision(id);
}

function createProject(name, author) {
  const id = 'p_' + crypto.randomBytes(9).toString('hex');
  const initial = normalizeSnapshot({
    duration: 600000,
    settings: {},
    tracks: [{ id: 't_main', name: '主轨', color: '#4e8cff', mutexGroup: null }],
    cues: [],
  });
  db.prepare('INSERT INTO projects (id, name, settings, head_id, created_at) VALUES (?,?,?,?,?)').run(
    id,
    name || '未命名项目',
    '{}',
    null,
    now(),
  );
  const rev = commitRevision({
    projectId: id,
    parent1: null,
    parent2: null,
    kind: 'create',
    snapshot: initial,
    author,
    message: '创建项目',
    auditAgainst: null,
  });
  return { project: getProject(id), revision: rev };
}

/**
 * 提交（可能引发三向合并）。
 * 返回 { status: 'committed'|'conflict', revision?, conflicts?, merged?, base?, head?, violations? }
 */
function submitRevision(projectId, { baseRevId, snapshot, author, message }) {
  const project = getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const head = getRevision(project.head_id);
  const base = getRevision(baseRevId);
  if (!base || base.project_id !== projectId) throw httpError(400, 'baseRevId 无效');

  let mine;
  try {
    mine = normalizeSnapshot(snapshot);
  } catch (e) {
    throw httpError(400, e.message);
  }
  let hard = validate(mine).hardErrors;
  if (hard.length) throw httpError(400, '存在反向区间，无法保存', { hardErrors: hard });

  // 快进路径：我基于的就是当前 HEAD
  if (base.id === head.id) {
    const rev = commitRevision({
      projectId,
      parent1: head.id,
      parent2: null,
      kind: 'edit',
      snapshot: mine,
      author,
      message,
      auditAgainst: head.snapshot,
    });
    return { status: 'committed', revision: rev, violations: validate(mine).violations };
  }

  // 并发路径：三向合并，只自动并入无冲突的句子
  const result = mergeSnapshots(base.snapshot, mine, head.snapshot);
  const merged = normalizeSnapshot(result.snapshot);
  hard = validate(merged).hardErrors;
  if (hard.length && !result.conflicts.length) throw httpError(400, '合并后存在反向区间', { hardErrors: hard });

  if (result.conflicts.length) {
    return {
      status: 'conflict',
      conflicts: result.conflicts,
      merged,
      base,
      head,
      violations: validate(merged).violations,
      hardErrors: hard,
    };
  }

  const rev = commitRevision({
    projectId,
    parent1: head.id,
    parent2: base.id,
    kind: 'merge',
    snapshot: merged,
    author,
    message: message || '合并他人修改',
    auditAgainst: head.snapshot,
  });
  return { status: 'committed', revision: rev, violations: validate(merged).violations };
}

/**
 * 应用用户在冲突对话框中的选择后提交。
 * resolvedSnapshot 为完整快照；parentRevId=解决时依据的 HEAD，otherRevId=自己的 base。
 * 若期间 HEAD 又被人推进，则以"已解决快照"为 mine、旧 HEAD 为 base 再做一次三向合并。
 */
function resolveRevision(projectId, { parentRevId, otherRevId, resolvedSnapshot, conflictKeys, author, message }) {
  const project = getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const head = getRevision(project.head_id);
  const parent = getRevision(parentRevId);
  const other = getRevision(otherRevId);
  if (!parent || !other || parent.project_id !== projectId || other.project_id !== projectId) {
    throw httpError(400, '父版本无效');
  }
  let resolved;
  try {
    resolved = normalizeSnapshot(resolvedSnapshot);
  } catch (e) {
    throw httpError(400, e.message);
  }
  const hard = validate(resolved).hardErrors;
  if (hard.length) throw httpError(400, '解决结果中存在反向区间', { hardErrors: hard });

  if (head.id !== parent.id) {
    // 又有新提交：把用户的解决结果再次三向合并
    const result = mergeSnapshots(parent.snapshot, resolved, head.snapshot);
    const merged = normalizeSnapshot(result.snapshot);
    if (result.conflicts.length) {
      return {
        status: 'conflict',
        conflicts: result.conflicts,
        merged,
        base: parent,
        head,
        violations: validate(merged).violations,
        hardErrors: validate(merged).hardErrors,
      };
    }
    const rev = commitRevision({
      projectId,
      parent1: head.id,
      parent2: parent.id,
      kind: 'merge',
      snapshot: merged,
      author,
      message: message || '解决冲突并合并',
      auditAgainst: head.snapshot,
    });
    return { status: 'committed', revision: rev, violations: validate(merged).violations };
  }

  const rev = commitRevision({
    projectId,
    parent1: head.id,
    parent2: other.id,
    kind: 'merge',
    snapshot: resolved,
    author,
    message: message || '解决冲突并合并',
    auditAgainst: head.snapshot,
  });
  // 记录人工裁决
  if (Array.isArray(conflictKeys) && conflictKeys.length) {
    writeAudit(
      projectId,
      rev.id,
      conflictKeys.map((k) => ({ field: `conflict:${k}`, action: 'resolve', oldValue: null, newValue: '"mine-or-theirs"' })),
      author,
    );
  }
  return { status: 'committed', revision: rev, violations: validate(resolved).violations };
}

function listRevisions(projectId) {
  return db
    .prepare('SELECT id, parent1_id, parent2_id, kind, author, message, created_at FROM revisions WHERE project_id = ? ORDER BY created_at DESC, id DESC')
    .all(projectId);
}

function listAudit(projectId, limit = 300) {
  return db
    .prepare(
      `SELECT a.*, r.message AS revision_message
       FROM audit a JOIN revisions r ON r.id = a.revision_id
       WHERE a.project_id = ? ORDER BY a.id DESC LIMIT ?`,
    )
    .all(projectId, limit);
}

function listProjects() {
  return db.prepare('SELECT id, name, head_id, created_at FROM projects ORDER BY created_at DESC').all();
}

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra;
  return e;
}

module.exports = {
  createProject,
  getProject,
  getRevision,
  submitRevision,
  resolveRevision,
  listRevisions,
  listAudit,
  listProjects,
};
