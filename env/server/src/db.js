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
-- 配置审批策略后按冻结的策略分阶段会签，全部阶段通过才转为 approved。
-- 状态机：pending（待处理/会签中）→ approved（已批准）/ rejected（已驳回）/
--        expired（阶段超时，负责人在门禁仍满足时可重新开启）/ invalidated（已失效）；
--        approved → published（已发布）/ invalidated。expired → pending（重新开启）/ invalidated。
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

-- ============ 多阶段会签与审批策略 ============

-- 审批策略（每项目一份）：有顺序的审批阶段；每阶段指定审核角色、最少同意人数、
-- 是否允许驳回后重新提交与审批有效期（毫秒，0=不限）。提交发布申请时随申请冻结，
-- 此后策略变更会把进行中的申请标记为失效（policy-changed）。
CREATE TABLE IF NOT EXISTS approval_policies (
  project_id  TEXT PRIMARY KEY,
  stages      TEXT NOT NULL,             -- JSON [{role,minApprovals,allowResubmit,ttlMs}]
  policy_hash TEXT NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- 申请的阶段实例：提交时按冻结策略生成，逐阶段推进（waiting → active → approved/rejected/expired）
CREATE TABLE IF NOT EXISTS relreq_stages (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  stage_index      INTEGER NOT NULL,
  role             TEXT NOT NULL,          -- 审核角色（冻结）
  min_approvals    INTEGER NOT NULL,       -- 最少同意人数（冻结）
  allow_resubmit   INTEGER NOT NULL DEFAULT 1, -- 驳回后是否允许重新提交（冻结）
  ttl_ms           INTEGER NOT NULL DEFAULT 0, -- 审批有效期（冻结，0=不限）
  status           TEXT NOT NULL DEFAULT 'waiting', -- waiting | active | approved | rejected | expired
  started_at       INTEGER,                -- 阶段激活时间（有效期起算点）
  expires_at       INTEGER,                -- 阶段截止时间（ttl_ms=0 时为 NULL）
  decided_at       INTEGER,
  decided_by       TEXT,                   -- 驳回人 / 达标时最后一名同意人
  decision_comment TEXT,                   -- 阶段结论意见（驳回必填）
  expire_reason    TEXT,                   -- 过期原因
  reopened_count   INTEGER NOT NULL DEFAULT 0 -- 被负责人重新开启的次数
);
CREATE INDEX IF NOT EXISTS idx_relreq_stages_req ON relreq_stages(request_id, stage_index);

-- 会签意见：每位审核人在每个阶段只有一条决定（唯一索引保证重复操作幂等），
-- 意见、署名、时间全部保留
CREATE TABLE IF NOT EXISTS relreq_decisions (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL,
  stage_id    TEXT NOT NULL,
  stage_index INTEGER NOT NULL,
  project_id  TEXT NOT NULL,
  reviewer    TEXT NOT NULL,               -- 审核人署名
  role        TEXT NOT NULL,               -- 审核时所属角色（阶段冻结值）
  action      TEXT NOT NULL,               -- approve | reject
  comment     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_relreq_decision ON relreq_decisions(stage_id, reviewer);
CREATE INDEX IF NOT EXISTS idx_relreq_dec_req ON relreq_decisions(request_id, stage_index);

-- 申请级事件流：提交/阶段激活/会签意见/阶段通过与驳回/过期/重新开启/
-- 失效/重新提交/发布，构成发布页展示的完整审计记录
CREATE TABLE IF NOT EXISTS relreq_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  stage_index INTEGER,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relreq_events_req ON relreq_events(request_id, id);

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

-- ============ 讨论串（可挂在单句或时间范围上，跨版本跟随/待重新定位） ============

-- 讨论串：anchor_type=cue 时 anchor_id 为稳定句子编号；anchor_type=range 时为时间范围
-- （anchor_start/anchor_end + anchor_track，'' 表示全部轨道）。
-- anchor_status: anchored（已定位）| orphan（待重新定位：对应字幕被删除/拆分/无法唯一匹配）。
-- 自动跟随时 anchor 指向新版本的句子；孤儿保留 last_anchor_* 作为旧位置记录。
-- version 为乐观锁版本号：并发回复/解决/重开/重新定位用条件更新防止覆盖更新后的状态。
CREATE TABLE IF NOT EXISTS discussions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  anchor_type      TEXT NOT NULL,             -- cue | range
  anchor_id        TEXT,                      -- cue 锚点：当前对应句子编号（orphan 时为 NULL）
  anchor_track     TEXT,                      -- cue：所在轨（跟随跨轨移动）；range：范围轨（'' = 全部）
  anchor_start     INTEGER NOT NULL,          -- 定位时间（cue=句开始；range=范围开始），用于跳转
  anchor_end       INTEGER NOT NULL,          -- cue=句结束；range=范围结束
  anchor_status    TEXT NOT NULL DEFAULT 'anchored', -- anchored | orphan
  orphan_reason    TEXT,                      -- deleted | split | ambiguous | track-deleted
  orphan_since_rev TEXT,                      -- 进入待重新定位的版本
  orphan_detail    TEXT,                      -- JSON 旧位置快照与候选句子，供页面展示/人工选择
  last_anchor_id   TEXT,                      -- 上一次有效锚点（孤儿时的旧位置句子编号）
  last_anchor_track TEXT,
  last_anchor_start INTEGER,
  last_anchor_end   INTEGER,
  title            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'open', -- open | resolved（与 anchor_status 正交）
  resolved_by      TEXT,
  resolved_at      INTEGER,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  version          INTEGER NOT NULL DEFAULT 0   -- 乐观锁：每次消息/状态/定位变化 +1
);
CREATE INDEX IF NOT EXISTS idx_disc_project ON discussions(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_disc_cue ON discussions(project_id, anchor_id) WHERE anchor_status = 'anchored';
CREATE INDEX IF NOT EXISTS idx_disc_orphan ON discussions(project_id, anchor_status) WHERE anchor_status = 'orphan';

-- 讨论事件流（同时承载回复消息）：
--   kind=message 为回复；create/resolve/reopen/relocate/auto-follow/orphan 为状态/定位变化。
-- 定位事件 detail 记录旧位置、新位置与操作者，形成完整定位历史，页面可逐条查看。
-- client_token 非空时建唯一索引：重复请求命中同一令牌直接返回原事件，不产生重复回复。
CREATE TABLE IF NOT EXISTS discussion_events (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL,           -- 插入顺序（页面按时间线展示，不能用随机 id 排序）
  discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- message | create | resolve | reopen | relocate | auto-follow | orphan
  actor        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',  -- kind=message 的回复正文
  detail       TEXT,                      -- JSON：旧位置/新位置/原因/候选等
  client_token TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discevent_disc ON discussion_events(discussion_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_discevent_token ON discussion_events(project_id, client_token)
  WHERE client_token IS NOT NULL;

-- 讨论事件的每讨论串递增序号（插入顺序，供时间线按序展示）
CREATE TABLE IF NOT EXISTS discussion_event_seq (
  discussion_id TEXT PRIMARY KEY,
  seq            INTEGER NOT NULL DEFAULT 0
);

-- ============ 多版本字幕盲审对照 ============

-- 盲审轮次：创建时冻结 2~3 个历史版本的内容，并按稳定编号 + 时间接近度 + 文本相似度
-- 组成对照项；无法可靠对应的内容单列在 unmatched，绝不硬配成一组。
-- versions/items/unmatched 均为创建时冻结的 JSON，此后项目继续编辑不影响本轮。
-- 候选来源（槽位→版本）在达到最少有效提交人数前不出现在任何审阅/进度/导出接口中。
CREATE TABLE IF NOT EXISTS blind_rounds (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  min_submitters INTEGER NOT NULL,          -- 创建时设定的最少有效提交人数（达到前不能揭示来源/关闭）
  status         TEXT NOT NULL DEFAULT 'open', -- open | closed
  versions       TEXT NOT NULL,             -- 冻结 [{slot, revisionId, label, author, message, snapshot}]
  items          TEXT NOT NULL,             -- 冻结对照项 [{key, matchedBy, similarity, candidates:[{slot, cueId, trackId, trackName, start, end, text, locked}]}]
  unmatched      TEXT NOT NULL,             -- 冻结单列内容 [{slot, cueId, trackId, trackName, start, end, text, locked, reason}]
  version_count  INTEGER NOT NULL,
  item_count     INTEGER NOT NULL,
  unmatched_count INTEGER NOT NULL,
  result         TEXT,                      -- 关闭时冻结的结果（票数/意见/胜出版本/单列内容，来源已揭示）
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  revealed_by    TEXT,
  revealed_at    INTEGER,
  closed_by      TEXT,
  closed_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_blindround_project ON blind_rounds(project_id, created_at);

-- 每位审阅人每轮一份提交记录：answers 以候选槽位存储（服务端按审阅人独立的
-- 匿名顺序解码后落库）；version 为乐观锁，并发保存失配返回 409 + 当前结果，不静默覆盖。
-- status: draft（保存中）→ submitted（已提交）→ rejected（被组织者拒绝，不计入有效人数，可改后重提）
CREATE TABLE IF NOT EXISTS blind_submissions (
  id           TEXT PRIMARY KEY,
  round_id     TEXT NOT NULL REFERENCES blind_rounds(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  reviewer     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | submitted | rejected
  answers      TEXT NOT NULL DEFAULT '{}',    -- {itemKey: {choice, slot, comment}}
  version      INTEGER NOT NULL DEFAULT 0,    -- 乐观锁：每次保存/提交/拒绝 +1
  submitted_at INTEGER,
  rejected_by  TEXT,
  rejected_at  INTEGER,
  reject_reason TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_blindsub_reviewer ON blind_submissions(round_id, reviewer);

-- 盲审操作记录（创建/保存/提交/拒绝/关闭/揭示来源），页面可查询；
-- client_token 唯一索引保证同一保存/提交请求重复发送不产生重复记录。
CREATE TABLE IF NOT EXISTS blind_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL,
  round_id     TEXT NOT NULL,
  action       TEXT NOT NULL,              -- create | save | submit | reject | close | reveal
  actor        TEXT NOT NULL,
  detail       TEXT,
  client_token TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blindevent_round ON blind_events(round_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_blindevent_token ON blind_events(round_id, client_token)
  WHERE client_token IS NOT NULL;
`);

// 旧库迁移：revisions.meta（导入/回滚清单）
const cols = db.prepare('PRAGMA table_info(revisions)').all().map((c) => c.name);
if (!cols.includes('meta')) {
  db.exec('ALTER TABLE revisions ADD COLUMN meta TEXT');
}

// 旧库迁移：release_requests 多阶段会签扩展列
// （冻结策略/门禁事件、当前阶段、申请版本号与重新提交关联）
const rqCols = db.prepare('PRAGMA table_info(release_requests)').all().map((c) => c.name);
const rqMigrations = [
  ['policy_snapshot', 'ALTER TABLE release_requests ADD COLUMN policy_snapshot TEXT'],
  ['policy_hash', 'ALTER TABLE release_requests ADD COLUMN policy_hash TEXT'],
  ['current_stage', 'ALTER TABLE release_requests ADD COLUMN current_stage INTEGER NOT NULL DEFAULT 0'],
  ['gate_snapshot', 'ALTER TABLE release_requests ADD COLUMN gate_snapshot TEXT'],
  ['gate_fingerprint', 'ALTER TABLE release_requests ADD COLUMN gate_fingerprint TEXT'],
  ['version_no', 'ALTER TABLE release_requests ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1'],
  ['prev_request_id', 'ALTER TABLE release_requests ADD COLUMN prev_request_id TEXT'],
  ['root_request_id', 'ALTER TABLE release_requests ADD COLUMN root_request_id TEXT'],
];
for (const [col, ddl] of rqMigrations) {
  if (!rqCols.includes(col)) db.exec(ddl);
}

// 旧库迁移：讨论事件插入顺序序号（新建库 DDL 已含）
const deCols = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discussion_events'").get()
  ? db.prepare('PRAGMA table_info(discussion_events)').all().map((c) => c.name)
  : [];
if (deCols.length && !deCols.includes('seq')) {
  db.exec('ALTER TABLE discussion_events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS discussion_event_seq (discussion_id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0)`);
}

module.exports = { db, DATA_DIR };
