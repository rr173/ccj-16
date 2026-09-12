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
  kind         TEXT NOT NULL,              -- edit | create | merge
  snapshot     TEXT NOT NULL,
  author       TEXT NOT NULL,
  message      TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_project ON revisions(project_id);

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

module.exports = { db, DATA_DIR };
