// 分段协作校对：批次总览 / 过滤 / 个人待办 / 片段编辑 / 退回重提 / 多片段接受与冲突处理
import { api } from './api.js';
import { state, subscribe } from './state.js';
import { msToSrt, parseTime } from './time.js';

let ctx = null;
let revisionsCache = [];
let tracksCache = [];
let openBatchId = null;          // 当前打开详情的批次
let batchData = null;           // 批次详情 {batch, segments}
let filter = { status: '', assignee: '' };
let todoName = localStorage.getItem('proofReviewer') || '';
let todos = null;

// 片段编辑弹窗状态
let editor = null; // {segment, baseline, draft:[cues], detail, baseVersion, dirty, timer}
let pendingAccept = null; // {segmentIds, report, resolutions}
let returnTarget = null;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dt = (t) => (t ? new Date(t).toLocaleString() : '—');
const token = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

const STATUS = {
  unclaimed: ['未领取', 'qc-stale'],
  editing: ['编辑中', 'qc-warn'],
  review: ['待审核', 'qc-info'],
  returned: ['已退回', 'qc-bad'],
  merged: ['已合入', 'qc-ok'],
};
const STATUS_FILTERS = [['', '全部状态'], ...Object.entries(STATUS).map(([k, [v]]) => [k, v])];

export function initProof(context) {
  ctx = context;
  todoName = localStorage.getItem('proofReviewer') || ctx.getAuthor();
  $('#proof-todo-name').value = todoName;

  $('#proof-create-btn').addEventListener('click', createBatch);
  $('#proof-refresh').addEventListener('click', refreshAll);
  $('#proof-todo-load').addEventListener('click', loadTodos);
  $('#proof-todo-name').addEventListener('change', () => {
    todoName = $('#proof-todo-name').value.trim();
    localStorage.setItem('proofReviewer', todoName);
  });
  document.querySelector('.tabs button[data-tab="proof"]').addEventListener('click', refreshAll);

  $('#proof-seg-cancel').addEventListener('click', closeEditor);
  $('#proof-seg-claim').addEventListener('click', onClaim);
  $('#proof-seg-renew').addEventListener('click', onRenew);
  $('#proof-seg-release').addEventListener('click', onRelease);
  $('#proof-seg-save').addEventListener('click', onSaveDraft);
  $('#proof-seg-submit').addEventListener('click', onSubmit);
  $('#proof-return-cancel').addEventListener('click', () => $('#proof-return-modal').classList.remove('show'));
  $('#proof-return-confirm').addEventListener('click', onReturnConfirm);
  $('#proof-conflict-cancel').addEventListener('click', () => { pendingAccept = null; $('#proof-conflict-modal').classList.remove('show'); });
  $('#proof-conflict-confirm').addEventListener('click', onConflictResolve);
  $('#proof-events-close').addEventListener('click', () => $('#proof-events-modal').classList.remove('show'));

  subscribe((reason) => {
    if (reason === 'load') {
      openBatchId = null;
      batchData = null;
      todos = null;
      refreshAll();
    }
  });
}

async function refreshAll() {
  if (!state.project) return;
  try {
    const [{ batches }, { revisions }] = await Promise.all([
      api.proofList(state.project.id),
      api.listRevisions(state.project.id),
    ]);
    revisionsCache = [...revisions].reverse(); // 旧 → 新
    tracksCache = state.snapshot?.tracks || [];
    renderRevSelect();
    renderTrackPick();
    renderBatchList(batches);
    if (openBatchId) await openBatch(openBatchId, true);
    if ($('#proof-todo-name').value.trim()) await loadTodos(true);
  } catch (e) {
    ctx.toast('加载校对批次失败：' + e.message, 'error');
  }
}

/* ==================== 创建批次 ==================== */

function renderRevSelect() {
  const sel = $('#proof-rev-select');
  const prev = sel.value;
  sel.innerHTML = revisionsCache.map((r) =>
    `<option value="${esc(r.id)}">${esc((r.message || r.kind).slice(0, 30))} · ${r.id.slice(0, 8)} · ${dt(r.created_at)}</option>`).join('');
  // 默认选 HEAD（最后一个）
  sel.value = prev || revisionsCache.at(-1)?.id || '';
}

function renderTrackPick() {
  const wrap = $('#proof-track-pick');
  if (!tracksCache.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<span class="meta" style="margin-right:6px">参与轨道（不勾=全部）：</span>' + tracksCache.map((t) =>
    `<label style="margin-right:10px"><input type="checkbox" class="proof-track" value="${esc(t.id)}" /> ${esc(t.name)}</label>`).join('');
}

async function createBatch() {
  const revisionId = $('#proof-rev-select').value;
  if (!revisionId) { ctx.toast('请选择基准版本', 'error'); return; }
  const trackIds = [...document.querySelectorAll('.proof-track:checked')].map((c) => c.value);
  try {
    const r = await api.proofCreate(state.project.id, {
      revisionId,
      title: $('#proof-title').value.trim(),
      gapMs: Number($('#proof-gap').value),
      maxSegmentMs: Number($('#proof-max').value),
      ttlMs: Math.max(1, Number($('#proof-ttl').value) || 30) * 60000,
      trackIds,
      author: ctx.getAuthor(),
    });
    ctx.toast(`批次已创建：${r.batch.segCount} 个连续片段（基准已冻结）`, 'ok');
    $('#proof-title').value = '';
    ctx.refreshAudit?.();
    openBatchId = r.batch.id;
    await refreshAll();
  } catch (e) {
    ctx.toast('创建失败：' + e.message, 'error');
  }
}

/* ==================== 批次列表 ==================== */

function renderBatchList(batches) {
  const wrap = $('#proof-batches');
  if (!batches.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">还没有校对批次。</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const b of batches) {
    const c = b.progress.counts;
    const div = document.createElement('div');
    div.className = 'qc-job' + (b.id === openBatchId ? ' qc-job-active' : '');
    const statusTag = b.status === 'completed'
      ? '<span class="tag qc-ok">已完成</span>'
      : '<span class="tag qc-warn">进行中</span>';
    div.innerHTML = `
      <div class="row"><b>${esc(b.title || '未命名批次')}</b> ${statusTag}
        ${b.headMoved ? '<span class="tag qc-bad" title="批次创建后 HEAD 已推进，接受时逐段三向合并">HEAD 已变化</span>' : ''}</div>
      <div class="meta">
        片段 ${b.segCount} · 未领取 ${c.unclaimed} · 编辑中 ${c.editing} · 待审核 ${c.review} · 退回 ${c.returned} · 已合入 ${c.merged}<br/>
        基准 ${b.baseRevId.slice(0, 10)} · 空隙>${b.gapMs}ms · 最长${b.maxSegmentMs}ms · 领取有效期 ${Math.round(b.ttlMs / 60000)} 分钟<br/>
        创建：${esc(b.createdBy)} · ${dt(b.createdAt)}
      </div>
      <div class="row" style="margin-top:6px"></div>`;
    const actions = div.querySelector('.row:last-child');
    const mk = (label, fn) => {
      const btn = document.createElement('button');
      btn.className = 'small-btn';
      btn.textContent = label;
      btn.addEventListener('click', fn);
      actions.appendChild(btn);
    };
    mk('打开批次', () => { openBatchId = b.id; refreshAll(); });
    wrap.appendChild(div);
  }
}

/* ==================== 批次详情：进度 + 过滤 + 片段表 ==================== */

async function openBatch(id, silent = false) {
  try {
    batchData = await api.proofBatch(state.project.id, id, { viewer: todoName });
    renderBatchDetail();
  } catch (e) {
    if (!silent) ctx.toast('打开批次失败：' + e.message, 'error');
  }
}

function renderBatchDetail() {
  if (!batchData) { $('#proof-view').innerHTML = ''; return; }
  const { batch, segments } = batchData;
  const people = [...new Set(batch.progress ? Object.keys(batch.progress.byAssignee) : [])].sort();
  const c = batch.progress.counts;

  const filters = `
    <div class="qc-filters">
      <select id="pf-status">${STATUS_FILTERS.map(([v, l]) => `<option value="${v}" ${filter.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="pf-assignee">
        <option value="">全部人员</option>
        ${people.map((p) => `<option value="${esc(p)}" ${filter.assignee === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select>
      <button id="pf-filter" class="small-btn">筛选</button>
      <span style="flex:1"></span>
      <button id="pf-events" class="small-btn">操作记录</button>
    </div>`;

  const rows = segments
    .filter((s) => (!filter.status || s.status === filter.status) && (!filter.assignee || s.assignee === filter.assignee))
    .map(segRow).join('');

  const reviewCount = c.review;
  $('#proof-view').innerHTML = `
    <div class="qc-job qc-job-active" style="margin-top:8px">
      <div class="row">
        <b>${esc(batch.title || '未命名批次')}</b>
        ${batch.status === 'completed' ? '<span class="tag qc-ok">已完成</span>' : '<span class="tag qc-warn">进行中</span>'}
        ${batch.headMoved ? '<span class="tag qc-bad">HEAD 已变化：接受时逐段三向合并</span>' : ''}
      </div>
      <div class="meta">
        基准版本 ${batch.baseRevId.slice(0, 10)}（${esc(batch.baseRevision?.message || '')}） · 当前 HEAD ${(batch.currentHeadRevId || '').slice(0, 10)}<br/>
        未领取 ${c.unclaimed} · 编辑中 ${c.editing} · 待审核 ${c.review} · 退回 ${c.returned} · 已合入 ${c.merged} / 共 ${batch.segCount}
      </div>
      ${filters}
      <div class="qc-filters">
        <label><input type="checkbox" id="pf-all-review" ${reviewCount ? '' : 'disabled'} /> 全选待审核（${reviewCount}）</label>
        <button id="pf-accept" class="small-btn primary" ${reviewCount ? '' : 'disabled'}>一次接受所选片段并生成新版本</button>
        <span id="pf-accept-hint" style="color:var(--muted);font-size:11px"></span>
      </div>
      <div class="import-table-wrap" style="max-height:46vh">
        <table class="import-table">
          <thead><tr><th>选</th><th>#</th><th>时间</th><th>句数</th><th>状态</th><th>领取人</th><th>到期</th><th>标记</th><th>操作</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="9" style="color:var(--muted)">没有符合筛选的片段</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  bindDetailEvents(segments);
}

function segRow(s) {
  const [label, cls] = STATUS[s.status] || [s.status, ''];
  const mine = s.mine ? '<span class="tag qc-info">我的</span>' : '';
  const changed = s.baseChanged ? '<span class="tag qc-bad" title="批次创建后相关句子在 HEAD 链上已变化">基准句已变化</span>' : '';
  const draft = s.hasDraft ? '<span class="tag">草稿</span>' : '';
  const ret = s.status === 'returned' ? `<div class="meta" style="color:var(--warn)">退回：${esc(s.returnReason || '')}</div>` : '';
  const expired = !s.claimActive && (s.assignee) && s.status !== 'merged' && s.status !== 'review';
  return `
    <tr data-seg="${esc(s.id)}" class="${s.status === 'returned' ? 'proof-returned' : ''}">
      <td>${s.status === 'review' ? `<input type="checkbox" class="pf-check" ${s.status === 'review' ? '' : 'disabled'} />` : ''}</td>
      <td>${s.seq}</td>
      <td class="meta">${msToSrt(s.startMs)} →<br/>${msToSrt(s.endMs)}</td>
      <td>${s.cueCount}</td>
      <td><span class="tag ${cls}">${label}</span> ${mine}</td>
      <td>${esc(s.assignee || '—')}${expired ? ' <span class="tag qc-stale">已过期</span>' : ''}</td>
      <td class="meta">${s.claimExpiresAt ? dt(s.claimExpiresAt) : '—'}</td>
      <td>${draft}${changed}${ret}</td>
      <td><button class="small-btn pf-open">打开</button></td>
    </tr>`;
}

function bindDetailEvents(segments) {
  $('#pf-filter').addEventListener('click', async () => {
    filter.status = $('#pf-status').value;
    filter.assignee = $('#pf-assignee').value;
    // 服务端过滤重新取
    try {
      batchData = await api.proofBatch(state.project.id, openBatchId, { ...filter, viewer: todoName });
      renderBatchDetail();
    } catch (e) { ctx.toast(e.message, 'error'); }
  });
  $('#pf-events').addEventListener('click', openEvents);
  document.querySelectorAll('.pf-open').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.seg;
      openEditor(id);
    });
  });
  const all = $('#pf-all-review');
  all?.addEventListener('change', () => {
    document.querySelectorAll('.pf-check').forEach((c) => { c.checked = all.checked; });
  });
  $('#pf-accept')?.addEventListener('click', onAcceptMany);
}

/* ==================== 个人待办 ==================== */

async function loadTodos(silent = false) {
  todoName = $('#proof-todo-name').value.trim();
  if (!todoName) { if (!silent) ctx.toast('请填写你的署名', 'error'); return; }
  localStorage.setItem('proofReviewer', todoName);
  try {
    todos = await api.proofTodos(todoName, state.project.id);
    renderTodos();
  } catch (e) {
    if (!silent) ctx.toast('加载待办失败：' + e.message, 'error');
  }
}

function todoCard(s, tone) {
  const [label] = STATUS[s.status] || [s.status];
  const div = document.createElement('div');
  div.className = 'qc-job';
  div.innerHTML = `
    <div class="row"><b>片段 #${s.seq}</b> <span class="tag">${label}</span>
      ${s.status === 'returned' ? `<span class="tag qc-bad">${esc(s.returnReason || '')}</span>` : ''}</div>
    <div class="meta">${msToSrt(s.startMs)} → ${msToSrt(s.endMs)} · ${s.cueCount} 句
      ${s.claimExpiresAt ? ` · 到期 ${dt(s.claimExpiresAt)}` : ''}</div>`;
  const btn = document.createElement('button');
  btn.className = 'small-btn primary';
  btn.style.marginTop = '6px';
  btn.textContent = tone === 'claimable' ? '领取并校对' : '继续校对';
  btn.addEventListener('click', async () => {
    if (tone === 'claimable') {
      try {
        await api.proofClaim(s.id, { reviewer: todoName, clientToken: token('claim') });
        ctx.toast('领取成功', 'ok');
      } catch (e) { ctx.toast('领取失败：' + (e.data?.assignee ? `已被 ${e.data.assignee} 领取` : e.message), 'error'); }
    }
    await refreshAll();
    openEditor(s.id);
  });
  div.appendChild(btn);
  return div;
}

function renderTodos() {
  const wrap = $('#proof-todos');
  if (!todos) { wrap.innerHTML = ''; return; }
  const { editing, returned, pendingReview, claimable } = todos.todos;
  wrap.innerHTML = '';
  const addGroup = (title, list, tone) => {
    if (!list.length) return;
    const h = document.createElement('div');
    h.className = 'pane-section-title';
    h.style.fontSize = '12px';
    h.textContent = `${title}（${list.length}）`;
    wrap.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'proof-todo-grid';
    list.forEach((s) => grid.appendChild(todoCard(s, tone)));
    wrap.appendChild(grid);
  };
  addGroup('退回待我修改', returned, 'returned');
  addGroup('我编辑中的片段', editing, 'mine');
  if (pendingReview.length) {
    const h = document.createElement('div');
    h.className = 'meta';
    h.textContent = `我提交待审核：${pendingReview.length} 个`;
    wrap.appendChild(h);
  }
  addGroup('可领取的空闲片段', claimable, 'claimable');
  if (!editing.length && !returned.length && !claimable.length && !pendingReview.length) {
    wrap.innerHTML = '<p style="color:var(--muted);font-size:12px">当前没有你的待办。</p>';
  }
}

/* ==================== 片段编辑弹窗 ==================== */

async function openEditor(segId) {
  try {
    const detail = await api.proofSegment(segId, todoName);
    const { segment, batch } = detail;
    let content = segment.currentDraft;
    if (!content) {
      // 未持有有效草稿时以基准内容展示（只读，需先领取）
      content = segment.baseline.map((b) => ({ ...b.cue }));
    }
    editor = {
      segId,
      batchId: batch.id,
      segment,
      baseline: segment.baseline,
      draft: content,
      detail,
      baseVersion: segment.myDraft?.version ?? segment.draftVersion ?? 0,
      dirty: false,
    };
    showEditor();
    $('#proof-seg-modal').classList.add('show');
  } catch (e) {
    ctx.toast('打开片段失败：' + e.message, 'error');
  }
}

function showEditor() {
  const { segment, batch } = editor;
  $('#proof-seg-title').textContent = `片段 #${segment.seq}（${batch.title || '未命名批次'}）`;
  const [label] = STATUS[segment.status] || [segment.status];
  const canEdit = segment.mine && (segment.status === 'editing' || segment.status === 'returned');
  $('#proof-seg-meta').innerHTML = `
    <span class="tag">${label}</span>
    <span class="meta">${msToSrt(segment.startMs)} → ${msToSrt(segment.endMs)} · ${segment.cueCount} 句 · ${esc(segment.trackNames.join('、'))}</span>
    ${segment.assignee ? `<span class="meta">领取人：${esc(segment.assignee)}</span>` : ''}
    ${segment.claimExpiresAt ? `<span class="meta" id="pe-expiry">到期：${dt(segment.claimExpiresAt)}</span>` : ''}
    ${segment.baseChanged ? '<span class="tag qc-bad">基准句在 HEAD 已变化</span>' : ''}
    ${!canEdit && segment.status !== 'review' && segment.status !== 'merged' ? '<span class="tag qc-warn">只读：领取后才能编辑</span>' : ''}`;

  const banner = $('#proof-seg-banner');
  if (segment.status === 'returned') {
    banner.style.display = 'block';
    banner.textContent = `组织者退回理由：${segment.returnReason || ''}（修改后可再次提交）`;
  } else {
    banner.style.display = 'none';
  }

  // 句子表：基准对照 + 可编辑 文本/开始/结束（锁定句不允许改时间与文本，只能看）
  const baseById = new Map(segment.baseline.map((b) => [b.cue.id, b.cue]));
  const rows = editor.draft.map((c) => {
    const bc = baseById.get(c.id);
    const changed = bc && JSON.stringify(['start', 'end', 'text', 'locked'].map((f) => bc[f])) !== JSON.stringify(['start', 'end', 'text', 'locked'].map((f) => c[f]));
    return `
      <tr data-cue="${esc(c.id)}" class="${changed ? 'proof-changed' : ''}">
        <td class="meta">${esc(c.id)}<br/>${esc(segment.baseline.find((b) => b.cue.id === c.id)?.trackName || c.trackId)}</td>
        <td><input class="pe-start" value="${esc(msToSrt(c.start))}" ${canEdit && !c.locked ? '' : 'disabled'} style="width:105px" /></td>
        <td><input class="pe-end" value="${esc(msToSrt(c.end))}" ${canEdit && !c.locked ? '' : 'disabled'} style="width:105px" /></td>
        <td><textarea class="pe-text" rows="2" style="width:100%;background:#11151c;border:1px solid var(--border);border-radius:6px;padding:4px;color:inherit" ${canEdit && !c.locked ? '' : 'disabled'}>${esc(c.text)}</textarea></td>
        <td class="meta">${c.locked ? '🔒锁定' : ''}${changed ? '<br/><span class="tag qc-info">已改</span>' : '<br/><span class="meta">基准：'+esc((bc?.text || '').slice(0, 18))+'</span>'}</td>
      </tr>`;
  }).join('');
  $('#proof-seg-table').innerHTML = `
    <thead><tr><th>句子</th><th>开始</th><th>结束</th><th>文本</th><th>对照</th></tr></thead><tbody>${rows}</tbody>`;

  // 提交历史
  const subs = segment.submissions || [];
  $('#proof-seg-submissions').innerHTML = subs.length
    ? '<div class="pane-section-title" style="font-size:12px">提交记录</div>' + subs.map((s) => {
      const st = { submitted: ['待审核', 'qc-info'], returned: ['已退回', 'qc-bad'], accepted: ['已接受', 'qc-ok'] }[s.status] || [s.status, ''];
      return `<div class="meta">#${s.seq} ${esc(s.reviewer)} · ${dt(s.submittedAt)} · <span class="tag ${st[1]}">${st[0]}</span>${s.returnReason ? ' · 理由：' + esc(s.returnReason) : ''}${s.mergedRevId ? ' · 已合入 ' + s.mergedRevId.slice(0, 8) : ''}</div>`;
    }).join('')
    : '';

  // 组织者操作条（服务端做最终鉴权；打开/返回失败会提示）
  renderOrganizerBar(segment);

  // 按钮可见性
  const show = (el, v) => { el.style.display = v ? '' : 'none'; };
  show($('#proof-seg-claim'), segment.status === 'unclaimed' && Boolean(todoName));
  show($('#proof-seg-renew'), canEdit);
  show($('#proof-seg-release'), canEdit);
  show($('#proof-seg-save'), canEdit);
  show($('#proof-seg-submit'), canEdit);

  if (canEdit) bindEditorInputs();
  refreshExpiryTimer();
}

function renderOrganizerBar(segment) {
  let bar = $('#pe-org-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pe-org-bar';
    bar.className = 'qc-filters';
    $('#proof-seg-meta').after(bar);
  }
  bar.innerHTML = '<span class="meta">组织者：</span>';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'small-btn';
    b.textContent = label;
    b.addEventListener('click', fn);
    bar.appendChild(b);
  };
  if (segment.status === 'review') {
    mk('退回附理由', () => askReturn(segment.id));
  }
  if (segment.status === 'unclaimed') {
    mk('指派给…', () => assignSeg(segment.id));
  }
  if (segment.status === 'editing' && segment.assignee) {
    mk('重新指派给…', () => assignSeg(segment.id));
  }
  mk('与下一段合并', () => mergeNext(segment.id));
  mk('按句拆分…', () => splitSeg(segment));
}

async function askReturn(segId) {
  returnTarget = segId;
  $('#proof-return-reason').value = '';
  $('#proof-return-seg').textContent = '片段 ' + segId.slice(0, 10);
  $('#proof-return-modal').classList.add('show');
}

async function assignSeg(segId) {
  const assignee = prompt('指派 / 重新指派给（审校人署名）：', todoName || '');
  if (!assignee) return;
  try {
    const r = await api.proofAssign(segId, { assignee: assignee.trim(), author: ctx.getAuthor() });
    ctx.toast(r.reassigned ? `已重新指派给 ${assignee.trim()}（原草稿保留）` : `已指派给 ${assignee.trim()}`, 'ok');
    $('#proof-seg-modal').classList.remove('show');
    editor = null;
    refreshAll();
  } catch (e) { ctx.toast('指派失败：' + e.message, 'error'); }
}

async function mergeNext(segId) {
  if (!confirm('与后一个相邻片段合并？仅当两段都空闲且无草稿/提交时允许。')) return;
  try {
    const r = await api.proofMergeNext(segId, { author: ctx.getAuthor() });
    batchData = { ...batchData, segments: r.segments };
    ctx.toast('已合并', 'ok');
    $('#proof-seg-modal').classList.remove('show');
    editor = null;
    refreshAll();
  } catch (e) { ctx.toast('合并失败：' + e.message, 'error'); }
}

async function splitSeg(segment) {
  const ids = segment.cueIds;
  if (ids.length < 2) { ctx.toast('该片段只有一句，无法拆分', 'error'); return; }
  const at = prompt(`在第几句之后拆分？输入 1 ~ ${ids.length - 1}（前半段句数）`, '1');
  if (at == null) return;
  const n = Number(at);
  if (!Number.isInteger(n) || n < 1 || n >= ids.length) { ctx.toast('拆分位置无效', 'error'); return; }
  try {
    const r = await api.proofSplit(segment.id, { cueIdsFirst: ids.slice(0, n), author: ctx.getAuthor() });
    batchData = { ...batchData, segments: r.segments };
    ctx.toast('已拆分', 'ok');
    $('#proof-seg-modal').classList.remove('show');
    editor = null;
    refreshAll();
  } catch (e) { ctx.toast('拆分失败：' + e.message, 'error'); }
}

function bindEditorInputs() {
  document.querySelectorAll('#proof-seg-table tbody tr').forEach((tr) => {
    const id = tr.dataset.cue;
    tr.querySelectorAll('input,textarea').forEach((el) => {
      el.addEventListener('input', () => {
        editor.dirty = true;
        const c = editor.draft.find((x) => x.id === id);
        try {
          if (el.classList.contains('pe-start')) c.start = parseTime(el.value);
          if (el.classList.contains('pe-end')) c.end = parseTime(el.value);
          if (el.classList.contains('pe-text')) c.text = el.value;
          el.style.borderColor = 'var(--border)';
        } catch {
          el.style.borderColor = 'var(--danger)';
        }
      });
    });
  });
}

function refreshExpiryTimer() {
  clearInterval(editor?.timer);
  if (!editor) return;
  const tick = () => {
    if (!editor) return;
    // 到期时间只依赖落盘的 claimExpiresAt；到点提示需重新领取
    const el = $('#pe-expiry');
    if (el && editor.segment.claimExpiresAt) {
      const ms = editor.segment.claimExpiresAt - Date.now();
      el.textContent = ms > 0 ? `剩余 ${Math.round(ms / 1000)} 秒（到期 ${dt(editor.segment.claimExpiresAt)}）` : '已过期：请关闭后重新领取';
      el.style.color = ms < 60000 ? 'var(--warn)' : '';
    }
  };
  tick();
  editor.timer = setInterval(tick, 1000);
}

function collectContent() {
  // 以输入框现值为准解析，非法时抛错
  const out = JSON.parse(JSON.stringify(editor.draft));
  document.querySelectorAll('#proof-seg-table tbody tr').forEach((tr) => {
    const id = tr.dataset.cue;
    const c = out.find((x) => x.id === id);
    c.start = parseTime(tr.querySelector('.pe-start').value);
    c.end = parseTime(tr.querySelector('.pe-end').value);
    c.text = tr.querySelector('.pe-text').value;
  });
  return out;
}

function closeEditor() {
  if (editor?.dirty && !confirm('有未保存的草稿修改，确定关闭？')) return;
  clearInterval(editor?.timer);
  $('#proof-seg-modal').classList.remove('show');
  editor = null;
}

async function onSaveDraft() {
  let content;
  try { content = collectContent(); } catch (e) { ctx.toast('时间格式有误：' + e.message, 'error'); return; }
  try {
    const r = await api.proofDraft(editor.segId, {
      reviewer: todoName,
      content,
      baseVersion: editor.baseVersion,
      clientToken: token('draft'),
    });
    editor.baseVersion = r.draftVersion;
    editor.dirty = false;
    editor.segment.draftVersion = r.draftVersion;
    ctx.toast('草稿已保存', 'ok');
    await reloadEditorSegment();
  } catch (e) {
    if (e.status === 409 && e.data?.code === 'version-conflict') {
      ctx.toast('草稿在别处已更新，刷新后再试', 'error');
      await reloadEditorSegment();
    } else if (e.status === 410) {
      ctx.toast('领取已过期：你的草稿已保留，请重新领取后续作', 'error');
      $('#proof-seg-modal').classList.remove('show');
      refreshAll();
    } else {
      ctx.toast('保存失败：' + e.message, 'error');
    }
  }
}

async function reloadEditorSegment() {
  const detail = await api.proofSegment(editor.segId, todoName);
  editor.segment = detail.segment;
  if (detail.segment.currentDraft) {
    editor.draft = detail.segment.currentDraft;
    editor.baseVersion = detail.segment.draftVersion;
  }
  showEditor();
}

async function onSubmit() {
  // 先保存草稿（携带当前编辑内容），再提交
  let content;
  try { content = collectContent(); } catch (e) { ctx.toast('时间格式有误：' + e.message, 'error'); return; }
  try {
    const sv = await api.proofDraft(editor.segId, {
      reviewer: todoName, content, baseVersion: editor.baseVersion, clientToken: token('draft'),
    });
    editor.baseVersion = sv.draftVersion;
    const r = await api.proofSubmit(editor.segId, { reviewer: todoName, clientToken: token('submit') });
    ctx.toast('已提交，等待组织者审核', 'ok');
    $('#proof-seg-modal').classList.remove('show');
    editor = null;
    await refreshAll();
  } catch (e) {
    if (e.status === 410) {
      ctx.toast('领取已过期，提交被拒绝：草稿已保留，请重新领取', 'error');
      $('#proof-seg-modal').classList.remove('show');
      refreshAll();
    } else {
      ctx.toast('提交失败：' + e.message, 'error');
    }
  }
}

async function onClaim() {
  if (!todoName) { ctx.toast('请先在「我的待办」处填写署名', 'error'); return; }
  try {
    const r = await api.proofClaim(editor.segId, { reviewer: todoName, clientToken: token('claim') });
    ctx.toast('领取成功', 'ok');
    await reloadEditorSegment();
  } catch (e) {
    ctx.toast('领取失败：' + (e.data?.assignee ? `已被 ${e.data.assignee} 领取` : e.message), 'error');
    $('#proof-seg-modal').classList.remove('show');
    editor = null;
    refreshAll();
  }
}

async function onRenew() {
  try {
    const r = await api.proofRenew(editor.segId, { reviewer: todoName, clientToken: token('renew') });
    editor.segment.claimExpiresAt = r.segment.claimExpiresAt;
    ctx.toast('已续期', 'ok');
    showEditor();
  } catch (e) {
    ctx.toast('续期失败：' + e.message + '（可能已过期，请重新领取）', 'error');
  }
}

async function onRelease() {
  if (!confirm('释放后片段回到未领取，你的草稿会保留，可再次领取续作。确定释放？')) return;
  try {
    await api.proofRelease(editor.segId, { reviewer: todoName, clientToken: token('release') });
    ctx.toast('已释放领取', 'ok');
    $('#proof-seg-modal').classList.remove('show');
    editor = null;
    refreshAll();
  } catch (e) {
    ctx.toast('释放失败：' + e.message, 'error');
  }
}

/* ==================== 组织者：退回 / 指派 / 合并 / 拆分 ==================== */

async function onReturnConfirm() {
  if (!returnTarget) return;
  const reason = $('#proof-return-reason').value.trim();
  if (!reason) { ctx.toast('退回必须填写理由', 'error'); return; }
  try {
    await api.proofReturn(returnTarget, { reason, author: ctx.getAuthor() });
    ctx.toast('已退回，领取人获得新一轮有效期', 'ok');
    $('#proof-return-modal').classList.remove('show');
    $('#proof-return-reason').value = '';
    returnTarget = null;
    ctx.refreshAudit?.();
    refreshAll();
  } catch (e) {
    ctx.toast('退回失败：' + e.message, 'error');
  }
}

/* ==================== 一次接受多片段（含冲突处理） ==================== */

async function onAcceptMany() {
  const ids = [...document.querySelectorAll('.pf-check:checked')].map((c) => c.closest('tr').dataset.seg);
  if (!ids.length) { ctx.toast('请勾选至少一个待审核片段', 'error'); return; }
  await doAccept(ids, {});
}

async function doAccept(segmentIds, resolutions) {
  try {
    const r = await api.proofAccept(state.project.id, {
      batchId: openBatchId,
      segmentIds,
      resolutions: Object.keys(resolutions).length ? resolutions : undefined,
      author: ctx.getAuthor(),
      message: '',
      clientToken: token('accept'),
    });
    ctx.toast(`已合入 ${r.report.filter((x) => x.result !== 'unchanged').length} 个片段并生成新版本`, 'ok');
    pendingAccept = null;
    $('#proof-conflict-modal').classList.remove('show');
    ctx.refreshAudit?.();
    await refreshAll();
  } catch (e) {
    if (e.status === 409 && e.data?.code === 'conflicts') {
      pendingAccept = { segmentIds, report: e.data.report };
      renderConflicts(e.data);
    } else if (e.status === 409 && e.data?.code === 'head-moved') {
      ctx.toast('合入规划期间项目产生了新版本，请重新发起接受', 'error');
    } else {
      ctx.toast('接受失败：' + e.message, 'error');
    }
  }
}

function renderConflicts(data) {
  const body = $('#proof-conflict-body');
  const auto = data.report.filter((r) => r.result !== 'conflict');
  const conflict = data.report.filter((r) => r.result === 'conflict');
  const segById = Object.fromEntries(batchData.segments.map((s) => [s.id, s]));

  const autoHtml = auto.length
    ? `<div class="pane-section-title" style="font-size:12px">可自动合入（${auto.length} 段）</div>
       ${auto.map((r) => `<div class="meta">片段 #${r.seq}（${esc(r.reviewer)}）：改动 ${r.changedCueIds.length} 句
          ${r.baseChanged ? ' · 基准句在 HEAD 变化但无冲突' : ''}${r.conflictCount ? ` · 已解决冲突 ${r.resolvedCueIds.length} 处` : ''}</div>`).join('')}`
    : '';

  const blocks = conflict.map((r) => {
    const seg = segById[r.segmentId];
    const items = r.conflicts.map((cf) => {
      const f = (cf.fields || []).map((x) => x.field).join('、') || '存在/删除';
      const mine = cf.mine ? `[${msToSrt(cf.mine.start)}→${msToSrt(cf.mine.end)}] ${cf.mine.text ?? ''}` : '（审校稿已删除该句）';
      const theirs = cf.theirs ? `[${msToSrt(cf.theirs.start)}→${msToSrt(cf.theirs.end)}] ${cf.theirs.text ?? ''}` : '（HEAD 已删除该句）';
      const base = cf.base ? `[${msToSrt(cf.base.start)}→${msToSrt(cf.base.end)}] ${cf.base.text ?? ''}` : '（基准无此句）';
      const choices = cf.kind === 'edit-delete'
        ? [['mine', '保留审校稿'], ['delete', '接受 HEAD 删除']]
        : [['mine', '采用审校稿'], ['theirs', '保留 HEAD']];
      return `
        <tr data-seg="${esc(r.segmentId)}" data-cue="${esc(cf.cueId)}" data-valid='${esc(JSON.stringify(cf.validChoices))}'>
          <td class="meta">${esc(cf.cueId)}<br/><span class="tag qc-bad">${esc(cf.kind)}</span><br/>字段：${esc(f)}</td>
          <td class="meta">${esc(base)}</td>
          <td>${esc(mine)}</td>
          <td>${esc(theirs)}</td>
          <td>${choices.map(([v, l], i) => `<label style="display:block"><input type="radio" name="cf-${esc(r.segmentId)}-${esc(cf.cueId)}" value="${v}" ${i === 0 ? 'checked' : ''}/> ${l}</label>`).join('')}</td>
        </tr>`;
    }).join('');
    return `
      <div class="pane-section-title">片段 #${r.seq}（${esc(r.reviewer)}）— ${r.conflicts.length} 处需人工处理</div>
      <table class="import-table">
        <thead><tr><th>句子</th><th>基准（冻结）</th><th>审校稿</th><th>当前 HEAD</th><th>选择</th></tr></thead>
        <tbody>${items}</tbody>
      </table>`;
  }).join('');

  body.innerHTML = `
    ${autoHtml}
    <div class="pane-section-title" style="font-size:12px">需要人工处理（${conflict.length} 段，未全部选择前不会写入任何内容）</div>
    ${blocks}`;
  $('#proof-conflict-modal').classList.add('show');
}

async function onConflictResolve() {
  if (!pendingAccept) return;
  const resolutions = {};
  let bad = false;
  document.querySelectorAll('#proof-conflict-body tbody tr').forEach((tr) => {
    const segId = tr.dataset.seg;
    const cueId = tr.dataset.cue;
    const valid = JSON.parse(tr.dataset.valid || '[]');
    const picked = tr.querySelector('input[type=radio]:checked');
    if (!picked || !valid.includes(picked.value)) { bad = true; return; }
    resolutions[segId] = resolutions[segId] || {};
    resolutions[segId][cueId] = picked.value;
  });
  if (bad) { ctx.toast('每处冲突都要选择', 'error'); return; }
  await doAccept(pendingAccept.segmentIds, resolutions);
}

/* ==================== 操作记录 ==================== */

async function openEvents() {
  try {
    const { events } = await api.proofEvents(state.project.id, openBatchId);
    const ACTION = {
      create: '创建批次', claim: '领取', renew: '续期', release: '释放',
      assign: '指派', reassign: '重新指派', merge: '合并片段', split: '拆分片段',
      'draft-save': '保存草稿', submit: '提交', return: '退回', accept: '接受合入',
      'batch-complete': '批次完成',
    };
    $('#proof-events-body').innerHTML = events.map((e) => `
      <div class="disc-msg">
        <div><b>${esc(ACTION[e.action] || e.action)}</b> · ${esc(e.actor)}
          ${e.segment_id ? `· 片段 ${esc(e.segment_id.slice(0, 10))}` : ''} · ${dt(e.created_at)}</div>
        ${e.detail ? `<div class="meta">${esc(JSON.stringify(e.detail).slice(0, 240))}</div>` : ''}
      </div>`).join('') || '<p style="color:var(--muted)">暂无事件</p>';
    $('#proof-events-modal').classList.add('show');
  } catch (e) {
    ctx.toast('加载操作记录失败：' + e.message, 'error');
  }
}
