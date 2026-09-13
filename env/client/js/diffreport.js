// 版本差异报告：任意两个历史版本 / 发布快照的逐句对比
// 生成（幂等）→ 列表 → 详情（轨道/类型/关键词组合筛选）→ 导出 JSON/CSV → 删除（内容不可再读，审计留痕）
import { api } from './api.js';
import { state } from './state.js';
import { msToSrt } from './time.js';

let ctx = null;
const dr = { revisions: [], releases: [], reports: [], current: null };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dt = (t) => (t ? new Date(t).toLocaleString() : '—');

const TYPE_LABEL = {
  added: '新增', deleted: '删除', track: '跨轨移动',
  time: '时间修改', text: '文本修改', lock: '锁定状态修改', unchanged: '未变化',
};
const TYPE_ORDER = ['added', 'deleted', 'track', 'time', 'text', 'lock', 'unchanged'];

export function initDiffReport(context) {
  ctx = context;
  document.querySelector('.tabs button[data-tab="history"]').addEventListener('click', refreshDiffReports);
  $('#dr-create-btn').addEventListener('click', createReport);
  $('#dr-modal-close').addEventListener('click', () => $('#dr-modal').classList.remove('show'));
  $('#dr-modal-apply').addEventListener('click', () => dr.current && openReport(dr.current.id));
  $('#dr-export-json').addEventListener('click', () => exportReport('json'));
  $('#dr-export-csv').addEventListener('click', () => exportReport('csv'));

  // 生成表单的差异类型勾选（默认勾选除「未变化」外的全部）
  $('#dr-type-checks').innerHTML =
    '<span style="align-self:center">类型：</span>' +
    TYPE_ORDER.map((t) =>
      `<label class="dr-type-checks"><input type="checkbox" class="dr-type-check" value="${t}" ${t !== 'unchanged' ? 'checked' : ''}/> ${TYPE_LABEL[t]}</label>`,
    ).join('');
}

export async function refreshDiffReports() {
  if (!state.project) return;
  const [{ revisions }, { releases }, { reports }] = await Promise.all([
    api.listRevisions(state.project.id),
    api.releaseList(state.project.id),
    api.diffReportList(state.project.id),
  ]);
  dr.revisions = revisions;
  dr.releases = releases;
  dr.reports = reports;
  fillCompareSelects();
  fillTrackFilter();
  renderReportList();
}

/* ==================== 生成表单 ==================== */

function sideOptions() {
  const revOpts = dr.revisions.map((r) =>
    `<option value="rev:${r.id}">版本 ${esc((r.message || r.kind).slice(0, 18))} · ${r.id.slice(0, 8)}</option>`);
  const relOpts = dr.releases.map((r) =>
    `<option value="rel:${r.id}">📦 ${esc(r.label)}${r.status === 'withdrawn' ? '（已撤销）' : ''}</option>`);
  return [...relOpts, ...revOpts];
}

function fillCompareSelects() {
  const opts = sideOptions();
  for (const id of ['#dr-from', '#dr-to']) {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = opts.join('');
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  // 默认：旧 → 新（版本列表按时间倒序，from 取次新、to 取最新）
  const to = $('#dr-to');
  const from = $('#dr-from');
  if (!from.value && to.options.length > 1) from.selectedIndex = Math.min(1, from.options.length - 1);
  if (!to.value && to.options.length) to.selectedIndex = 0;
}

function fillTrackFilter() {
  const sel = $('#dr-filter-track');
  const keep = sel.value;
  const tracks = new Map();
  for (const t of state.snapshot?.tracks || []) if (!tracks.has(t.id)) tracks.set(t.id, t);
  sel.innerHTML = '<option value="">全部轨道</option>' +
    [...tracks.values()].map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function createFilters() {
  const types = [...document.querySelectorAll('.dr-type-check:checked')].map((c) => c.value);
  return {
    trackId: $('#dr-filter-track').value || '',
    types: types.length === TYPE_ORDER.length ? [] : types, // 全选等价于不筛选
    keyword: $('#dr-filter-keyword').value.trim(),
  };
}

async function createReport() {
  const from = $('#dr-from').value;
  const to = $('#dr-to').value;
  if (!from || !to) { ctx.toast('请先选择要对比的两个版本', 'error'); return; }
  if (from === to) { ctx.toast('对比双方是同一个版本，请选择两个不同版本', 'error'); return; }
  const [fromKind, fromRef] = from.split(':');
  const [toKind, toRef] = to.split(':');
  const kindMap = { rev: 'revision', rel: 'release' };
  try {
    const r = await api.diffReportCreate(state.project.id, {
      fromKind: kindMap[fromKind], fromRef,
      toKind: kindMap[toKind], toRef,
      filters: createFilters(),
      author: ctx.getAuthor(),
    });
    ctx.toast(r.deduplicated ? '相同版本对与筛选条件的报告已存在，已复用' : '对比报告已生成', r.deduplicated ? '' : 'ok');
    ctx.refreshAudit?.();
    await refreshDiffReports();
    openReport(r.report.id);
  } catch (e) {
    ctx.toast('生成失败：' + e.message, 'error');
  }
}

/* ==================== 报告列表 ==================== */

function filterText(f) {
  const parts = [];
  if (f.trackId) parts.push(`轨道 ${f.trackId}`);
  if (f.types?.length) parts.push(`类型 ${f.types.map((t) => TYPE_LABEL[t] || t).join('/')}`);
  if (f.keyword) parts.push(`关键词「${f.keyword}」`);
  return parts.length ? parts.join(' · ') : '未筛选（全量）';
}

function renderReportList() {
  const wrap = $('#dr-list');
  if (!dr.reports.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">还没有差异报告。选择两个版本后点击「生成对比报告」。</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const r of dr.reports) {
    const div = document.createElement('div');
    div.className = 'dr-card' + (r.status === 'deleted' ? ' deleted' : '');
    const s = r.summary?.byType || {};
    const badges = TYPE_ORDER.filter((t) => s[t])
      .map((t) => `<span class="dr-type ${t}">${TYPE_LABEL[t]} ${s[t]}</span>`).join('');
    div.innerHTML = `
      <div class="row">
        <b>${esc(r.from_label)}</b><span>→</span><b>${esc(r.to_label)}</b>
        ${r.status === 'deleted' ? '<span class="tag qc-bad">已删除</span>' : ''}
      </div>
      <div class="meta">生成：${esc(r.author)} · ${dt(r.created_at)} · 筛选：${esc(filterText(r.filters))}</div>
      ${r.status === 'deleted'
        ? `<div class="meta">删除：${esc(r.deleted_by || '')} · ${dt(r.deleted_at)} · 内容已不可读取</div>`
        : `<div class="dr-badges">${badges || '<span class="dr-type unchanged">无差异项</span>'}</div>
           <div class="meta">匹配：编号 ${r.summary.matched.byId} 对 · 内容 ${r.summary.matched.byContent} 对 · 句子 ${r.summary.cues.from} → ${r.summary.cues.to}</div>`}
      <div class="row" style="margin-top:6px"></div>`;
    if (r.status !== 'deleted') {
      const actions = div.querySelector('.row:last-child');
      const view = document.createElement('button');
      view.className = 'small-btn primary'; view.textContent = '查看';
      view.addEventListener('click', () => openReport(r.id));
      const expJ = document.createElement('button');
      expJ.className = 'small-btn'; expJ.textContent = '导出 JSON';
      expJ.addEventListener('click', () => exportReport('json', r.id));
      const expC = document.createElement('button');
      expC.className = 'small-btn'; expC.textContent = '导出 CSV';
      expC.addEventListener('click', () => exportReport('csv', r.id));
      const del = document.createElement('button');
      del.className = 'small-btn danger'; del.textContent = '删除…';
      del.addEventListener('click', () => deleteReport(r));
      actions.append(view, expJ, expC, del);
    }
    wrap.appendChild(div);
  }
}

/* ==================== 详情弹窗 ==================== */

async function openReport(reportId) {
  try {
    const sameReport = dr.current?.id === reportId;
    const q = sameReport ? modalFilters() : {};
    const { report } = await api.diffReportGet(reportId, { ...q, author: ctx.getAuthor() });
    dr.current = report;
    renderModal(report, { syncFilters: !sameReport });
    $('#dr-modal').classList.add('show');
    ctx.refreshAudit?.(); // 查看行为已写审计
  } catch (e) {
    ctx.toast('读取报告失败：' + e.message, 'error');
  }
}

function modalFilters() {
  const type = $('#dr-modal-type').value;
  return {
    trackId: $('#dr-modal-track').value || '',
    types: type || '',
    keyword: $('#dr-modal-keyword').value.trim(),
  };
}

function renderModal(report, { syncFilters = false } = {}) {
  $('#dr-modal-title').textContent = `差异报告 ${report.id.slice(0, 10)}`;
  $('#dr-modal-meta').innerHTML = `
    <span>旧：<b>${esc(report.from_label)}</b></span>
    <span>新：<b>${esc(report.to_label)}</b></span>
    <span>生成于 <b>${dt(report.created_at)}</b>（内容已冻结）</span>
    <span>冻结筛选：<b>${esc(filterText(report.frozenFilters))}</b></span>`;

  // 打开另一份报告时，筛选控件同步为该报告的生效筛选（默认即冻结筛选）
  if (syncFilters) {
    $('#dr-modal-type').value = report.effectiveFilters.types[0] || '';
    $('#dr-modal-keyword').value = report.effectiveFilters.keyword || '';
  }
  const trackSel = $('#dr-modal-track');
  const keepTrack = syncFilters ? report.effectiveFilters.trackId : trackSel.value;
  trackSel.innerHTML = '<option value="">全部轨道</option>' +
    report.tracks.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  if (keepTrack && [...trackSel.options].some((o) => o.value === keepTrack)) trackSel.value = keepTrack;

  const items = report.items;
  $('#dr-modal-count').textContent = `当前筛选命中 ${items.length} 项（全量 ${report.summary.total} 项）`;

  const table = $('#dr-table');
  const rows = ['<tr><th>类型</th><th>轨道</th><th>句子</th><th>旧值</th><th>新值</th><th>定位</th></tr>'];
  for (const it of items) {
    rows.push(`<tr>
      <td><span class="dr-type ${it.type}">${TYPE_LABEL[it.type]}</span>${it.matchedBy === 'content' ? `<br/><span class="tag" title="按时间+文本相似度匹配，相似度 ${it.similarity}">内容匹配</span>` : ''}</td>
      <td>${esc(it.trackName)}<br/><span style="color:var(--muted);font-size:10px">${esc(it.trackId)}</span></td>
      <td style="font-family:ui-monospace,monospace;font-size:11px">${esc(it.cueIdFrom || '—')}${it.cueIdTo && it.cueIdTo !== it.cueIdFrom ? `<br/>→ ${esc(it.cueIdTo)}` : ''}</td>
      <td class="dr-old">${esc(valueText(it.type, it.oldValue))}</td>
      <td class="dr-new">${esc(valueText(it.type, it.newValue))}</td>
      <td class="dr-locate">
        ${it.cueIdFrom ? `<button class="small-btn" data-side="from" data-cue="${esc(it.cueIdFrom)}">旧侧</button>` : ''}
        ${it.cueIdTo ? `<button class="small-btn" data-side="to" data-cue="${esc(it.cueIdTo)}">新侧</button>` : ''}
      </td>
    </tr>`);
  }
  table.innerHTML = rows.join('');
  table.querySelectorAll('.dr-locate button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const revId = btn.dataset.side === 'from' ? report.from_rev_id : report.to_rev_id;
      $('#dr-modal').classList.remove('show');
      ctx.locateCue?.(revId, btn.dataset.cue);
    });
  });
}

function valueText(type, v) {
  if (v == null) return '';
  if (type === 'time') return `${msToSrt(v.start)} → ${msToSrt(v.end)}`;
  if (type === 'lock') return v ? '锁定' : '未锁定';
  if (typeof v === 'object') return `[${msToSrt(v.start)} → ${msToSrt(v.end)}] ${v.text || ''}${v.locked ? '（锁定）' : ''}`;
  return String(v);
}

/* ==================== 导出 / 删除 ==================== */

function exportReport(format, reportId = null) {
  const id = reportId || dr.current?.id;
  if (!id) return;
  // 列表直接导出用报告的冻结筛选；详情弹窗导出用当前弹窗筛选
  const q = reportId ? {} : modalFilters();
  const qs = new URLSearchParams({ format, author: ctx.getAuthor() });
  if (q.trackId) qs.set('trackId', q.trackId);
  if (q.types) qs.set('types', q.types);
  if (q.keyword) qs.set('keyword', q.keyword);
  const a = document.createElement('a');
  a.href = `/api/diff-reports/${id}/export?${qs}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  ctx.toast(`已导出 ${format.toUpperCase()}（当前筛选结果）`, 'ok');
  setTimeout(() => ctx.refreshAudit?.(), 600); // 导出审计落库后刷新
}

async function deleteReport(r) {
  if (!confirm(`删除差异报告（${r.from_label} → ${r.to_label}）？\n删除后报告内容不可再读取，操作会写入审计。`)) return;
  try {
    await api.diffReportDelete(r.id, ctx.getAuthor());
    ctx.toast('报告已删除，内容不可再读取', 'ok');
    ctx.refreshAudit?.();
    await refreshDiffReports();
  } catch (e) {
    ctx.toast('删除失败：' + e.message, 'error');
  }
}
