'use strict';
/**
 * 版本差异报告：数据层。
 *
 * - 生成报告时冻结比较双方的快照内容与生成时间，报告自包含、此后项目继续编辑不影响结果；
 *   对比双方可以是任意历史版本（revision）或发布快照（release，冻结内容取其发布快照）。
 * - 幂等：同一项目 + 同一对版本 + 同一组筛选条件命中唯一索引，重复生成返回同一报告，
 *   不产生重复记录。
 * - 报告保存全量差异项；筛选（轨道/差异类型/关键词，可组合）在读取与导出时应用，
 *   筛选参数非法返回 400。
 * - 导出支持 json / csv，其他格式返回 400。
 * - 删除为软删除并清空内容：内容不可再读取（410），但创建/查看/导出/删除均留审计。
 */
const crypto = require('crypto');
const { db } = require('../db');
const store = require('../store');
const qc = require('../qc/store');
const { DIFF_TYPES, computeDiff } = require('./match');

const now = () => Date.now();
const drid = () => 'dr_' + crypto.randomBytes(9).toString('hex');
const httpError = store.httpError;

const TYPE_LABEL = {
  added: '新增', deleted: '删除', track: '跨轨移动',
  time: '时间修改', text: '文本修改', lock: '锁定状态修改', unchanged: '未变化',
};

/* ================================ 筛选参数 ================================ */

/**
 * 规范化筛选条件；非法参数抛 400。
 * 接受对象（POST body）或查询串形式（types 逗号分隔）。
 */
function normalizeFilters(raw) {
  if (raw == null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, '筛选参数非法：应为对象');
  const out = { trackId: '', types: [], keyword: '' };

  if (raw.trackId != null && raw.trackId !== '') {
    if (typeof raw.trackId !== 'string' || raw.trackId.length > 120) {
      throw httpError(400, '筛选参数非法：trackId 应为不超过 120 字的字符串');
    }
    out.trackId = raw.trackId;
  }

  if (raw.types != null && raw.types !== '') {
    let arr = raw.types;
    if (typeof arr === 'string') arr = arr.split(',').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(arr)) throw httpError(400, '筛选参数非法：types 应为差异类型数组');
    for (const t of arr) {
      if (!DIFF_TYPES.includes(t)) {
        throw httpError(400, `筛选参数非法：未知差异类型「${t}」（可选：${DIFF_TYPES.join('/')}）`);
      }
    }
    out.types = [...new Set(arr)].sort(); // 排序去重，保证指纹稳定
  }

  if (raw.keyword != null && raw.keyword !== '') {
    if (typeof raw.keyword !== 'string' || raw.keyword.length > 200) {
      throw httpError(400, '筛选参数非法：keyword 应为不超过 200 字的字符串');
    }
    out.keyword = raw.keyword.trim();
  }
  return out;
}

const filtersHash = (filters) => crypto.createHash('sha1').update(JSON.stringify(filters)).digest('hex').slice(0, 16);
const pairHash = (fromKind, fromRef, toKind, toRef) =>
  crypto.createHash('sha1').update(JSON.stringify([fromKind, fromRef, toKind, toRef])).digest('hex').slice(0, 16);

function valueSearchText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return [v.text, v.trackId, v.start, v.end, v.locked].filter((x) => x != null).join(' ');
  return String(v);
}

function applyFilters(items, filters) {
  const kw = filters.keyword ? filters.keyword.toLowerCase() : '';
  return items.filter((it) => {
    if (filters.trackId && it.trackId !== filters.trackId && it.trackIdFrom !== filters.trackId) return false;
    if (filters.types.length && !filters.types.includes(it.type)) return false;
    if (kw) {
      const hay = [it.cueIdFrom, it.cueIdTo, it.trackName, valueSearchText(it.oldValue), valueSearchText(it.newValue)]
        .join('\n').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
}

/* ================================ 对比双方解析 ================================ */

function resolveSide(projectId, kind, ref) {
  if (kind === 'revision') {
    const rev = store.getRevision(ref);
    if (!rev) throw httpError(404, `版本不存在：${ref}`);
    if (rev.project_id !== projectId) throw httpError(400, '两个版本属于不同项目，不能生成对比报告');
    return {
      kind, ref, revId: rev.id,
      label: `版本 ${rev.id.slice(0, 10)}（${(rev.message || rev.kind).slice(0, 30)}）`,
      snapshot: rev.snapshot,
    };
  }
  if (kind === 'release') {
    const rel = qc.getRelease(ref);
    if (!rel) throw httpError(404, `发布快照不存在：${ref}`);
    if (rel.project_id !== projectId) throw httpError(400, '两个版本属于不同项目，不能生成对比报告');
    return {
      kind, ref, revId: rel.revision_id, // 定位链接落到快照的来源版本
      label: `${rel.label}（发布快照）`,
      snapshot: rel.snapshot,
    };
  }
  throw httpError(400, '对比类型应为 revision 或 release');
}

/* ================================ 报告生成（幂等） ================================ */

// 只回传元信息：冻结内容与差异项不随列表/元信息接口外泄（删除后更是不可读）
function parseReport(row) {
  if (!row) return null;
  const out = {
    ...row,
    filters: JSON.parse(row.filters),
    summary: JSON.parse(row.summary),
  };
  delete out.items;
  delete out.from_snapshot;
  delete out.to_snapshot;
  return out;
}

/**
 * 生成报告。同一项目 + 同一对版本 + 同一组筛选条件重复生成时返回已有报告（deduplicated）。
 */
function createReport(projectId, { fromKind, fromRef, toKind, toRef, filters: rawFilters, author }) {
  const project = store.getProject(projectId);
  if (!project) throw httpError(404, '项目不存在');
  const filters = normalizeFilters(rawFilters);
  if (!fromRef || !toRef) throw httpError(400, '缺少对比版本（fromRef / toRef）');
  if (fromKind === toKind && fromRef === toRef) throw httpError(400, '对比双方是同一个版本，请选择两个不同版本');

  const from = resolveSide(projectId, String(fromKind || ''), String(fromRef));
  const to = resolveSide(projectId, String(toKind || ''), String(toRef));

  const pHash = pairHash(from.kind, from.ref, to.kind, to.ref);
  const fHash = filtersHash(filters);
  const existing = db
    .prepare(`SELECT * FROM diff_reports WHERE project_id=? AND pair_hash=? AND filter_hash=? AND status='active'`)
    .get(projectId, pHash, fHash);
  if (existing) return { report: parseReport(existing), deduplicated: true };

  // 冻结：比较双方内容 + 生成时间随报告保存，之后项目继续编辑不影响本报告
  const { items, summary } = computeDiff(from.snapshot, to.snapshot);
  const id = drid();
  const t = now();
  const row = {
    id,
    project_id: projectId,
    from_kind: from.kind, from_ref: from.ref, from_label: from.label, from_rev_id: from.revId,
    to_kind: to.kind, to_ref: to.ref, to_label: to.label, to_rev_id: to.revId,
    filters: JSON.stringify(filters),
    filter_hash: fHash,
    pair_hash: pHash,
    from_snapshot: JSON.stringify(from.snapshot),
    to_snapshot: JSON.stringify(to.snapshot),
    items: JSON.stringify(items),
    summary: JSON.stringify(summary),
    author,
    created_at: t,
  };
  try {
    db.prepare(
      `INSERT INTO diff_reports
         (id, project_id, from_kind, from_ref, from_label, from_rev_id, to_kind, to_ref, to_label, to_rev_id,
          filters, filter_hash, pair_hash, from_snapshot, to_snapshot, items, summary, status, author, created_at)
       VALUES
         (@id, @project_id, @from_kind, @from_ref, @from_label, @from_rev_id, @to_kind, @to_ref, @to_label, @to_rev_id,
          @filters, @filter_hash, @pair_hash, @from_snapshot, @to_snapshot, @items, @summary, 'active', @author, @created_at)`,
    ).run(row);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      // 并发重复生成：返回已存在的同一报告
      const dup = db
        .prepare(`SELECT * FROM diff_reports WHERE project_id=? AND pair_hash=? AND filter_hash=? AND status='active'`)
        .get(projectId, pHash, fHash);
      if (dup) return { report: parseReport(dup), deduplicated: true };
    }
    throw e;
  }

  store.writeAudit(projectId, project.head_id, [
    {
      field: `diffreport:${id}`, action: 'diff-create', oldValue: null,
      newValue: JSON.stringify({
        from: from.label, to: to.label, filters,
        items: summary.total, matchedByContent: summary.matched.byContent,
      }),
    },
  ], author);
  return { report: parseReport(db.prepare('SELECT * FROM diff_reports WHERE id=?').get(id)), deduplicated: false };
}

/* ================================ 读取 / 详情 ================================ */

function listReports(projectId) {
  return db
    .prepare('SELECT * FROM diff_reports WHERE project_id = ? ORDER BY created_at DESC, id DESC')
    .all(projectId)
    .map((r) => parseReport(r));
}

function getActiveReport(reportId) {
  const row = db.prepare('SELECT * FROM diff_reports WHERE id = ?').get(reportId);
  if (!row) throw httpError(404, '差异报告不存在');
  if (row.status !== 'active') throw httpError(410, '报告已删除，内容不可再读取');
  return row;
}

/**
 * 报告详情：应用筛选（查询参数覆盖冻结筛选），写「查看」审计。
 */
function getReport(reportId, { filterOverrides, author } = {}) {
  const row = getActiveReport(reportId);
  const frozen = JSON.parse(row.filters);
  const effective = filterOverrides ? normalizeFilters(filterOverrides) : frozen;
  const items = applyFilters(JSON.parse(row.items), effective);
  const report = parseReport(row);
  report.items = items;
  report.effectiveFilters = effective;
  report.frozenFilters = frozen;
  // 供前端筛选下拉：双方轨道的并集
  const tracks = new Map();
  for (const snap of [JSON.parse(row.from_snapshot), JSON.parse(row.to_snapshot)]) {
    for (const t of snap.tracks || []) if (!tracks.has(t.id)) tracks.set(t.id, { id: t.id, name: t.name, color: t.color });
  }
  report.tracks = [...tracks.values()];

  store.writeAudit(row.project_id, store.getProject(row.project_id).head_id, [
    {
      field: `diffreport:${reportId}`, action: 'diff-view', oldValue: null,
      newValue: JSON.stringify({ filters: effective, items: items.length }),
    },
  ], author || '匿名');
  return { report };
}

/* ================================ 导出 ================================ */

function fmtTime(ms) {
  ms = Math.max(0, Math.round(Number(ms) || 0));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

function valueText(type, v) {
  if (v == null) return '';
  if (type === 'time') return `${fmtTime(v.start)} → ${fmtTime(v.end)}`;
  if (type === 'lock') return v ? '锁定' : '未锁定';
  if (typeof v === 'object') {
    return `[${fmtTime(v.start)} → ${fmtTime(v.end)}] ${v.text || ''}${v.locked ? '（锁定）' : ''}`;
  }
  return String(v);
}

function csvCell(s) {
  s = String(s ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(items) {
  const head = ['差异类型', '轨道', '轨道名', '句子(旧)', '句子(新)', '旧值', '新值', '匹配方式', '相似度'];
  const lines = [head.map(csvCell).join(',')];
  for (const it of items) {
    lines.push([
      TYPE_LABEL[it.type] || it.type,
      it.trackId,
      it.trackName,
      it.cueIdFrom || '',
      it.cueIdTo || '',
      valueText(it.type, it.oldValue),
      valueText(it.type, it.newValue),
      it.matchedBy === 'content' ? '内容匹配' : it.matchedBy === 'id' ? '编号匹配' : '',
      it.similarity == null ? '' : String(it.similarity),
    ].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM 便于 Excel 识别 UTF-8
}

/**
 * 导出当前筛选结果。format 仅支持 json / csv，其他返回 400。写「导出」审计。
 */
function exportReport(reportId, { format, filterOverrides, author } = {}) {
  const row = getActiveReport(reportId);
  const fmt = String(format || '').toLowerCase();
  if (!['json', 'csv'].includes(fmt)) {
    throw httpError(400, `导出格式不支持：「${format || ''}」（支持 json / csv）`);
  }
  const effective = filterOverrides ? normalizeFilters(filterOverrides) : JSON.parse(row.filters);
  const items = applyFilters(JSON.parse(row.items), effective);
  const meta = parseReport(row);

  store.writeAudit(row.project_id, store.getProject(row.project_id).head_id, [
    {
      field: `diffreport:${reportId}`, action: 'diff-export', oldValue: null,
      newValue: JSON.stringify({ format: fmt, filters: effective, items: items.length }),
    },
  ], author || '匿名');

  const filename = `diffreport_${reportId.slice(0, 10)}.${fmt}`;
  if (fmt === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      filename,
      content: JSON.stringify({
        report: { ...meta, effectiveFilters: effective },
        exportedAt: new Date().toISOString(),
        items,
      }, null, 2),
    };
  }
  return { contentType: 'text/csv; charset=utf-8', filename, content: toCsv(items) };
}

/* ================================ 删除（软删除，内容不可再读） ================================ */

function deleteReport(reportId, author) {
  const row = db.prepare('SELECT * FROM diff_reports WHERE id = ?').get(reportId);
  if (!row) throw httpError(404, '差异报告不存在');
  if (row.status !== 'active') throw httpError(400, '报告已删除，不能重复删除');
  const t = now();
  // 清空冻结内容：删除后任何接口都读不到报告内容；行保留用于审计追溯
  db.prepare(
    `UPDATE diff_reports SET status='deleted', deleted_by=?, deleted_at=?,
       items='[]', from_snapshot='null', to_snapshot='null'
     WHERE id=? AND status='active'`,
  ).run(author, t, reportId);
  store.writeAudit(row.project_id, store.getProject(row.project_id).head_id, [
    {
      field: `diffreport:${reportId}`, action: 'diff-delete',
      oldValue: JSON.stringify({ from: row.from_label, to: row.to_label }),
      newValue: 'deleted',
    },
  ], author);
  return { deleted: true, id: reportId };
}

module.exports = {
  TYPE_LABEL,
  normalizeFilters,
  applyFilters,
  toCsv,
  createReport,
  listReports,
  getReport,
  exportReport,
  deleteReport,
};
