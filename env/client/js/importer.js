import { api } from './api.js';
import { state } from './state.js';
import { msToSrt } from './time.js';

/**
 * 批量导入弹窗：
 *   第 1 步 选文件/粘贴内容 -> 调服务端预览（基于 state.baseRevId，即用户当前看到的版本）
 *   第 2 步 字段/轨道映射 + 逐行提示（非法时间、反向、重复、锁定、缺轨）+ 逐项勾选
 *   提交只应用勾选项；若期间项目有新版本，复用冲突弹窗逐句人工裁决，绝不整体覆盖。
 */
const $ = (s) => document.querySelector(s);

let session = null; // { preview, stale, content, filename, options, included: Map<seq,bool> }

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function initImportModal({ onCommitted, getAuthor, toast }) {
  $('#import-btn').addEventListener('click', () => openModal());
  $('#undo-import-btn').addEventListener('click', () => undoImport({ onCommitted, getAuthor, toast }));

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    $('#import-text').value = text;
    if (!$('#import-filename').value) $('#import-filename').value = file.name;
  });

  $('#import-pick-cancel').addEventListener('click', closeModal);
  $('#import-cancel').addEventListener('click', () => {
    closeModal();
    toast('已取消，未导入任何内容');
  });
  $('#import-back').addEventListener('click', () => showStep('pick'));

  $('#import-parse-btn').addEventListener('click', () => parseAndPreview(toast));
  $('#import-apply-btn').addEventListener('click', () => applyImport({ onCommitted, getAuthor, toast }));
  $('#import-select-valid').addEventListener('click', () => bulkSelect((r) => !r.issues.length));
  $('#import-select-none').addEventListener('click', () => bulkSelect(() => false));
}

function openModal() {
  if (state.readOnly) return;
  $('#import-file').value = '';
  $('#import-text').value = '';
  $('#import-filename').value = '';
  showStep('pick');
  $('#import-modal').classList.add('show');
}
function closeModal() {
  $('#import-modal').classList.remove('show');
  session = null;
}
function showStep(step) {
  $('#import-step-pick').style.display = step === 'pick' ? 'block' : 'none';
  $('#import-step-preview').style.display = step === 'preview' ? 'block' : 'none';
}

async function parseAndPreview(toast) {
  const content = $('#import-text').value;
  const filename = $('#import-filename').value.trim();
  if (!content.trim()) { toast('请先选择文件或粘贴字幕内容', 'error'); return; }
  try {
    const { preview, stale } = await api.importPreview(state.project.id, {
      baseRevId: state.baseRevId,
      content,
      filename,
      options: {
        defaultTrackId: state.snapshot.tracks[0]?.id,
        createMissingTracks: false,
      },
    });
    session = {
      preview,
      stale,
      content,
      filename,
      options: {
        defaultTrackId: preview.options?.defaultTrackId || state.snapshot.tracks[0]?.id,
        createMissingTracks: false,
        trackMap: {},
        mapping: preview.mapping || null,
      },
      included: new Map(preview.rows.filter((r) => r.included).map((r) => [r.seq, true])),
    };
    renderPreview(toast);
    showStep('preview');
  } catch (e) {
    toast('解析失败：' + e.message, 'error');
  }
}

/** 映射/默认轨改动后重新向服务端请求预览（服务端是唯一校验来源）。 */
async function refreshPreview(toast, { keepIncluded = true } = {}) {
  try {
    const { preview, stale } = await api.importPreview(state.project.id, {
      baseRevId: state.baseRevId,
      content: session.content,
      filename: session.filename,
      options: session.options,
    });
    const old = session.included;
    session.preview = preview;
    session.stale = stale;
    session.included = new Map(
      preview.rows.map((r) => [r.seq, keepIncluded && old.has(r.seq) ? true : r.included]),
    );
    renderPreview(toast);
  } catch (e) {
    toast('预览刷新失败：' + e.message, 'error');
  }
}

function renderPreview(toast) {
  const pv = session.preview;
  const meta = $('#import-meta');

  if (pv.parseError) {
    meta.innerHTML = `<span style="color:var(--danger)">无法解析（${esc(pv.format)}）：${esc(pv.parseError)}</span>`;
    $('#import-track-mapping').innerHTML = '';
    $('#import-column-mapping').innerHTML = '';
    $('#import-table').innerHTML = '';
    $('#import-apply-btn').disabled = true;
    $('#import-count').textContent = '';
    return;
  }
  $('#import-apply-btn').disabled = false;
  const s = pv.summary;
  const staleBanner = session.stale
    ? `<span style="color:var(--warn)">⚠ 项目已有新版本，提交时将按句子逐条合并，冲突由你人工选择</span>`
    : '';
  meta.innerHTML = `
    <span>格式 <b>${esc(pv.format.toUpperCase())}</b></span>
    <span>共 <b>${s.total}</b> 行</span>
    <span style="color:var(--ok)">将新增 <b id="cnt-add">${s.add}</b></span>
    <span style="color:var(--accent)">将修改 <b id="cnt-update">${s.update}</b></span>
    <span style="color:var(--danger)">非法 <b>${s.errors}</b></span>
    <span style="color:var(--warn)">重复/警告 <b>${s.warnings}</b></span>
    ${staleBanner}`;

  renderTrackMapping(toast);
  renderColumnMapping(toast);
  renderTable();
}

function renderTrackMapping(toast) {
  const pv = session.preview;
  const wrap = $('#import-track-mapping');
  wrap.innerHTML = '';

  const tracks = state.snapshot.tracks;
  const trackOptions = (sel) =>
    tracks.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

  // 单轨格式（SRT 等）：选择导入到哪条轨
  if (!pv.trackSources.length) {
    const row = document.createElement('div');
    row.className = 'map-row';
    row.innerHTML = `<span>导入到轨道</span>
      <select id="default-track">${trackOptions(session.options.defaultTrackId)}</select>`;
    row.querySelector('#default-track').addEventListener('change', (e) => {
      session.options.defaultTrackId = e.target.value;
      refreshPreview(toast);
    });
    wrap.appendChild(row);
    return;
  }

  // 多轨文件：逐条把"文件中的轨道名"映射为现有轨/新建
  for (const src of pv.trackSources) {
    const row = document.createElement('div');
    row.className = 'map-row';
    const isNew = src.status === 'new';
    row.innerHTML = `<span>${esc(src.name)}</span> →
      <select data-src="${esc(src.name)}">
        ${trackOptions(isNew ? '' : src.target)}
        <option value="__new__" ${isNew ? 'selected' : ''}>➕ 新建同名轨道</option>
      </select>`;
    row.querySelector('select').addEventListener('change', (e) => {
      session.options.trackMap[src.name] = e.target.value;
      if (e.target.value === '__new__') session.options.createMissingTracks = true;
      refreshPreview(toast);
    });
    wrap.appendChild(row);
  }
}

function renderColumnMapping(toast) {
  const pv = session.preview;
  const wrap = $('#import-column-mapping');
  wrap.innerHTML = '';
  if (!pv.columns || !pv.columns.length) return; // SRT 无列映射

  const fields = [
    ['start', '开始时间'],
    ['end', '结束时间'],
    ['text', '文本'],
    ['track', '轨道（可无）'],
  ];
  const row = document.createElement('div');
  row.className = 'map-row';
  row.innerHTML = '<span>字段映射</span>' + fields.map(([key, label]) => {
    const cur = pv.mapping?.[key];
    const opts = pv.columns
      .map((c) => `<option value="${esc(c.key)}" ${String(cur) === String(c.key) ? 'selected' : ''}>${esc(c.name)}</option>`)
      .join('');
    return `<label>${label}
      <select data-field="${key}"><option value="">— 未映射 —</option>${opts}</select></label>`;
  }).join('');
  row.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const f = sel.dataset.field;
      const v = sel.value;
      session.options.mapping = { ...(session.options.mapping || {}), [f]: v === '' ? undefined : Number.isNaN(Number(v)) ? v : Number(v) };
      for (const k of Object.keys(session.options.mapping)) if (session.options.mapping[k] === undefined) delete session.options.mapping[k];
      refreshPreview(toast);
    });
  });
  wrap.appendChild(row);
}

function renderTable() {
  const pv = session.preview;
  const table = $('#import-table');
  table.innerHTML = `
    <thead><tr>
      <th></th><th>#</th><th>轨道</th><th>开始</th><th>结束</th><th>文本</th><th>处理</th><th>提示</th>
    </tr></thead><tbody></tbody>`;
  const body = table.querySelector('tbody');

  for (const r of pv.rows) {
    const tr = document.createElement('tr');
    const included = session.included.has(r.seq);
    tr.className = included ? 'row-included' : r.issues.some((i) => i.severity === 'error')
      ? 'row-error'
      : r.issues.length
        ? 'row-warning'
        : '';
    const errors = r.issues.filter((i) => i.severity === 'error');
    const warnings = r.issues.filter((i) => i.severity === 'warning');
    const issueHtml = [...errors, ...warnings]
      .map((i) => `<div class="${i.severity === 'error' ? 'imp-issue' : 'imp-issue warn'}">${esc(i.message)}</div>`)
      .join('');
    const trackName = r.trackSource || state.snapshot.tracks.find((t) => t.id === r.trackId)?.name || '—';
    const actionLabel = !included
      ? '不导入'
      : r.action === 'update' ? `修改 ${r.targetCueId}` : '新增';
    tr.innerHTML = `
      <td><input type="checkbox" ${included ? 'checked' : ''} ${!r.editable ? 'disabled' : ''} /></td>
      <td>${r.seq}</td>
      <td>${esc(trackName)}</td>
      <td class="imp-time">${r.startMs == null ? esc(r.startRaw) : msToSrt(r.startMs)}</td>
      <td class="imp-time">${r.endMs == null ? esc(r.endRaw) : msToSrt(r.endMs)}</td>
      <td class="imp-text">${esc(r.text)}</td>
      <td class="imp-action">${actionLabel}</td>
      <td>${issueHtml}</td>`;
    const cb = tr.querySelector('input[type=checkbox]');
    cb?.addEventListener('change', () => {
      if (cb.checked) session.included.set(r.seq, true);
      else session.included.delete(r.seq);
      renderTable();
      updateCounts();
    });
    body.appendChild(tr);
  }
  updateCounts();
}

function bulkSelect(predicate) {
  const pv = session.preview;
  session.included = new Map(pv.rows.filter(predicate).map((r) => [r.seq, true]));
  renderTable();
}

function updateCounts() {
  let add = 0, update = 0;
  for (const r of session.preview.rows) {
    if (!session.included.has(r.seq)) continue;
    if (r.action === 'update') update++; else add++;
  }
  const ca = document.querySelector('#cnt-add');
  if (ca) ca.textContent = add;
  const cu = document.querySelector('#cnt-update');
  if (cu) cu.textContent = update;
  const n = add + update;
  $('#import-count').textContent = n ? `将应用 ${n} 条（新增 ${add} / 修改 ${update}）` : '没有将应用的条目';
  $('#import-apply-btn').disabled = n === 0 || Boolean(session.preview.parseError);
}

async function applyImport({ onCommitted, getAuthor, toast }) {
  const included = [...session.included.keys()];
  if (!included.length) { toast('没有勾选任何条目', 'error'); return; }
  if (state.dirty && !confirm('你有未保存的本地修改。导入基于服务器上的已保存版本，提交后本地未保存修改会被覆盖。\n建议先取消并保存，确定仍要现在导入吗？')) {
    return;
  }
  const btn = $('#import-apply-btn');
  btn.disabled = true;
  try {
    const result = await api.importCommit(state.project.id, {
      baseRevId: state.baseRevId,
      content: session.content,
      filename: session.filename,
      options: session.options,
      included,
      author: getAuthor(),
    });
    closeModal();
    onCommitted(result.revision);
    const r = result.report;
    toast(`导入完成：新增 ${r.added}，修改 ${r.updated}，跳过 ${r.skipped}（审计可查）`, 'ok');
  } catch (e) {
    btn.disabled = false;
    if (e.status === 409 && e.data?.status === 'conflict') {
      await handleImportConflict(e.data, { onCommitted, getAuthor, toast });
    } else {
      toast('导入失败：' + (e.data?.hardErrors?.[0]?.message || e.message), 'error');
    }
  }
}

/** 并发新版本：逐句冲突交给既有冲突弹窗人工裁决，裁决后走 import/resolve。 */
async function handleImportConflict(result, { onCommitted, getAuthor, toast }) {
  const { openConflictModal } = await import('./conflict.js');
  closeModal();
  const report = result.report;
  toast(`项目已有新版本：${result.conflicts.length} 处冲突待裁决，其余句子按句自动合并`, 'error');
  openConflictModal(
    result,
    result.merged,
    async (resolvedSnapshot, confSession) => {
      try {
        const resolved = await api.importResolve(state.project.id, {
          jobId: result.jobId,
          resolvedSnapshot,
          conflictKeys: confSession.conflicts.map((c) => JSON.stringify(c).slice(0, 80)),
          author: getAuthor(),
        });
        onCommitted(resolved.revision);
        toast(`导入已按裁决合并：新增 ${report.added}，修改 ${report.updated}，跳过 ${report.skipped}`, 'ok');
      } catch (e2) {
        if (e2.status === 409 && e2.data?.status === 'conflict') {
          toast('裁决期间又有新提交，需要再次裁决', 'error');
          handleImportConflict(e2.data, { onCommitted, getAuthor, toast });
        } else {
          toast('导入裁决提交失败：' + e2.message, 'error');
        }
      }
    },
    () => toast('已取消导入，项目未改动'),
  );
}

async function undoImport({ onCommitted, getAuthor, toast }) {
  if (state.readOnly) return;
  if (!confirm('撤销最近一次导入？\n导入后被他人修改或删除的句子会保留并在审计中逐条注明原因；撤销本身会生成一个新版本。')) return;
  try {
    const result = await api.importUndo(state.project.id, { author: getAuthor() });
    onCommitted(result.revision);
    const skippedMsg = result.skipped.length ? `，${result.skipped.length} 句因导入后被改动而保留` : '';
    toast(`已撤销导入：回滚 ${result.rolledBack} 句${skippedMsg}`, 'ok');
  } catch (e) {
    if (e.data?.skipped?.length) {
      const reasons = {};
      for (const s of e.data.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
      const labels = { 'changed-after-import': '导入后被修改', 'deleted-after-import': '导入后被删除', 'track-in-use': '轨道仍有句子', 'track-changed': '轨道已被修改' };
      const detail = Object.entries(reasons).map(([k, n]) => `${labels[k] || k} ${n}`).join('，');
      toast(`${e.message}（${detail}；项目未改动）`, 'error');
    } else {
      toast('撤销失败：' + e.message, 'error');
    }
  }
}
