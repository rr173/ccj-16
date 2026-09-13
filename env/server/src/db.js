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

-- ============ 交付质检与发布快照 ============

-- 质量规则：track_id='' 为项目级默认，否则为轨道级覆盖；每条规则一行
CREATE TABLE IF NOT EXISTS qc_rules (
  project_id TEXT NOT NULL,
  track_id   TEXT NOT NULL DEFAULT '',
  rule_key   TEXT NOT NULL,              -- duration | cps | line_chars | gap | align
  enabled    INTEGER NOT NULL DEFAULT 1,
  severity   TEXT NOT NULL DEFAULT 'warning', -- blocker | warning
  params     TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, track_id, rule_key)
);

-- 质检任务：针对某个历史版本发起，异步分批执行，可取消；规则配置随任务冻结
CREATE TABLE IF NOT EXISTS qc_jobs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  revision_id    TEXT NOT NULL,
  rules_snapshot TEXT NOT NULL,          -- 发起时冻结的规则配置
  rules_hash     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running', -- running | done | cancelled | failed
  progress       TEXT NOT NULL DEFAULT '{}',      -- {done,total}
  summary        TEXT,                   -- 统计 {total,blocker,warning,byRule,byTrack}
  author         TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  finished_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_qcjobs_project ON qc_jobs(project_id, created_at);

-- 质检结果：逐句一条；basis 记录发现时句子基准值，修复时据此防止覆盖他人新修改
CREATE TABLE IF NOT EXISTS qc_findings (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES qc_jobs(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL,
  revision_id      TEXT NOT NULL,        -- 发现所基于的版本
  cue_id           TEXT NOT NULL,
  track_id         TEXT NOT NULL,
  rule_key         TEXT NOT NULL,
  severity         TEXT NOT NULL,        -- blocker | warning
  actual           TEXT NOT NULL,        -- JSON 实际值 {value,limit,unit,...}
  evidence         TEXT NOT NULL,        -- 证据描述
  suggestion       TEXT,                 -- JSON 建议 {kind,patch,safe,describe}
  basis            TEXT NOT NULL,        -- JSON 发现时句子基准 {start,end,text,locked}
  status           TEXT NOT NULL DEFAULT 'open', -- open | ignored | fixed | stale | confirmed
  decided_by       TEXT,
  decided_at       INTEGER,
  decide_reason    TEXT,
  decided_on_rev   TEXT,                 -- 处理决定所基于的 HEAD 版本
  fix_revision_id  TEXT,                 -- 修复产生的版本
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qcf_job ON qc_findings(job_id);
CREATE INDEX IF NOT EXISTS idx_qcf_cue ON qc_findings(project_id, cue_id);

-- 结果状态变化事件流：某句从发现到处理的完整历史
CREATE TABLE IF NOT EXISTS qc_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  finding_id  TEXT NOT NULL,
  action      TEXT NOT NULL,             -- found | ignore | fix | stale | confirm
  actor       TEXT NOT NULL,
  reason      TEXT,
  revision_id TEXT,                      -- 关联版本
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qce_finding ON qc_events(finding_id);
CREATE INDEX IF NOT EXISTS idx_qce_project ON qc_events(project_id, id);

-- 发布快照：冻结句子/轨道/规则配置/质检摘要与渲染好的 SRT/VTT 文件
CREATE TABLE IF NOT EXISTS releases (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  revision_id     TEXT NOT NULL,         -- 来源版本
  seq             INTEGER NOT NULL,      -- 项目内递增序号
  label           TEXT NOT NULL,         -- 唯一版本标识 REL-001 ...
  snapshot        TEXT NOT NULL,         -- 冻结的 {duration,tracks,cues,settings}
  rules_snapshot  TEXT NOT NULL,         -- 冻结的规则配置
  qc_summary      TEXT NOT NULL,         -- 冻结的质检摘要
  files           TEXT NOT NULL,         -- JSON {srt:{<trackId|all>:...}, vtt:{...}}
  status          TEXT NOT NULL DEFAULT 'published', -- published | withdrawn
  message         TEXT NOT NULL DEFAULT '',
  author          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  withdrawn_by    TEXT,
  withdrawn_at    INTEGER,
  withdraw_reason TEXT
);
-- 发布申请：预检通过后生成，绑定来源版本与当时的预检结果（preflight 快照 + 指纹）；
-- 审核人可批准/驳回，只有批准且绑定内容仍与当前一致时才能发布。
-- 状态机：pending（待处理）→ approved（已批准）/ rejected（已驳回）/ invalidated（已失效）；
--        approved → published（已发布）/ invalidated。
CREATE TABLE IF NOT EXISTS release_requests (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  revision_id      TEXT NOT NULL,         -- 绑定的来源版本
  head_rev_id      TEXT NOT NULL,         -- 申请时项目 HEAD（版本产生新提交即失效）
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | invalidated | published
  preflight        TEXT NOT NULL,         -- 冻结的完整预检结果（绑定）
  fingerprint      TEXT NOT NULL,         -- 预检结果指纹：阻断处理/警告确认变化即失效
  confirmations    TEXT NOT NULL DEFAULT '[]', -- 申请时逐项确认的警告 finding id
  message          TEXT NOT NULL DEFAULT '',
  applicant        TEXT NOT NULL,         -- 申请人署名
  reviewer         TEXT,                  -- 审核人署名
  review_comment   TEXT,                  -- 审核意见（驳回必填）
  invalid_reason   TEXT,                  -- 失效原因 new-revision | blockers-changed | warnings-changed | hard-error | qc-changed
  created_at       INTEGER NOT NULL,
  reviewed_at      INTEGER,
  invalidated_at   INTEGER,
  published_at     INTEGER,
  release_id       TEXT                   -- 发布后关联的快照 id
);
CREATE INDEX IF NOT EXISTS idx_relreq_project ON release_requests(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_relreq_rev ON release_requests(project_id, revision_id);
-- 同一项目同一版本同时只允许一个进行中（待处理/已批准）的申请：
-- 重复提交命中该索引即返回已有申请（幂等），不产生重复记录
CREATE UNIQUE INDEX IF NOT EXISTS uq_relreq_active
  ON release_requests(project_id, revision_id) WHERE status IN ('pending', 'approved');

-- 同一版本只允许存在一个有效发布：重复发布命中该索引时返回已有快照，不产生重复
CREATE UNIQUE INDEX IF NOT EXISTS uq_release_published
  ON releases(project_id, revision_id) WHERE status = 'published';
`);

// 旧库迁移：revisions.meta（导入/回滚清单）
const cols = db.prepare('PRAGMA table_info(revisions)').all().map((c) => c.name);
if (!cols.includes('meta')) {
  db.exec('ALTER TABLE revisions ADD COLUMN meta TEXT');
}

module.exports = { db, DATA_DIR };
