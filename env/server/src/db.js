'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  settings     TEXT NOT NULL DEFAULT '{}',
  head_id      TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent1_id   TEXT,                       -- 主父节点
  parent2_id   TEXT,                       -- 合并提交的第二父节点（分支合并时保留版本关系）
  kind         TEXT NOT NULL,              -- edit | create | merge | import | rollback
  snapshot     TEXT NOT NULL,
  author       TEXT NOT NULL,
  message      TEXT NOT NULL DEFAULT '',
  meta         TEXT,                       -- 导入/回滚清单（{kind:'import'|'rollback', ...}）
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_project ON revisions(project_id);

-- 导入预览后若命中并发冲突，导入上下文（文件内容、映射、勾选）暂存于此，
-- 裁决提交时凭 jobId 取回，保证跳过原因等审计信息由服务端生成、不被客户端篡改
CREATE TABLE IF NOT EXISTS import_jobs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  base_rev_id  TEXT NOT NULL,              -- 用户看到并据以校验的版本（三向合并的共同祖先）
  head_rev_id  TEXT NOT NULL,              -- 冲突时的 HEAD（裁决会话的 parent）
  content      TEXT NOT NULL,
  filename     TEXT NOT NULL DEFAULT '',
  options      TEXT NOT NULL,              -- 映射/默认轨/自动建轨/勾选
  meta         TEXT NOT NULL,              -- 提交后要写入版本的导入清单
  skips        TEXT NOT NULL,              -- 审计跳过条目
  author       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL,
  revision_id  TEXT NOT NULL,
  field        TEXT NOT NULL,             -- cue:<id>:<field> | track:<id>:<field> | settings:<key>
  action       TEXT NOT NULL,             -- add | edit | delete | restore
  old_value    TEXT,
  new_value    TEXT,
  author       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit(project_id, id);
`);

// 旧库迁移：revisions.meta（导入/回滚清单）
const cols = db.prepare('PRAGMA table_info(revisions)').all().map((c) => c.name);
if (!cols.includes('meta')) {
  db.exec('ALTER TABLE revisions ADD COLUMN meta TEXT');
}

module.exports = { db, DATA_DIR };
