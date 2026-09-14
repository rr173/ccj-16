// 发布回归门禁与变更订阅标签页：
// 订阅增改/暂停/恢复 → 评估事件（运行状态、逐项证据、关联版本、重跑/重试）→ 门禁状态 → 具名豁免
import { api } from './api.js';
import { state } from './state.js';
import { msToSrt } from './time.js';

let ctx = null;
const g = {
  subscriptions: [],
  evaluations: [],
  exemptions: [],
  revisions: [],
  releases: [],
  pollTimer: null,
  editingId: null, // 非空=编辑订阅
  currentEvalId: null,
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dt = (t) => (t ? new Date(t).toLocaleString() : '—');

const DIFF_TYPES = [
  ['added', '新增'], ['deleted', '删除'], ['track', '跨轨移动'],
  ['time', '时间修改'], ['text', '文本修改'], ['lock', '锁定变化'],
];
const SEVERITIES = [['blocker', '阻断'], ['warning', '警告']];
const EVAL_STATUS = {
  queued: { label: '排队中', cls: '' }, running: { label: '运行中', cls: 'qc-warn' },
  done: { label: '完成', cls: 'qc-ok' }, failed: { label: '失败', cls: 'qc-bad' },
};
const TREND = { new: '新增', worsened: '恶化', persisting: '持续', recovered: '恢复' };
const TRIGGER = { commit: '新版本', qc: '质检', 'release-request': '发布申请', manual: '手动' };

export function initGate(context) {
  ctx = context;
  document.querySelector('.tabs button[data-tab="gate"]').addEventListener('click', refreshGateTab);
  $('#gate-new-btn').addEventListener('click', () => openSubModal(null));
  $('#gate-filter-apply').addEventListener('click', loadEvaluations);
  $('#gate-refresh').addEventListener('click', refreshGateTab);
  $('#gate-sub-cancel').addEventListener('click', () => $('#gate-sub-modal').classList.remove('show'));
  $('#gate-sub-save').addEventListener('click', saveSubscription);
  $('#gate-eval-close').addEventListener('click', () => $('#gate-eval-modal').classList.remove('show'));
  $('#gate-detail-apply').addEventListener('click', () => g.currentEvalId && openEval(g.currentEvalId, true));
}

export async function refreshGateTab() {
  if (!state.project) return;
  await Promise.all([loadSubs(), loadEvaluations(), loadExemptions(), loadRefs()]);
}

async function loadRefs() {
  const [{ revisions }, { releases }] = await Promise.all([
    api.listRevisions(state.project.id),
    api.releaseList(state.project.id),
  ]);
  g.revisions = revisions;
  g.releases = releases;
}

/* ==================== 订阅 ==================== */

async function loadSubs() {
  const { subscriptions } = await api.gateSubList(state.project.id);
  g.subscriptions = subscriptions;
  const sel = $('#gate-filter-sub');
  const keep = sel.value;
  sel.innerHTML = '<option value="">全部订阅</option>' + subscriptions.map((s) =>
    `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  if (keep) sel.value = keep;
  renderSubs();
}

function renderSubs() {
  const wrap = $('#gate-subs');
  if (!g.subscriptions.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">还没有门禁订阅。点击「新建订阅」选择基线版本/发布快照与关注条件。</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const s of g.subscriptions) {
    const div = document.createElement('div');
    div.className = 'dr-card gate-sub' + (s.status === 'paused' ? ' paused' : '');
    const cond = [
      s.track_ids.length ? `轨道 ${s.track_ids.length} 个` : '全部轨道',
      s.diff_types.length ? s.diff_types.map((t) => ({ added: '新增', deleted: '删除', track: '跨轨', time: '时间', text: '文本', lock: '锁定' }[t])).join('/') : '全部差异',
      s.keyword ? `关键词「${s.keyword}」` : null,
      '质检 ' + s.qc_severities.map((x) => (x === 'blocker' ? '阻断' : '警告')).join('/'),
    ].filter(Boolean).join(' · ');
    div.innerHTML = `
      <div class="row">
        <b>${esc(s.name)}</b>
        <span class="tag ${s.status === 'active' ? 'qc-ok' : 'qc-warn'}">${s.status === 'active' ? '运行中' : '已暂停'}</span>
        <span style="flex:1"></span>
        <span class="meta">${esc(s.baseline_label)}</span>
      </div>
      <div class="meta">${esc(cond)}</div>
      <div class="meta">创建 ${esc(s.created_by)} · ${dt(s.created_at)}${s.updated_by ? ` · 修改 ${esc(s.updated_by)} · ${dt(s.updated_at)}` : ''}</div>
      <div class="row" style="margin-top:6px;gap:6px;flex-wrap:wrap">
        <button class="small-btn" data-act="evals">事件</button>
        <button class="small-btn" data-act="edit">编辑</button>
        ${s.status === 'active'
          ? '<button class="small-btn" data-act="pause">暂停</button>'
          : '<button class="small-btn primary" data-act="resume">恢复</button>'}
      </div>`;
    div.querySelector('[data-act=evals]').addEventListener('click', () => {
      $('#gate-filter-sub').value = s.id;
      loadEvaluations();
    });
    div.querySelector('[data-act=edit]').addEventListener('click', () => openSubModal(s));
    div.querySelector('[data-act=pause]')?.addEventListener('click', () => setPaused(s, true));
    div.querySelector('[data-act=resume]')?.addEventListener('click', () => setPaused(s, false));
    wrap.appendChild(div);
  }
}

async function setPaused(sub, paused) {
  try {
    const fn = paused ? api.gateSubPause : api.gateSubResume;
    await fn(state.project.id, sub.id, ctx.getAuthor());
    ctx.toast(paused ? '订阅已暂停（不再随提交自动评估）' : '订阅已恢复并对最新 HEAD 评估', 'ok');
    await refreshGateTab();
    ctx.refreshAudit?.();
  } catch (e) { ctx.toast('操作失败：' + e.message, 'error'); }
}

function baselineOptions() {
  const rels = g.releases.map((r) =>
    `<option value="rel:${r.id}">📦 ${esc(r.label)}${r.status === 'withdrawn' ? '（已撤销）' : ''}</option>`);
  const revs = g.revisions.map((r) =>
    `<option value="rev:${r.id}">版本 ${esc((r.message || r.kind).slice(0, 20))} · ${r.id.slice(0, 8)}</option>`);
  return rels.join('') + revs.join('');
}

async function openSubModal(sub) {
  g.editingId = sub ? sub.id : null;
  if (!g.revisions.length) await loadRefs();
  $('#gate-sub-title').textContent = sub ? '编辑门禁订阅' : '新建门禁订阅';
  $('#gate-sub-name').value = sub?.name || '';
  const baselineSel = $('#gate-sub-baseline');
  baselineSel.innerHTML = baselineOptions();
  if (sub) {
    const v = `${sub.baseline_kind === 'release' ? 'rel' : 'rev'}:${sub.baseline_ref}`;
    if ([...baselineSel.options].some((o) => o.value === v)) baselineSel.value = v;
  }
  const tracks = state.snapshot?.tracks || [];
  $('#gate-sub-tracks').innerHTML =
    `<label><input type="checkbox" class="gs-track" value="" checked ${sub ? 'disabled' : ''}/> 全部轨道</label>` +
    tracks.map((t) =>
      `<label><input type="checkbox" class="gs-track" value="${esc(t.id)}" ${sub?.track_ids.includes(t.id) ? 'checked' : ''}/> ${esc(t.name)}</label>`).join('');
  $('#gate-sub-types').innerHTML = DIFF_TYPES.map(([v, label]) =>
    `<label><input type="checkbox" class="gs-type" value="${v}" ${!sub || sub.diff_types.includes(v) ? 'checked' : ''}/> ${label}</label>`).join('');
  $('#gate-sub-sev').innerHTML = SEVERITIES.map(([v, label]) =>
    `<label><input type="checkbox" class="gs-sev" value="${v}" ${(sub?.qc_severities || ['blocker']).includes(v) ? 'checked' : ''}/> ${label}</label>`).join('');
  $('#gate-sub-keyword').value = sub?.keyword || '';
  $('#gate-sub-modal').classList.add('show');
}

async function saveSubscription() {
  const name = $('#gate-sub-name').value.trim();
  if (!name) return ctx.toast('请填写订阅名称', 'error');
  const [bk, ref] = $('#gate-sub-baseline').value.split(':');
  const allTracks = $('#gate-sub-tracks .gs-track[value=""]').checked;
  const trackIds = allTracks ? [] : [...document.querySelectorAll('.gs-track:checked')].map((c) => c.value).filter(Boolean);
  const allTypes = [...document.querySelectorAll('.gs-type')].every((c) => c.checked);
  const diffTypes = allTypes ? [] : [...document.querySelectorAll('.gs-type:checked')].map((c) => c.value);
  const qcSeverities = [...document.querySelectorAll('.gs-sev:checked')].map((c) => c.value);
  const payload = {
    name,
    baselineKind: bk === 'rel' ? 'release' : 'revision',
    baselineRef: ref,
    trackIds, diffTypes, qcSeverities,
    keyword: $('#gate-sub-keyword').value.trim(),
    author: ctx.getAuthor(),
  };
  try {
    if (g.editingId) {
      await api.gateSubUpdate(state.project.id, g.editingId, payload);
      ctx.toast('订阅已修改并对最新 HEAD 重新评估', 'ok');
    } else {
      await api.gateSubCreate(state.project.id, payload);
      ctx.toast('订阅已创建，正在评估当前 HEAD', 'ok');
    }
    $('#gate-sub-modal').classList.remove('show');
    ctx.refreshAudit?.();
    await refreshGateTab();
  } catch (e) {
    ctx.toast('保存失败：' + e.message, 'error');
  }
}

/* ==================== 评估事件 ==================== */

async function loadEvaluations() {
  const q = {
    subscriptionId: $('#gate-filter-sub').value,
    status: $('#gate-filter-status').value,
    gateHit: $('#gate-filter-hit').value,
    trigger: $('#gate-filter-trigger').value,
  };
  const { evaluations } = await api.gateEvalList(state.project.id, q);
  g.evaluations = evaluations;
  renderEvaluations();
  clearTimeout(g.pollTimer);
  if (evaluations.some((e) => ['queued', 'running'].includes(e.status))) {
    g.pollTimer = setTimeout(loadEvaluations, 900);
  }
}

function renderEvaluations() {
  const wrap = $('#gate-evals');
  if (!g.evaluations.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">当前筛选下没有评估事件。</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const e of g.evaluations) {
    const sub = g.subscriptions.find((s) => s.id === e.subscription_id);
    const st = EVAL_STATUS[e.status] || { label: e.status, cls: '' };
    const c = e.summary?.counts;
    const div = document.createElement('div');
    div.className = 'dr-card gate-eval' + (e.gate_hit ? ' hit' : '');
    div.innerHTML = `
      <div class="row">
        <b>${esc(e.event_no)}</b>
        <span class="tag ${st.cls}">${st.label}</span>
        ${e.gate_hit ? '<span class="tag qc-bad">门禁命中</span>' : '<span class="tag qc-ok">门禁通过</span>'}
        ${e.deduplicated ? '<span class="tag">结果重复(未重复通知)</span>' : ''}
        <span style="flex:1"></span>
        <span class="meta">${esc(sub?.name || e.subscription_id.slice(0, 8))}</span>
      </div>
      <div class="meta">触发：${TRIGGER[e.trigger] || e.trigger} · 关联版本 <code>${esc(e.target_revision_id.slice(0, 10))}</code> · ${esc(e.triggered_by)} · ${dt(e.created_at)}</div>
      ${c ? `<div class="meta">新增 ${c.new} · 恶化 ${c.worsened} · 持续 ${c.persisting} · 恢复 ${c.recovered} · 新质检问题 ${c.qcNew}</div>` : ''}
      ${e.error ? `<div class="rel-item bad" style="margin-top:5px">失败原因：${esc(e.error)}（第 ${e.attempts} 次）</div>` : ''}
      <div class="row" style="margin-top:6px;gap:6px;flex-wrap:wrap">
        <button class="small-btn primary" data-act="view">查看证据</button>
        ${e.status === 'failed' ? '<button class="small-btn" data-act="retry">重试</button>' : ''}
        <button class="small-btn" data-act="rerun">重跑</button>
      </div>`;
    div.querySelector('[data-act=view]').addEventListener('click', () => openEval(e.id));
    div.querySelector('[data-act=retry]')?.addEventListener('click', () => retryEval(e));
    div.querySelector('[data-act=rerun]').addEventListener('click', () => rerunEval(e));
    wrap.appendChild(div);
  }
}

async function retryEval(e) {
  try {
    await api.gateEvalRetry(state.project.id, e.id, ctx.getAuthor());
    ctx.toast('已重新排队（复用事件编号）', 'ok');
    loadEvaluations();
  } catch (er) { ctx.toast('重试失败：' + er.message, 'error'); }
}

async function rerunEval(e) {
  try {
    const r = await api.gateEvalRerun(state.project.id, e.id, ctx.getAuthor());
    ctx.toast(r.deduplicated ? '该事件正在运行，已复用' : '已生成新的评估事件', r.deduplicated ? '' : 'ok');
    loadEvaluations();
  } catch (er) { ctx.toast('重跑失败：' + er.message, 'error'); }
}

/* ==================== 评估详情（逐项证据） ==================== */

async function openEval(evalId, keepFilters = false) {
  const q = {};
  if (keepFilters) {
    q.trend = $('#gate-detail-trend').value;
    q.kind = $('#gate-detail-kind').value;
    q.keyword = $('#gate-detail-keyword').value.trim();
  }
  try {
    const { evaluation, subscription, exemption } = await api.gateEvalGet(state.project.id, evalId, q);
    g.currentEvalId = evalId;
    renderEvalModal(evaluation, subscription, exemption, keepFilters);
    $('#gate-eval-modal').classList.add('show');
  } catch (e) { ctx.toast('读取评估详情失败：' + e.message, 'error'); }
}

function renderEvalModal(ev, sub, exemption, keepFilters) {
  $('#gate-eval-title').textContent = `评估事件 ${ev.event_no}`;
  $('#gate-eval-meta').innerHTML = `
    <span>订阅：<b>${esc(sub.name)}</b></span>
    <span>状态：<b>${EVAL_STATUS[ev.status]?.label || ev.status}</b></span>
    <span>触发：<b>${TRIGGER[ev.trigger] || ev.trigger}</b></span>
    <span>关联版本：<code>${esc(ev.target_revision_id)}</code></span>
    <span>基线：<b>${esc(ev.baseline_label)}</b></span>
    <span>${dt(ev.finished_at || ev.started_at || ev.created_at)}</span>`;

  const gateBox = $('#gate-eval-gate');
  if (ev.gate_hit) {
    gateBox.innerHTML = `<div class="rel-gate bad">✗ 命中发布回归门禁：新增/恶化差异 ${(ev.summary?.counts?.new || 0) + (ev.summary?.counts?.worsened || 0)} 项，
      新质检问题 ${ev.summary?.counts?.qcNew || 0} 项。基于该版本的发布申请/快照将被服务端阻止，直至审核人对<b>本事件+本版本</b>创建具名豁免。</div>`;
    if (exemption) {
      gateBox.innerHTML += `<div class="rel-gate ok">✓ 已有豁免「${esc(exemption.name)}」：${esc(exemption.reason)}（${esc(exemption.reviewer)} · ${dt(exemption.created_at)}）——仅对本事件与版本有效。</div>`;
    } else {
      gateBox.innerHTML += '<div class="new-row"><button class="small-btn primary" id="gate-exempt-btn">审核人创建具名豁免…</button></div>';
      $('#gate-exempt-btn').addEventListener('click', () => createExemption(ev));
    }
  } else {
    gateBox.innerHTML = '<div class="rel-gate ok">✓ 未命中门禁</div>';
  }
  if (ev.error) gateBox.innerHTML += `<div class="rel-item bad">失败原因：${esc(ev.error)}（第 ${ev.attempts} 次）</div>`;

  if (!keepFilters) {
    $('#gate-detail-trend').value = '';
    $('#gate-detail-kind').value = '';
    $('#gate-detail-keyword').value = '';
  }
  $('#gate-detail-count').textContent = `当前 ${ev.filteredCount} / 全量 ${ev.itemCount ?? (ev.items || []).length} 项`;

  const rows = ['<tr><th>类别</th><th>趋势</th><th>轨道/规则</th><th>句子</th><th>证据与旧值→新值</th><th>定位</th></tr>'];
  for (const it of ev.items || []) {
    rows.push(`<tr>
      <td>${it.kind === 'qc'
        ? `<span class="tag ${it.severityQc === 'blocker' ? 'qc-bad' : 'qc-warn'}">质检·${it.severityQc === 'blocker' ? '阻断' : '警告'}</span>`
        : '<span class="tag">差异</span>'}</td>
      <td><span class="gate-trend ${it.trend}">${TREND[it.trend] || it.trend}</span></td>
      <td>${esc(it.trackName || it.trackId || '')}${it.ruleKey ? `<br/><span class="meta">${esc(it.ruleKey)}</span>` : ''}</td>
      <td style="font-family:ui-monospace,monospace;font-size:11px">${esc(it.cueIdFrom || '')}${it.cueIdTo && it.cueIdTo !== it.cueIdFrom ? '<br/>→ ' + esc(it.cueIdTo) : ''}${it.cueId ? '<br/>' + esc(it.cueId) : ''}</td>
      <td class="dr-old">${esc(itemText(it))}</td>
      <td class="dr-locate">${locateButtons(ev, it)}</td>
    </tr>`);
  }
  $('#gate-eval-table').innerHTML = rows.join('');
  $('#gate-eval-table').querySelectorAll('[data-side]').forEach((b) => {
    b.addEventListener('click', () => {
      $('#gate-eval-modal').classList.remove('show');
      window.appHandlers.locateCue?.(b.dataset.rev, b.dataset.cue);
    });
  });
}

function itemText(it) {
  if (it.kind === 'qc') {
    return `${it.evidence}\n状态：${it.status} · 实际 ${it.actual?.value ?? ''}${it.actual?.unit || ''} / 限制 ${it.actual?.limit ?? ''}${it.actual?.unit || ''}`;
  }
  const oldVal = formatVal(it.type, it.oldValue);
  const newVal = formatVal(it.type, it.newValue);
  return `${it.evidence}\n旧：${oldVal}\n新：${newVal}`;
}
function formatVal(type, v) {
  if (v == null) return '—';
  if (type === 'time') return `${msToSrt(v.start)} → ${msToSrt(v.end)}`;
  if (type === 'lock') return v ? '锁定' : '未锁定';
  if (typeof v === 'object') return `[${msToSrt(v.start)} → ${msToSrt(v.end)}] ${v.text || ''}${v.locked ? '（锁定）' : ''}`;
  return String(v);
}
function locateButtons(ev, it) {
  const out = [];
  if (it.kind === 'qc') {
    out.push(`<button class="small-btn" data-side="to" data-rev="${esc(ev.target_revision_id)}" data-cue="${esc(it.cueId)}">目标版本</button>`);
  } else {
    if (it.cueIdFrom) out.push(`<button class="small-btn" data-side="from" data-rev="${esc(ev.baseline_rev_id)}" data-cue="${esc(it.cueIdFrom)}">基线侧</button>`);
    if (it.cueIdTo) out.push(`<button class="small-btn" data-side="to" data-rev="${esc(ev.target_revision_id)}" data-cue="${esc(it.cueIdTo)}">目标侧</button>`);
  }
  return out.join(' ');
}

/* ==================== 豁免 ==================== */

async function createExemption(ev) {
  const name = prompt(`为事件 ${ev.event_no} 创建具名豁免（名称/审核具名）：`, '');
  if (name == null) return;
  if (!name.trim()) return ctx.toast('豁免必须具名', 'error');
  const reason = prompt('豁免理由（必填，写入审计；仅对本事件与版本有效，新版本需重新评估）：', '');
  if (reason == null) return;
  if (!reason.trim()) return ctx.toast('豁免必须填写理由', 'error');
  try {
    await api.gateExCreate(state.project.id, ev.id, { name: name.trim(), reason: reason.trim(), author: ctx.getAuthor() });
    ctx.toast('豁免已创建，该版本可继续发布流程', 'ok');
    ctx.refreshAudit?.();
    await Promise.all([loadExemptions(), openEval(ev.id, true)]);
  } catch (e) { ctx.toast('创建豁免失败：' + e.message, 'error'); }
}

async function loadExemptions() {
  const { exemptions } = await api.gateExList(state.project.id);
  g.exemptions = exemptions;
  const wrap = $('#gate-exemptions');
  if (!exemptions.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">还没有豁免记录。</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const x of exemptions) {
    const ev = g.evaluations.find((e) => e.id === x.event_id);
    const div = document.createElement('div');
    div.className = 'rel-card' + (x.revoked_at ? ' withdrawn' : '');
    div.innerHTML = `
      <div class="row">
        <b>${esc(x.name)}</b>
        ${x.revoked_at ? '<span class="tag qc-bad">已撤销</span>' : '<span class="tag qc-ok">有效</span>'}
        <span style="flex:1"></span>
        <span class="meta">事件 ${esc(ev?.event_no || x.event_id.slice(0, 10))}</span>
      </div>
      <div class="meta">版本 <code>${esc(x.revision_id.slice(0, 10))}</code> · 审核人 ${esc(x.reviewer)} · ${dt(x.created_at)}</div>
      <div class="meta">理由：${esc(x.reason)}</div>
      ${x.revoked_at ? `<div class="meta">撤销：${esc(x.revoked_by)} · ${dt(x.revoked_at)} · ${esc(x.revoke_reason)}</div>` : ''}
      <div class="row" style="margin-top:6px">
        ${!x.revoked_at ? '<button class="small-btn danger" data-act="revoke">撤销豁免…</button>' : ''}
        <button class="small-btn" data-act="ev">查看事件</button>
      </div>`;
    div.querySelector('[data-act=revoke]')?.addEventListener('click', () => revokeExemption(x));
    div.querySelector('[data-act=ev]').addEventListener('click', () => openEval(x.event_id));
    wrap.appendChild(div);
  }
}

async function revokeExemption(x) {
  const reason = prompt(`撤销豁免「${x.name}」的理由（必填，撤销后该版本重新被门禁拦截）：`, '');
  if (!reason || !reason.trim()) return;
  try {
    await api.gateExRevoke(x.id, { reason: reason.trim(), author: ctx.getAuthor() });
    ctx.toast('豁免已撤销', 'ok');
    ctx.refreshAudit?.();
    await refreshGateTab();
  } catch (e) { ctx.toast('撤销失败：' + e.message, 'error'); }
}
