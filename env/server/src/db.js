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

-- ============ 版本差异报告 ============
-- 生成时冻结比较双方（历史版本或发布快照）的快照内容与生成时间；
-- 软删除后内容清空不可再读，但行保留用于审计追溯
CREATE TABLE IF NOT EXISTS diff_reports (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  from_kind     TEXT NOT NULL,          -- revision | release
  from_ref      TEXT NOT NULL,          -- 版本 id 或发布快照 id
  from_label    TEXT NOT NULL,
  from_rev_id   TEXT NOT NULL,          -- 定位链接落到的版本（快照取其来源版本）
  to_kind       TEXT NOT NULL,
  to_ref        TEXT NOT NULL,
  to_label      TEXT NOT NULL,
  to_rev_id     TEXT NOT NULL,
  filters       TEXT NOT NULL,          -- 生成时冻结的筛选条件 {trackId,types,keyword}
  filter_hash   TEXT NOT NULL,
  pair_hash     TEXT NOT NULL,          -- 版本对指纹
  from_snapshot TEXT NOT NULL,          -- 冻结的比较双方内容
  to_snapshot   TEXT NOT NULL,
  items         TEXT NOT NULL,          -- 全量差异项（筛选在读取/导出时应用）
  summary       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- active | deleted
  author        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,       -- 生成时间（随报告冻结）
  deleted_by    TEXT,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_diffreport_project ON diff_reports(project_id, created_at);
-- 幂等：同一项目 + 同一对版本 + 同一组筛选条件只存在一个有效报告，重复生成返回同一报告
CREATE UNIQUE INDEX IF NOT EXISTS uq_diffreport_active
  ON diff_reports(project_id, pair_hash, filter_hash) WHERE status = 'active';

-- ============ 发布回归门禁与变更订阅 ============

-- 订阅：用户可就同一项目创建多个，分别指定基线（历史版本或发布快照）、
-- 关注轨道、差异类型、关键词与质检严重级别。暂停后不随提交触发评估，但手动重跑仍可用。
CREATE TABLE IF NOT EXISTS gate_subscriptions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  baseline_kind   TEXT NOT NULL,             -- revision | release
  baseline_ref    TEXT NOT NULL,             -- 版本 id 或发布快照 id
  baseline_label  TEXT NOT NULL,
  baseline_rev_id TEXT NOT NULL,             -- 基线落到的版本（快照取其来源版本）
  baseline_snapshot TEXT NOT NULL,           -- 创建/修改订阅时冻结的基线内容（快照撤销也不影响评估）
  track_ids       TEXT NOT NULL DEFAULT '[]',-- 关注轨道；[] 表示全部轨道
  diff_types      TEXT NOT NULL DEFAULT '[]',-- 关注差异类型 added/deleted/track/time/text/lock；[] 表示全部
  keyword         TEXT NOT NULL DEFAULT '',  -- 关键词（命中差异项的文本/轨道等）
  qc_severities   TEXT NOT NULL DEFAULT '["blocker"]', -- 关注的质检严重级别
  status          TEXT NOT NULL DEFAULT 'active',      -- active | paused
  config_hash     TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_by      TEXT,
  updated_at      INTEGER,
  paused_by       TEXT,
  paused_at       INTEGER,
  resumed_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gatesub_project ON gate_subscriptions(project_id, created_at);

-- 评估（唯一事件编号 GATE-项目序号-序号）：每次触发针对一个目标版本异步重算，
-- 始终以触发时的最新 HEAD（或发布申请显式指定的旧版本）为目标，逐项记录
-- 相对基线新增/恶化/恢复/持续的差异与新出现的阻断级质检问题。
-- target_revision_id 对同一订阅可能多次评估（不同 HEAD / 手动重跑）。
CREATE TABLE IF NOT EXISTS gate_evaluations (
  id                  TEXT PRIMARY KEY,
  event_no            TEXT NOT NULL,         -- 项目内唯一事件编号 GATE-0001-000007
  project_id          TEXT NOT NULL,
  subscription_id     TEXT NOT NULL,
  target_revision_id  TEXT NOT NULL,
  trigger             TEXT NOT NULL,         -- commit | release-request | manual
  triggered_by        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  config_snapshot     TEXT NOT NULL,         -- 冻结的订阅条件（轨道/类型/关键词/级别）
  config_hash         TEXT NOT NULL,
  baseline_kind       TEXT NOT NULL,
  baseline_ref        TEXT NOT NULL,
  baseline_label      TEXT NOT NULL,
  baseline_rev_id     TEXT NOT NULL,
  baseline_snapshot   TEXT NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  items               TEXT,                  -- 逐项证据（完成后冻结）
  summary             TEXT,                  -- {counts:{new,worsened,recovered,persisting,qcNew}, gateHit}
  result_hash         TEXT,                  -- 结果指纹：同订阅同版本同结果的重跑直接复用，不产生重复结果/通知
  gate_hit            INTEGER NOT NULL DEFAULT 0,
  head_at_start       TEXT,                  -- 入队时的项目 HEAD
  error               TEXT,
  notif_status        TEXT NOT NULL DEFAULT 'none', -- none | sent | skipped（与上一事件结果相同，跳过通知）
  deduplicated        INTEGER NOT NULL DEFAULT 0,    -- 1：重跑命中已有同结果事件，复用未重算
  created_at          INTEGER NOT NULL,
  started_at          INTEGER,
  finished_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gateeval_project ON gate_evaluations(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gateeval_sub ON gate_evaluations(subscription_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gateeval_target ON gate_evaluations(project_id, target_revision_id);
-- 事件编号项目内唯一
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateeval_event_no ON gate_evaluations(project_id, event_no);
-- 进行中的评估去重：同一订阅 + 同一目标版本 + 同一触发来源只允许一个未完成事件，
-- 重复触发/重复重跑命中该索引即复用，不产生重复结果与重复通知。
-- commit 事件以目标版本为最新 HEAD 入队，worker 执行时总是重定向到当时最新 HEAD
-- （并发新提交合并到同一事件），其并发去重由应用层按订阅串行合并保证。
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateeval_inflight
  ON gate_evaluations(subscription_id, target_revision_id, trigger)
  WHERE status IN ('queued', 'running') AND trigger IN ('release-request','qc','manual');

-- 具名豁免：门禁命中后，只有审核人针对「本次事件 + 该版本」创建具名豁免（必填理由），
-- 才允许基于该版本提交发布申请/生成快照。豁免严格绑定事件与版本，
-- 新版本产生新的评估事件后必须重新申请豁免，不能被沿用。
CREATE TABLE IF NOT EXISTS gate_exemptions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  revision_id   TEXT NOT NULL,              -- 严格绑定的版本
  name          TEXT NOT NULL,              -- 具名（豁免名称/审核具名）
  reviewer      TEXT NOT NULL,              -- 创建豁免的审核人
  reason        TEXT NOT NULL,              -- 必填理由
  scope         TEXT NOT NULL DEFAULT 'all', -- all | items（保留：默认整事件豁免）
  item_keys     TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  revoked_by    TEXT,
  revoked_at    INTEGER,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_gateex_event ON gate_exemptions(event_id);
CREATE INDEX IF NOT EXISTS idx_gateex_rev ON gate_exemptions(project_id, revision_id);
-- 同一事件只允许一个有效豁免
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateex_event
  ON gate_exemptions(event_id) WHERE revoked_at IS NULL;

-- 项目内事件序号计数器
CREATE TABLE IF NOT EXISTS gate_counters (
  project_id TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL DEFAULT 0
);
`);

// 旧库迁移：revisions.meta（导入/回滚清单）
const cols = db.prepare('PRAGMA table_info(revisions)').all().map((c) => c.name);
if (!cols.includes('meta')) {
  db.exec('ALTER TABLE revisions ADD COLUMN meta TEXT');
}

module.exports = { db, DATA_DIR };
