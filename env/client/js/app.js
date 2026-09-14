import { api } from './api.js';
import { state, loadProject, subscribe, setDirty, emit } from './state.js';
import { initTimeline, renderTimeline, scrollToCue } from './timeline.js';
import { initPlayer, seek, pause } from './player.js';
import { initSidebar, renderCueList, renderTrackList, renderTrackToggles, renderHistory, renderAudit } from './sidebar.js';
import { openConflictModal } from './conflict.js';
import { initImportModal } from './importer.js';
import { initQc, closeQcHistory } from './qc.js';
import { initRelease } from './release.js';
import { initDiffReport, refreshDiffReports } from './diffreport.js';
import { initGate, refreshGateTab } from './gate.js';
import { detectViolations } from './rules.js';
import { msToSrt } from './time.js';

const $ = (s) => document.querySelector(s);

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  setTimeout(() => { el.className = 'toast'; }, 3200);
}

function getAuthor() {
  return $('#author-input').value.trim() || localStorage.getItem('author') || '匿名';
}

async function showLanding() {
  $('#app').style.display = 'none';
  $('#landing').style.display = 'block';
  const { projects } = await api.listProjects();
  const list = $('#project-list');
  list.innerHTML = projects.length
    ? ''
    : '<p style="color:var(--muted)">还没有项目，先新建一个。</p>';
  for (const p of projects) {
    const row = document.createElement('div');
    row.className = 'proj-row';
    row.innerHTML = `<span>${escapeHtml(p.name)}</span>
      <span style="color:var(--muted);font-size:12px">${new Date(p.created_at).toLocaleString()}</span>`;
    row.addEventListener('click', () => openProject(p.id));
    list.appendChild(row);
  }
}

async function openProject(id, { revisionId = null } = {}) {
  try {
    const { project, head } = revisionId
      ? await loadAtRevision(id, revisionId)
      : await api.getProject(id).then((r) => ({ project: r.project, head: r.head }));
    loadProject(project, head, { readOnly: Boolean(revisionId), viewingRevId: revisionId });
    $('#landing').style.display = 'none';
    $('#app').style.display = 'block';
    $('#proj-title').textContent = project.name + (revisionId ? '（历史版本只读）' : '');
    renderAll();
  } catch (e) {
    toast('打开失败：' + e.message, 'error');
  }
}

async function loadAtRevision(projectId, revisionId) {
  const [{ project }, { revision }] = await Promise.all([
    api.getProject(projectId),
    api.getRevision(revisionId),
  ]);
  return { project, head: revision };
}

function renderAll() {
  renderTimeline();
  renderCueList();
  renderTrackList();
  renderTrackToggles();
  updateDirtyUI();
}

function updateDirtyUI() {
  $('#dirty-dot').classList.toggle('show', state.dirty);
  const v = state.snapshot ? detectViolations(state.snapshot) : [];
  const overlap = v.filter((x) => x.type === 'overlap').length;
  const mutex = v.filter((x) => x.type === 'mutex').length;
  const reverse = v.filter((x) => x.type === 'reverse').length;
  const parts = [];
  if (overlap) parts.push(`重叠 ${overlap}`);
  if (mutex) parts.push(`互斥冲突 ${mutex}`);
  if (reverse) parts.push(`反向 ${reverse}`);
  $('#save-status').textContent = parts.length ? '⚠ ' + parts.join('，') : '规则检查通过';
  $('#save-status').style.color = parts.length ? 'var(--warn)' : 'var(--ok)';
  $('#save-btn').disabled = state.readOnly;
  $('#import-btn').disabled = state.readOnly;
  $('#undo-import-btn').disabled = state.readOnly;
}

async function doSave() {
  if (state.readOnly) return;
  const author = getAuthor();
  localStorage.setItem('author', author);
  const message = $('#save-message').value.trim();
  $('#save-btn').disabled = true;

  const v = detectViolations(state.snapshot);
  if (v.some((x) => x.type === 'reverse')) {
    toast('存在反向区间（结束 ≤ 开始），请修正后再保存', 'error');
    $('#save-btn').disabled = false;
    return;
  }

  try {
    const result = await api.submit(state.project.id, {
      baseRevId: state.baseRevId,
      snapshot: state.snapshot,
      author,
      message,
    });
    afterCommit(result.revision);
    toast(v.length ? `已保存；仍有 ${v.length} 处规则警告（允许保留）` : '保存成功', v.length ? '' : 'ok');
    $('#save-message').value = '';
  } catch (e) {
    if (e.status === 409 && e.data?.status === 'conflict') {
      enterConflict(e.data, state.snapshot);
    } else if (e.data?.hardErrors) {
      toast(e.message + '：' + e.data.hardErrors[0].message, 'error');
    } else {
      toast('保存失败：' + e.message, 'error');
    }
  } finally {
    $('#save-btn').disabled = false;
  }
}

function afterCommit(revision) {
  // 以服务端提交后的快照为准（合并提交里可能含有他人改动），保证下次保存的 base 正确
  state.snapshot = revision.snapshot;
  state.baseRevId = revision.id;
  state.headRevId = revision.id;
  state.project.head_id = revision.id;
  state.dirty = false;
  state.viewingRevId = null;
  state.readOnly = false;
  $('#proj-title').textContent = state.project.name;
  renderAll();
  renderHistory();
  // 提交会异步触发门禁评估；门禁页若已打开稍后刷新
  if (document.querySelector('.tabs button[data-tab="gate"]').classList.contains('active')) {
    setTimeout(refreshGateTab, 400);
  }
}

function enterConflict(result, mineSnapshot) {
  $('#conflict-banner').classList.add('show');
  $('#conflict-banner').textContent = `检测到并发修改：${result.conflicts.length} 处冲突需要你裁决，其余句子已自动合并。`;
  openConflictModal(
    result,
    mineSnapshot,
    async (resolvedSnapshot, session) => {
      try {
        const resolved = await api.resolve(state.project.id, {
          parentRevId: session.head.id,
          otherRevId: state.baseRevId,
          resolvedSnapshot,
          conflictKeys: session.conflicts.map((c) => JSON.stringify(c).slice(0, 80)),
          author: getAuthor(),
          message: $('#save-message').value.trim(),
        });
        $('#conflict-banner').classList.remove('show');
        afterCommit(resolved.revision);
        $('#save-message').value = '';
        toast('冲突已按你的选择合并保存', 'ok');
      } catch (e) {
        if (e.status === 409 && e.data?.status === 'conflict') {
          toast('期间又有新提交，需要再次裁决', 'error');
          enterConflict(e.data, resolvedSnapshot);
        } else {
          toast('提交解决结果失败：' + e.message, 'error');
        }
      }
    },
    () => toast('已取消，本地修改保留在编辑区', ''),
  );
}

const handlers = {
  async viewRevision(revId) {
    pause();
    await openProject(state.project.id, { revisionId: revId });
    renderHistory();
  },
  async branchFromViewing() {
    // 以当前历史版本快照为工作副本继续编辑；保存时它与最新 HEAD 三向合并，
    // 生成 parent2 指向该历史版本的 merge 提交，版本关系不丢失。
    if (!state.viewingRevId) return;
    const baseRevId = state.viewingRevId;
    state.baseRevId = baseRevId;
    state.viewingRevId = null;
    state.readOnly = false;
    state.dirty = false;
    $('#proj-title').textContent = state.project.name + `（基于历史版本 ${baseRevId} 编辑）`;
    $('#save-btn').disabled = false;
    renderAll();
    renderHistory();
    toast('已基于该历史版本创建编辑分支，保存时将与最新版本合并', 'ok');
  },
  async backToHead() {
    if (state.dirty && !confirm('放弃当前未保存修改并返回最新版本？')) return;
    await openProject(state.project.id);
    renderHistory();
  },
  refreshHistory: renderHistory,
  refreshAudit: renderAudit,
  // 差异报告「定位」：跳到对应版本并选中句子（发布快照落到其来源版本）
  async locateCue(revId, cueId) {
    pause();
    if (state.viewingRevId !== revId) {
      await openProject(state.project.id, { revisionId: revId });
      renderHistory();
    }
    state.selectedCueId = cueId;
    document.querySelector('.tabs button[data-tab="cues"]').click();
    emit('select');
  },
};
window.appHandlers = handlers;

function bind() {
  $('#new-project-btn').addEventListener('click', async () => {
    const name = $('#new-project-name').value.trim() || '未命名字幕项目';
    const author = $('#landing-author').value.trim() || '匿名';
    localStorage.setItem('author', author);
    const { project } = await api.createProject(name, author);
    await openProject(project.id);
  });
  $('#back-btn').addEventListener('click', async () => {
    if (state.dirty && !confirm('有未保存修改，确定离开？')) return;
    showLanding();
  });
  $('#save-btn').addEventListener('click', doSave);
  $('#author-input').value = localStorage.getItem('author') || '';

  initTimeline();
  initPlayer();
  initSidebar(handlers);
  initImportModal({ onCommitted: afterCommit, getAuthor, toast });
  initQc({
    toast,
    getAuthor,
    refreshHistory: renderHistory,
    onFixed: () => { renderAll(); renderHistory(); },
  });
  initRelease({ toast, getAuthor, refreshAudit: renderAudit, refreshHistory: renderHistory });
  initDiffReport({ toast, getAuthor, refreshAudit: renderAudit, locateCue: handlers.locateCue });
  initGate({ toast, getAuthor, refreshAudit: renderAudit, refreshHistory: renderHistory });
  $('#qc-history-close').addEventListener('click', closeQcHistory);

  subscribe((reason) => {
    if (['drag', 'cue-edit', 'tracks', 'select', 'load'].includes(reason)) {
      renderTimeline();
      updateDirtyUI();
    }
    if (reason === 'select') {
      renderCueList();
      const id = state.selectedCueId;
      if (id) scrollToCue(id);
    }
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

bind();
showLanding();

// 调试用
window.app = { state, seek, msToSrt };
