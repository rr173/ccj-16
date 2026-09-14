// 讨论串标签页与弹窗：
// 创建（单句 / 时间范围）→ 回复 / 解决 / 重新打开 → 待重新定位（候选句、手动选句、改挂时间范围）
// → 跳到对应时间 → 状态变化与定位历史时间线。
// 写操作携带 expectedVersion（乐观锁）与 clientToken（重复请求不产生重复回复）。
import { api } from './api.js';
import { state } from './state.js';
import { seek } from './player.js';
import { msToSrt, parseTime, uid } from './time.js';

let ctx = null;
const g = {
  threads: [],
  summary: { total: 0, unresolved: 0, resolved: 0, orphan: 0, unresolvedOrphan: 0 },
  filter: { status: '', anchorStatus: '', q: '' },
  openId: null,
  detail: null,
  pollTimer: null,
  // 创建弹窗上下文
  create: null, // { mode: 'cue'|'range', cueId?, start?, end?, trackId? }
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dt = (t) => (t ? new Date(t).toLocaleString() : '—');

const REASON_LABEL = {
  deleted: '对应字幕已删除',
  split: '对应内容被拆分为多句，无法唯一对应',
  ambiguous: '存在相似句子，无法唯一匹配',
  'track-deleted': '时间范围所在轨道已删除',
};
const EVENT_LABEL = {
  create: '创建讨论',
  message: '回复',
  resolve: '解决',
  reopen: '重新打开',
  relocate: '人工重新定位',
  'auto-follow': '提交后自动跟随',
  orphan: '进入待重新定位',
};

export function initDiscussion(context) {
  ctx = context;
  document.querySelector('.tabs button[data-tab="disc"]').addEventListener('click', refreshTab);
  $('#disc-refresh').addEventListener('click', refreshTab);
  $('#disc-filter-apply').addEventListener('click', async () => {
    g.filter = {
      status: $('#disc-filter-status').value,
      anchorStatus: $('#disc-filter-anchor').value,
      q: $('#disc-filter-q').value.trim(),
    };
    await loadList();
  });
  $('#disc-new-range').addEventListener('click', () => {
    const t = Math.round(state.player.time || 0);
    openCreate({ mode: 'range', start: t, end: Math.min(state.snapshot.duration, t + 2000), trackId: '' });
  });

  // 创建弹窗
  $('#disc-create-cancel').addEventListener('click', () => $('#disc-create-modal').classList.remove('show'));
  $('#disc-create-submit').addEventListener('click', submitCreate);

  // 详情弹窗
  $('#disc-modal-close').addEventListener('click', () => { $('#disc-modal').classList.remove('show'); g.openId = null; });
  $('#disc-send').addEventListener('click', submitReply);
  $('#disc-resolve').addEventListener('click', () => changeStatus('resolve'));
  $('#disc-reopen').addEventListener('click', () => changeStatus('reopen'));
  $('#disc-relocate-cue').addEventListener('click', submitRelocateCue);
  $('#disc-relocate-range').addEventListener('click', submitRelocateRange);
  $('#disc-reply-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitReply();
  });

  // 加载项目 / 提交新版本后刷新（锚点可能已自动跟随或变成待重新定位）
  refreshSummary();
  if (g.pollTimer) clearInterval(g.pollTimer);
  g.pollTimer = setInterval(async () => {
    if (!state.project) return;
    await refreshSummary();
    if ($('.tab-pane.active')?.dataset.pane === 'disc') {
      loadList();
    } else if (g.threads.length) {
      // 轻量同步未解决计数（句子列表徽标与顶栏），有讨论时才请求
      const { discussions } = await api.discList(state.project.id, { status: 'open' });
      g.threads = discussions;
      window.dispatchEvent(new CustomEvent('discussions-loaded'));
    }
    if (g.openId) loadDetail(g.openId, true);
  }, 15000);
}
/** 挂在某句上创建讨论 */
export function openCreateOnCue(cueId) {
  openCreate({ mode: 'cue', cueId });
}

/** 当前项目中每条已定位句子的未解决讨论数，供句子列表/时间轴显示徽标 */
export function cueDiscMap() {
  const m = new Map();
  for (const t of g.threads) {
    if (t.anchor_status === 'anchored' && t.anchor_type === 'cue' && t.anchor_id && t.status === 'open') {
      m.set(t.anchor_id, (m.get(t.anchor_id) || 0) + 1);
    }
  }
  return m;
}

export async function refreshDiscussions() {
  const listPromise = $('.tab-pane.active')?.dataset.pane === 'disc' ? loadList() : ensureThreads();
  await Promise.all([refreshSummary(), listPromise]);
  if (g.openId) return loadDetail(g.openId, true);
}

/** 载入全量讨论到本地缓存（句子列表的未解决徽标依赖它），列表页打开时无需再重复请求 */
async function ensureThreads() {
  const { discussions, summary } = await api.discList(state.project.id);
  g.threads = discussions;
  g.summary = summary;
  renderBadge();
  // 徽标随数据到达后重渲染句子列表（初始渲染发生在数据返回之前）
  window.dispatchEvent(new CustomEvent('discussions-loaded'));
}

async function refreshSummary() {
  if (!state.project) return;
  try {
    g.summary = await api.discSummary(state.project.id);
    renderBadge();
  } catch { /* 顶栏汇总失败不阻塞编辑 */ }
}

function renderBadge() {
  const el = $('#disc-badge');
  const s = g.summary;
  el.textContent = `💬 ${s.unresolved} 未解决${s.unresolvedOrphan ? ` · ${s.unresolvedOrphan} 待重新定位` : ''}`;
  el.classList.toggle('alert', s.unresolvedOrphan > 0);
}

/* ==================== 列表 ==================== */

export async function refreshTab() {
  await Promise.all([refreshSummary(), loadList()]);
}

async function loadList() {
  const wrap = $('#disc-list');
  wrap.innerHTML = '加载中…';
  const { discussions, summary } = await api.discList(state.project.id, g.filter);
  g.threads = discussions;
  g.summary = summary;
  renderBadge();
  if (!discussions.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">没有符合条件的讨论。选中句子后点「💬」即可在单句上发起讨论，也可以新建时间范围讨论。</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const t of discussions) wrap.appendChild(renderCard(t));
}

function anchorText(t) {
  if (t.anchor_status === 'orphan') {
    const last = t.last_anchor_start != null ? `${msToSrt(t.last_anchor_start)} → ${msToSrt(t.last_anchor_end)}` : '—';
    return `待重新定位 · 旧位置 ${last}`;
  }
  const range = `${msToSrt(t.anchor_start)} → ${msToSrt(t.anchor_end)}`;
  return t.anchor_type === 'cue'
    ? `句子 ${t.anchor_id} · ${range}`
    : `时间范围 · ${t.anchor_track ? trackName(t.anchor_track) + ' · ' : '全部轨道 · '}${range}`;
}

function trackName(id) {
  return state.snapshot?.tracks.find((x) => x.id === id)?.name || id;
}

function renderCard(t) {
  const div = document.createElement('div');
  div.className = 'disc-card' + (t.status === 'resolved' ? ' resolved' : '') + (t.anchor_status === 'orphan' ? ' orphan' : '');
  const title = t.title || t.id;
  div.innerHTML = `
    <div class="disc-card-head">
      <b>${esc(title)}</b>
      <span class="flex1"></span>
      ${t.status === 'open' ? '<span class="tag qc-bad">未解决</span>' : '<span class="tag qc-ok">已解决</span>'}
      ${t.anchor_status === 'orphan' ? `<span class="tag disc-orphan-tag" title="${esc(REASON_LABEL[t.orphan_reason] || '')}">待重新定位</span>` : ''}
    </div>
    <div class="meta">${esc(anchorText(t))}</div>
    <div class="meta">${esc(t.created_by)} 发起 · ${dt(t.created_at)} · ${t.messageCount} 条回复 · 更新于 ${dt(t.updated_at)}</div>
  `;
  div.addEventListener('click', () => openThread(t.id));
  return div;
}

/* ==================== 创建 ==================== */

function openCreate(anchor) {
  if (state.readOnly) { ctx.toast('历史版本只读视图中不能发起讨论，请先返回最新版本', 'error'); return; }
  g.create = anchor;
  $('#disc-create-title').value = '';
  $('#disc-create-body').value = '';
  $('#disc-create-anchor').innerHTML = '';
  $('#disc-create-exist').innerHTML = '';

  if (anchor.mode === 'cue') {
    const cue = state.snapshot.cues.find((c) => c.id === anchor.cueId);
    if (!cue) { ctx.toast('句子不存在，请刷新后重试', 'error'); return; }
    $('#disc-create-anchor').innerHTML =
      `挂在句子 <code>${esc(cue.id)}</code>（${msToSrt(cue.start)} → ${msToSrt(cue.end)}，${esc(trackName(cue.trackId))}）：<br/>
       <span style="color:var(--muted)">「${esc(cue.text)}」</span>`;
    renderExistOnCue(anchor.cueId);
  } else {
    $('#disc-create-anchor').innerHTML = `
      <div class="new-row">
        <span style="min-width:64px">时间范围</span>
        <input id="dc-start" value="${msToSrt(anchor.start)}" style="width:130px" />
        <span>→</span>
        <input id="dc-end" value="${msToSrt(anchor.end)}" style="width:130px" />
      </div>
      <div class="new-row">
        <span style="min-width:64px">轨道</span>
        <select id="dc-track" style="flex:1">
          <option value="">全部轨道（时间范围不绑定具体轨道）</option>
          ${state.snapshot.tracks.map((t) => `<option value="${t.id}" ${t.id === anchor.trackId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
      </div>`;
  }
  $('#disc-create-modal').classList.add('show');
  $('#disc-create-body').focus();
}

async function renderExistOnCue(cueId) {
  try {
    const { discussions } = await api.discList(state.project.id, { cueId });
    if (!discussions.length) return;
    $('#disc-create-exist').innerHTML =
      '<div class="pane-section-title" style="margin-top:8px">该句上已有讨论（点击查看）</div>' +
      .map((t) =>
        `<div class="disc-exist-row" data-id="${t.id}">${esc(t.title || '（无标题讨论）')}
           ${t.status === 'open' ? '<span class="tag qc-bad">未解决</span>' : '<span class="tag qc-ok">已解决</span>'}
           ${t.anchor_status === 'orphan' ? '<span class="tag disc-orphan-tag">待重新定位</span>' : ''}
         </div>`).join('');
    $('#disc-create-exist').querySelectorAll('.disc-exist-row').forEach((row) => {
      row.addEventListener('click', () => {
        $('#disc-create-modal').classList.remove('show');
        openThread(row.dataset.id);
      });
    });
  } catch { /* 非关键路径 */ }
}

async function submitCreate() {
  const a = g.create;
  if (!a) return;
  const body = {
    title: $('#disc-create-title').value.trim(),
    body: $('#disc-create-body').value.trim(),
    author: ctx.getAuthor(),
    clientToken: uid('tok'),
  };
  if (!body.body) { ctx.toast('请填写讨论内容', 'error'); return; }
  try {
    if (a.mode === 'cue') {
      body.anchorType = 'cue';
      body.cueId = a.cueId;
    } else {
      body.anchorType = 'range';
      try {
        body.start = parseTime($('#dc-start').value);
        body.end = parseTime($('#dc-end').value);
      } catch {
        ctx.toast('时间格式应为 HH:MM:SS,mmm 或毫秒数', 'error');
        return;
      }
      body.trackId = $('#dc-track').value;
    }
    const result = await api.discCreate(state.project.id, body);
    $('#disc-create-modal').classList.remove('show');
    ctx.toast(result.deduplicated ? '该请求已提交过，返回原讨论' : '讨论已创建', 'ok');
    await refreshTab();
    openThread(result.thread.thread.id);
  } catch (e) {
    ctx.toast('创建失败：' + e.message, 'error');
  }
}

/* ==================== 详情 / 事件时间线 ==================== */

async function openThread(id) {
  $('#disc-modal').classList.add('show');
  g.openId = id;
  await loadDetail(id);
}

async function loadDetail(id, silent = false) {
  try {
    g.detail = await api.discGet(state.project.id, id);
    renderDetail(silent);
  } catch (e) {
    if (!silent) ctx.toast('加载讨论失败：' + e.message, 'error');
  }
}

function locHtml(loc, { prefix = '' } = {}) {
  if (!loc) return '—';
  if (loc.type === 'range' || (!loc.cueId && loc.start != null)) {
    return `${prefix}时间范围 ${msToSrt(loc.start)} → ${msToSrt(loc.end)}${loc.track ? ' · ' + esc(trackName(loc.track)) : ''}`;
  }
  return `${prefix}句子 <code>${esc(loc.cueId)}</code> · ${msToSrt(loc.start)} → ${msToSrt(loc.end)}${loc.track ? ' · ' + esc(trackName(loc.track)) : ''}`;
}

function renderDetail(silent = false) {
  const { thread: t, events, anchorContext } = g.detail;
  $('#disc-modal-title').textContent = t.title || '（无标题讨论）';
  const tags = [];
  tags.push(t.status === 'open'
    ? '<span class="tag qc-bad">未解决</span>'
    : '<span class="tag qc-ok">已解决</span>');
  if (t.anchor_status === 'orphan') tags.push('<span class="tag disc-orphan-tag">待重新定位</span>');
  $('#disc-modal-tags').innerHTML = tags.join(' ');

  // 锚点条 + 跳转
  const anchorBar = $('#disc-anchor-bar');
  if (t.anchor_status === 'anchored') {
    const cueExists = t.anchor_type === 'cue' ? anchorContext?.exists : anchorContext?.exists !== false;
    anchorBar.className = 'disc-anchor' + (cueExists ? '' : ' stale');
    anchorBar.innerHTML = `
      <span>${locHtml({
        type: t.anchor_type, cueId: t.anchor_id, track: t.anchor_track, start: t.anchor_start, end: t.anchor_end,
      })}</span>
      <span class="flex1"></span>
      <button class="small-btn primary" id="disc-jump">▶ 跳到对应时间</button>`;
    $('#disc-jump').addEventListener('click', () => jumpTo(t));
  } else {
    anchorBar.className = 'disc-anchor orphan';
    const last = { type: t.anchor_type, cueId: t.last_anchor_id, track: t.last_anchor_track, start: t.last_anchor_start, end: t.last_anchor_end };
    anchorBar.innerHTML = `
      <span>⚠ ${esc(REASON_LABEL[t.orphan_reason] || '无法唯一匹配')}（旧位置：${locHtml(last)}）</span>
      <span class="flex1"></span>
      <button class="small-btn" id="disc-jump-old" title="旧时间仍可定位播放头">跳到旧时间</button>`;
    $('#disc-jump-old').addEventListener('click', () => ctx.locate({ start: t.last_anchor_start ?? t.anchor_start }));
  }

  renderEvents(events, silent);
  renderOrphanPanel();

  // 只有打开/发送/操作后才滚到最新，轮询刷新保持用户当前滚动位置
  if (!silent) $('#disc-events').scrollTop = $('#disc-events').scrollHeight;

  $('#disc-resolve').style.display = t.status === 'open' ? '' : 'none';
  $('#disc-reopen').style.display = t.status === 'resolved' ? '' : 'none';
  // 轮询刷新时不清空用户正在输入的回复，也不复用上次发送的幂等令牌
  if (document.activeElement !== $('#disc-reply-input')) {
    $('#disc-reply-input').value = '';
    $('#disc-reply-input').dataset.token = '';
  }
  $('#disc-reply-input').disabled = false;
  $('#disc-send').disabled = false;
  $('#disc-version').value = t.version;
}

function renderEvents(events, silent = false) {
  const wrap = $('#disc-events');
  wrap.innerHTML = '';
  for (const e of events) {
    const div = document.createElement('div');
    div.className = 'disc-event ' + (e.kind === 'message' ? 'msg' : 'sys');
    let extra = '';
    if (e.kind === 'relocate' || e.kind === 'auto-follow') {
      extra = `<div class="disc-reloc">
          <div>旧：${locHtml(e.detail?.old)}</div>
          <div>新：${locHtml(e.detail?.new)}</div>
          ${e.kind === 'auto-follow' ? '<div class="meta">原句子编号已消失，按内容唯一匹配自动跟随；如不正确可解决后重新定位。</div>' : ''}
        </div>`;
    } else if (e.kind === 'orphan') {
      const cands = (e.detail?.candidates || []);
      extra = `<div class="disc-reloc">
          <div>原因：${esc(REASON_LABEL[e.detail?.reason] || e.detail?.reason || '')}</div>
          <div>旧：${locHtml(e.detail?.old)}</div>
          ${cands.length ? '<div class="meta">候选句子：' + cands.map((c) =>
            `<code>${esc(c.cueId)}</code>（${msToSrt(c.start)} 相似度评分 ${(c.score ?? 0).toFixed(2)}）`).join('；') + '</div>' : ''}
        </div>`;
    } else if (e.kind === 'create' && e.detail?.anchor) {
      extra = `<div class="disc-reloc">${locHtml({
        type: e.detail.anchor.cueId ? 'cue' : 'range',
        cueId: e.detail.anchor.cueId, track: e.detail.anchor.track === '' ? null : e.detail.anchor.track,
        start: e.detail.anchor.start, end: e.detail.anchor.end,
      })}</div>`;
    }
    div.innerHTML = `
      <div class="disc-event-head">
        <b>${esc(e.actor)}</b>
        <span class="tag">${esc(EVENT_LABEL[e.kind] || e.kind)}</span>
        <span class="flex1"></span>
        <span class="meta">${dt(e.created_at)}</span>
      </div>
      ${e.body ? `<div class="disc-event-body">${esc(e.body).replace(/\n/g, '<br/>')}</div>` : ''}
      ${extra}`;
    wrap.appendChild(div);
  }
}

/* ==================== 待重新定位面板 ==================== */

function renderOrphanPanel() {
  const { thread: t } = g.detail;
  const panel = $('#disc-relocate-panel');
  panel.style.display = state.readOnly ? 'none' : t.anchor_status === 'orphan' ? 'block' : 'none';
  if (t.anchor_status !== 'orphan') return;

  const cands = t.orphan_detail?.candidates || [];
  $('#disc-candidates').innerHTML = cands.length
    ? cands.map((c) => `
      <div class="disc-cand" data-cue="${esc(c.cueId)}">
        <code>${esc(c.cueId)}</code> · ${msToSrt(c.start)} → ${msToSrt(c.end)} · ${esc(trackName(c.trackId))}
        <div class="meta">「${esc((c.text || '').slice(0, 60))}」评分 ${(c.score ?? 0).toFixed(2)}</div>
      </div>`).join('')
    : '<p style="color:var(--muted)">没有可信候选，请手动选择句子或改挂时间范围。</p>';
  $('#disc-candidates').querySelectorAll('.disc-cand').forEach((el) => {
    el.addEventListener('click', () => doRelocate({ targetType: 'cue', cueId: el.dataset.cue }));
  });

  $('#disc-cue-select').innerHTML = state.snapshot.cues
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c) => `<option value="${c.id}">${msToSrt(c.start)} ${esc((c.text || '').slice(0, 24))}（${esc(trackName(c.trackId))}）</option>`)
    .join('');
  $('#disc-range-track').innerHTML =
    '<option value="">全部轨道</option>' +
    state.snapshot.tracks.map((tr) => `<option value="${tr.id}">${esc(tr.name)}</option>`).join('');
  const lastStart = t.last_anchor_start ?? 0;
  const lastEnd = t.last_anchor_end ?? Math.min(state.snapshot.duration, lastStart + 2000);
  $('#disc-range-start').value = msToSrt(lastStart);
  $('#disc-range-end').value = msToSrt(lastEnd);
}

function submitRelocateCue() {
  return doRelocate({ targetType: 'cue', cueId: $('#disc-cue-select').value });
}
function submitRelocateRange() {
  let start, end;
  try {
    start = parseTime($('#disc-range-start').value);
    end = parseTime($('#disc-range-end').value);
  } catch {
    ctx.toast('时间格式应为 HH:MM:SS,mmm', 'error');
    return;
  }
  return doRelocate({ targetType: 'range', start, end, trackId: $('#disc-range-track')?.value || '' });
}

async function doRelocate(target) {
  const t = g.detail.thread;
  if (!confirm('把讨论重新定位到所选位置？旧位置会完整保留在定位历史中。')) return;
  try {
    const result = await api.discRelocate(state.project.id, t.id, {
      ...target,
      note: '',
      expectedVersion: t.version,
      clientToken: uid('tok'),
      author: ctx.getAuthor(),
    });
    g.detail = result.thread;
    renderDetail();
    ctx.toast('已重新定位', 'ok');
    await Promise.all([loadList(), refreshSummary()]);
  } catch (e) {
    await handleWriteError(e, '重新定位失败');
  }
}

/* ==================== 回复 / 状态 ==================== */

async function submitReply() {
  const t = g.detail?.thread;
  if (!t) return;
  const input = $('#disc-reply-input');
  const text = input.value.trim();
  if (!text) return;
  $('#disc-send').disabled = true;
  try {
    const result = await api.discReply(state.project.id, t.id, {
      body: text,
      expectedVersion: t.version,
      clientToken: input.dataset.token || (input.dataset.token = uid('tok')),
      author: ctx.getAuthor(),
    });
    g.detail = result.thread;
    renderDetail();
  } catch (e) {
    $('#disc-send').disabled = false;
    await handleWriteError(e, '回复失败', text);
  }
}

async function changeStatus(kind) {
  const t = g.detail?.thread;
  if (!t) return;
  const payload = {
    expectedVersion: t.version,
    clientToken: uid('tok'),
    author: ctx.getAuthor(),
  };
  try {
    const fn = kind === 'resolve' ? api.discResolve : api.discReopen;
    const result = await fn(state.project.id, t.id, payload);
    g.detail = result.thread;
    renderDetail();
    await Promise.all([loadList(), refreshSummary()]);
    ctx.toast(kind === 'resolve' ? '讨论已解决' : '讨论已重新打开', 'ok');
  } catch (e) {
    await handleWriteError(e, kind === 'resolve' ? '解决失败' : '重新打开失败');
  }
}

/**
 * 乐观锁失配：服务端状态已更新，拉取最新详情后保留用户输入并提示重试；
 * 重复请求（clientToken 命中）直接刷新成已有结果。任何并发写入都不会被覆盖或丢消息。
 */
async function handleWriteError(e, prefix, keptText = '') {
  if (e.status === 409 && (e.data?.code === 'version-conflict' || e.data?.current)) {
    if (g.openId) await loadDetail(g.openId, true);
    if (keptText) $('#disc-reply-input').value = keptText;
    ctx.toast('讨论刚被他人更新，已载入最新内容，请重试', 'error');
  } else if (e.status === 409 && e.data?.code === 'duplicate-request') {
    if (e.data.discussionId) { g.openId = e.data.discussionId; await loadDetail(e.data.discussionId); }
    ctx.toast('重复请求，已返回原有结果', '');
  } else {
    ctx.toast(prefix + '：' + e.message, 'error');
  }
}

/* ==================== 跳转 ==================== */

function jumpTo(t) {
  if (t.anchor_type === 'cue') {
    if (g.detail.anchorContext?.exists) {
      ctx.locate({ cueId: t.anchor_id, start: t.anchor_start });
    } else {
      // 已定位但句子在当前 HEAD 已找不到（正常情况下提交钩子会把它变为 orphan）
      ctx.locate({ start: t.anchor_start });
    }
  } else {
    seek(t.anchor_start);
    ctx.locate({ start: t.anchor_start, trackId: t.anchor_track || null });
  }
}
