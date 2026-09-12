'use strict';
const crypto = require('crypto');
const { db } = require('./db');
const { mergeSnapshots } = require('./merge');
const { normalizeSnapshot, validate, diffForAudit } = require('./validation');
const importer = require('./importer');

const now = () => Date.now();
const rid = () => 'r_' + crypto.randomBytes(9).toString('hex');
const jid = () => 'j_' + crypto.randomBytes(9).toString('hex');

function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
function getRevision(revId) {
  const row = db.prepare('SELECT * FROM revisions WHERE id = ?').get(revId);
  if (row) {
    row.snapshot = JSON.parse(row.snapshot);
    if (row.meta) row.meta = JSON.parse(row.meta);
  }
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
  `INSERT INTO revisions (id, project_id, parent1_id, parent2_id, kind, snapshot, author, message, meta, created_at)
   VALUES (@id, @project_id, @parent1_id, @parent2_id, @kind, @snapshot, @author, @message, @meta, @created_at)`,
);
const setHead = db.prepare('UPDATE projects SET head_id = ? WHERE id = ?');

function commitRevision({ projectId, parent1, parent2, kind, snapshot, author, message, auditAgainst, extraAudit, meta }) {
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
    meta: meta ? JSON.stringify(meta) : null,
    created_at: now(),
  });
  setHead.run(id, projectId);
  if (auditAgainst) {
    writeAudit(projectId, id, diffForAudit(auditAgainst, snapshot), author);
  }
  if (Array.isArray(extraAudit) && extraAudit.length) {
    writeAudit(projectId, id, extraAudit, author);
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
  const rows = db
    .prepare('SELECT id, parent1_id, parent2_id, kind, author, message, meta, created_at FROM revisions WHERE project_id = ? ORDER BY created_at DESC, id DESC')
    .all(projectId);
  for (const r of rows) r.meta = r.meta ? JSON.parse(r.meta) : null;
  return rows;
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

/* ============================ 批量导入 ============================ */

/** 导入预览：解析基于 baseRevId（用户当前看到的版本），不产生任何写入。 */
function previewImport(projectId, { baseRevId, content, filename, options }) {
  const project = getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const base = getRevision(baseRevId);
  if (!base || base.project_id !== projectId) throw httpError(400, 'baseRevId 无效');
  const preview = importer.buildPreview(base.snapshot, String(content ?? ''), options || {}, filename || '');
  const stale = project.head_id !== baseRevId;
  return { preview, baseRevId, headRevId: project.head_id, stale };
}

function skipAuditEntries(skips) {
  return (skips || []).map((s) => ({
    field: `import:row${s.seq}`,
    action: 'skip',
    oldValue: null,
    newValue: JSON.stringify({ reason: s.reason, cueId: s.cueId || null, text: String(s.text || '').slice(0, 120) }),
  }));
}

function importMetaFrom(result, { source, baseRevId, headRevId }) {
  return {
    kind: 'import',
    source: source || '',
    baseRevId,
    headRevId,
    imported: {
      addedCueIds: result.added,
      updated: result.updated,
      addedTracks: result.addedTracks,
    },
    skips: result.skips,
    rolledBack: false,
  };
}

/**
 * 应用导入。baseRevId 必须是用户预览时看到的版本：
 *   - 仍是 HEAD：线性 import 提交；
 *   - HEAD 已推进：对 base/导入结果/HEAD 做三向合并，逐句冲突返回 409，
 *     导入上下文存入 import_jobs，裁决时凭 jobId 取回，绝不整体覆盖。
 */
function commitImport(projectId, { baseRevId, content, filename, options, included, author, message }) {
  const project = getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const head = getRevision(project.head_id);
  const base = getRevision(baseRevId);
  if (!base || base.project_id !== projectId) throw httpError(400, 'baseRevId 无效');

  // 服务端重新解析与校验，不信任客户端预览
  const preview = importer.buildPreview(base.snapshot, String(content ?? ''), options || {}, filename || '');
  const result = importer.applyImport(base.snapshot, preview, included || []);
  const mine = normalizeSnapshot(result.snapshot);
  const hard = validate(mine).hardErrors;
  if (hard.length) throw httpError(400, '导入结果存在反向区间', { hardErrors: hard });

  const skipEntries = skipAuditEntries(result.skips);
  const meta = importMetaFrom(result, { source: filename || preview.format, baseRevId, headRevId: head.id });
  const msg = message || `批量导入（${filename || preview.format}）：新增 ${result.added.length}，修改 ${result.updated.length}，跳过 ${result.skips.length}`;

  if (base.id === head.id) {
    const rev = commitRevision({
      projectId,
      parent1: head.id,
      parent2: null,
      kind: 'import',
      snapshot: mine,
      author,
      message: msg,
      auditAgainst: head.snapshot,
      extraAudit: skipEntries,
      meta,
    });
    return { status: 'committed', revision: rev, report: reportFrom(result), violations: validate(mine).violations };
  }

  // 并发：三向合并
  const merged = mergeSnapshots(base.snapshot, mine, head.snapshot);
  const mergedSnap = normalizeSnapshot(merged.snapshot);
  const hardMerged = validate(mergedSnap).hardErrors;
  if (hardMerged.length && !merged.conflicts.length) {
    throw httpError(400, '合并后存在反向区间', { hardErrors: hardMerged });
  }
  if (!merged.conflicts.length) {
    const rev = commitRevision({
      projectId,
      parent1: head.id,
      parent2: base.id,
      kind: 'import',
      snapshot: mergedSnap,
      author,
      message: msg + '（自动合并他人修改）',
      auditAgainst: head.snapshot,
      extraAudit: skipEntries,
      meta: { ...meta, merged: true },
    });
    return { status: 'committed', revision: rev, report: reportFrom(result), violations: validate(mergedSnap).violations };
  }

  // 有冲突：暂存导入上下文，交给人工裁决
  const jobId = jid();
  db.prepare(
    `INSERT INTO import_jobs (id, project_id, base_rev_id, head_rev_id, content, filename, options, meta, skips, author, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    jobId,
    projectId,
    base.id,
    head.id,
    String(content ?? ''),
    filename || '',
    JSON.stringify({ options: options || {}, included: included || [] }),
    JSON.stringify(meta),
    JSON.stringify(result.skips),
    author || '匿名',
    now(),
  );
  return {
    status: 'conflict',
    jobId,
    conflicts: merged.conflicts,
    merged: mergedSnap,
    base,
    head,
    report: reportFrom(result),
    violations: validate(mergedSnap).violations,
    hardErrors: hardMerged,
  };
}

function reportFrom(result) {
  return {
    added: result.added.length,
    updated: result.updated.length,
    skipped: result.skips.length,
    addedTracks: result.addedTracks,
  };
}

/**
 * 导入冲突的人工裁决提交。与普通 resolve 的区别：
 * 凭 jobId 取回导入上下文；若裁决期间 HEAD 又推进，以会话 HEAD 为 base 再合并一次；
 * 跳过条目（非法/重复/人工排除）由服务端写入审计。
 */
function resolveImportJob(projectId, { jobId, resolvedSnapshot, conflictKeys, author, message }) {
  const jobRow = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(jobId);
  if (!jobRow || jobRow.project_id !== projectId) throw httpError(400, '导入会话不存在或已失效');
  const project = getProject(projectId);
  const head = getRevision(project.head_id);
  const parent = getRevision(jobRow.head_rev_id);
  const base = getRevision(jobRow.base_rev_id);
  const skips = JSON.parse(jobRow.skips);
  const meta = JSON.parse(jobRow.meta);

  let resolved;
  try {
    resolved = normalizeSnapshot(resolvedSnapshot);
  } catch (e) {
    throw httpError(400, e.message);
  }
  const hard = validate(resolved).hardErrors;
  if (hard.length) throw httpError(400, '解决结果中存在反向区间', { hardErrors: hard });

  const skipEntries = skipAuditEntries(skips);
  const resolveEntries = (conflictKeys || []).map((k) => ({
    field: `conflict:${k}`,
    action: 'resolve',
    oldValue: null,
    newValue: '"import-mine-or-theirs"',
  }));
  const msg = meta.source ? `批量导入冲突裁决（${meta.source}）` : '批量导入冲突裁决';

  let snapshotToCommit = resolved;
  let parent1 = head.id;
  let parent2 = base.id;
  let commitMessage = message || msg;

  if (head.id !== parent.id) {
    // 裁决期间又有新提交：以会话 HEAD 为共同祖先再做一次三向合并
    const again = mergeSnapshots(parent.snapshot, resolved, head.snapshot);
    if (again.conflicts.length) {
      return {
        status: 'conflict',
        conflicts: again.conflicts,
        merged: normalizeSnapshot(again.snapshot),
        base: parent,
        head,
        jobId,
      };
    }
    snapshotToCommit = normalizeSnapshot(again.snapshot);
    parent1 = head.id;
    parent2 = parent.id;
  }

  const rev = commitRevision({
    projectId,
    parent1,
    parent2,
    kind: 'import',
    snapshot: snapshotToCommit,
    author: String(author || jobRow.author || '匿名'),
    message: commitMessage,
    auditAgainst: head.snapshot,
    extraAudit: [...skipEntries, ...resolveEntries],
    meta: { ...meta, headRevId: head.id, merged: true, resolved: true },
  });
  db.prepare('DELETE FROM import_jobs WHERE id = ?').run(jobId);
  return { status: 'committed', revision: rev, violations: validate(snapshotToCommit).violations };
}

/** 沿第一父链找到最近一次导入；其之后存在导入/回滚提交则视为已经处理过。 */
function findUndoableImport(project) {
  let cur = getRevision(project.head_id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.kind === 'rollback') {
      const id = cur.meta?.undoneRevisionId;
      return { importRev: null, alreadyId: id || null, reason: 'last-import-already-rolled-back' };
    }
    if (cur.kind === 'import') {
      if (cur.meta?.rolledBack) return { importRev: null, reason: 'last-import-already-rolled-back' };
      if (!cur.parent1_id) return { importRev: null, reason: 'no-pre-revision' };
      const pre = getRevision(cur.parent1_id);
      if (!pre) return { importRev: null, reason: 'no-pre-revision' };
      return { importRev: cur, pre };
    }
    cur = cur.parent1_id ? getRevision(cur.parent1_id) : null;
  }
  return { importRev: null, reason: 'no-import' };
}

/** 撤销最近一次导入：只回滚导入后未被改动的句子，其余逐条跳过并写原因；本身生成新版本。 */
function undoLastImport(projectId, { author, message } = {}) {
  const project = getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const head = getRevision(project.head_id);
  const found = findUndoableImport(project);
  if (!found.importRev) {
    const label = {
      'no-import': '当前项目历史中没有可撤销的导入',
      'last-import-already-rolled-back': '最近一次导入已经撤销过，不能重复回滚',
      'no-pre-revision': '该导入没有可回滚的前序版本',
    }[found.reason] || '没有可撤销的导入';
    throw httpError(400, label, { reason: found.reason });
  }
  const { importRev, pre } = found;
  const plan = importer.planRollback(pre.snapshot, importRev.meta.imported, head.snapshot);
  const snapshot = normalizeSnapshot(plan.snapshot);
  const hard = validate(snapshot).hardErrors;
  if (hard.length) throw httpError(400, '回滚结果存在反向区间', { hardErrors: hard });

  // 所有导入条目在此期间都被他人改动/删除：不产生空版本，逐条原因交回给用户
  if (!plan.rolledCueIds.length && !plan.rolledTracks.length) {
    throw httpError(400, '没有可回滚的句子：导入内容在此期间都已被修改或删除', {
      reason: 'nothing-to-rollback',
      skipped: plan.skipped,
    });
  }

  const skipCount = plan.skipped.length;
  const rollbackMeta = {
    kind: 'rollback',
    undoneRevisionId: importRev.id,
    rolledCueIds: plan.rolledCueIds,
    rolledTracks: plan.rolledTracks,
    skipped: plan.skipped,
  };
  const rev = commitRevision({
    projectId,
    parent1: head.id,
    parent2: null,
    kind: 'rollback',
    snapshot,
    author: String(author || '匿名'),
    message: message || `撤销导入「${importRev.message || importRev.id}」（回滚 ${plan.rolledCueIds.length} 句，跳过 ${skipCount} 句）`,
    auditAgainst: null,
    extraAudit: plan.entries,
    meta: rollbackMeta,
  });
  return { status: 'committed', revision: rev, rolledBack: plan.rolledCueIds.length, skipped: plan.skipped };
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
  previewImport,
  commitImport,
  resolveImportJob,
  undoLastImport,
  listRevisions,
  listAudit,
  listProjects,
};
