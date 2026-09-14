import { state, subscribe, updateCue, addCue, deleteCue, addTrack, setDirty, emit } from './state.js';
import { violatedCueIds } from './rules.js';
import { msToSrt, parseTime } from './time.js';
import { api } from './api.js';
import { openCreateOnCue, cueDiscMap, refreshDiscussions } from './discussion.js';

export function initSidebar(handlers) {
  document.getElementById('add-cue-btn').addEventListener('click', () => {
    addCue(state.snapshot.tracks[0]?.id);
  });
  document.getElementById('add-track-btn').addEventListener('click', addTrack);

  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
      if (tab === 'history') handlers.refreshHistory?.();
      if (tab === 'audit') handlers.refreshAudit?.();
    });
  });

  document.getElementById('branch-edit-btn').addEventListener('click', handlers.branchFromViewing);
  document.getElementById('back-head-btn').addEventListener('click', handlers.backToHead);

  subscribe((reason) => {
    if (['cue-edit', 'drag', 'select', 'load', 'tracks'].includes(reason)) renderCueList();
    if (['tracks', 'load'].includes(reason)) {
      renderTrackList();
      renderTrackToggles();
    }
    if (reason === 'load') refreshDiscussions();
  });
  // 讨论数据到达后重渲染句子列表，显示每句未解决徽标（不重复请求）；
  // 用户正在句子输入框中编辑时不打断（提交/切项目后随 load 自然重绘）
  window.addEventListener('discussions-loaded', () => {
    const el = document.activeElement;
    if (el?.closest('.cue-item')) return;
    renderCueList();
  });
}

function cueBadges(cue, vMap) {
  const types = vMap.get(cue.id);
  if (!types) return '';
  const label = { reverse: '反向', overlap: '重叠', mutex: '互斥' };
  return [...types].map((t) => `<span class="tag ${t}">${label[t]}</span>`).join(' ');
}

export function renderCueList() {
  const wrap = document.getElementById('cue-list');
  const snap = state.snapshot;
  const vMap = violatedCueIds(snap);
  const discMap = cueDiscMap();
  const cues = [...snap.cues].sort((a, b) => a.start - b.start);

  wrap.innerHTML = '';
  for (const cue of cues) {
    const track = snap.tracks.find((t) => t.id === cue.trackId);
    const item = document.createElement('div');
    item.className = 'cue-item';
    if (cue.id === state.selectedCueId) item.classList.add('selected');
    const types = vMap.get(cue.id);
    if (types?.has('reverse')) item.classList.add('error');
    else if (types) item.classList.add('warn');

    item.innerHTML = `
      <div class="row">
        <span class="dot" style="width:9px;height:9px;border-radius:50%;background:${track?.color || '#888'}"></span>
        <input class="time-input" value="${msToSrt(cue.start)}" data-f="start" ${cue.locked ? 'disabled' : ''} />
        <span>→</span>
        <input class="time-input" value="${msToSrt(cue.end)}" data-f="end" ${cue.locked ? 'disabled' : ''} />
        ${cueBadges(cue, vMap)}
        <span style="flex:1"></span>
        <button class="small-btn" data-act="disc" title="在该句上发起/查看讨论">💬${discMap.get(cue.id) ? `<span class="disc-count">${discMap.get(cue.id)}</span>` : ''}</button>
        <button class="small-btn" data-act="lock">${cue.locked ? '🔒' : '🔓'}</button>
        <button class="small-btn danger" data-act="del" ${cue.locked ? 'disabled' : ''}>删</button>
      </div>
      <textarea data-f="text" ${cue.locked ? 'disabled' : ''}></textarea>
    `;
    item.querySelector('textarea').value = cue.text;

    item.addEventListener('click', (e) => {
      state.selectedCueId = cue.id;
      emit('select');
    });

    item.querySelectorAll('input.time-input').forEach((inp) => {
      inp.addEventListener('change', () => {
        try {
          const f = inp.dataset.f;
          const v = parseTime(inp.value);
          const patch = { [f]: v };
          if (f === 'start' && v >= cue.end) patch.end = v + 100;
          if (f === 'end' && v <= cue.start) return;
          updateCue(cue.id, patch);
        } catch (err) {
          inp.value = msToSrt(cue[inp.dataset.f]);
        }
      });
    });
    item.querySelector('textarea').addEventListener('input', (e) => {
      updateCue(cue.id, { text: e.target.value });
    });
    item.querySelector('[data-act=disc]').addEventListener('click', (e) => {
      e.stopPropagation();
      openCreateOnCue(cue.id);
    });
    item.querySelector('[data-act=lock]').addEventListener('click', (e) => {
      e.stopPropagation();
      updateCue(cue.id, { locked: !cue.locked });
    });
    item.querySelector('[data-act=del]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCue(cue.id);
    });
    wrap.appendChild(item);
  }
}

export function renderTrackList() {
  const wrap = document.getElementById('track-list');
  wrap.innerHTML = '';
  for (const t of state.snapshot.tracks) {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.innerHTML = `
      <input data-f="name" value="${escapeAttr(t.name)}" />
      <div class="row">
        <input type="color" data-f="color" value="${t.color}" />
        <input data-f="mutexGroup" value="${t.mutexGroup || ''}" placeholder="互斥组名（相同组互斥）" style="flex:1" />
      </div>
    `;
    row.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const f = inp.dataset.f;
        t[f] = f === 'mutexGroup' ? (inp.value.trim() || null) : inp.value;
        setDirty();
        emit('tracks');
      });
    });
    wrap.appendChild(row);
  }
}

export function renderTrackToggles() {
  const wrap = document.getElementById('track-toggles');
  wrap.innerHTML = '';
  for (const t of state.snapshot.tracks) {
    const chip = document.createElement('span');
    chip.className = 'track-chip' + (state.hiddenTracks.has(t.id) ? ' off' : '');
    chip.innerHTML = `<span class="dot" style="background:${t.color}"></span>${escapeHtml(t.name)}${t.mutexGroup ? ' · ' + t.mutexGroup : ''}`;
    chip.addEventListener('click', () => {
      // 切换轨道只改变显示，播放时刻保持不变
      state.hiddenTracks.has(t.id) ? state.hiddenTracks.delete(t.id) : state.hiddenTracks.add(t.id);
      renderTrackToggles();
      emit('tracks');
    });
    wrap.appendChild(chip);
  }
}

export async function renderHistory() {
  const wrap = document.getElementById('rev-list');
  const banner = document.getElementById('viewing-banner');
  banner.style.display = state.viewingRevId ? 'block' : 'none';
  wrap.innerHTML = '加载中…';
  const [{ revisions }, { jobs }, { releases }] = await Promise.all([
    api.listRevisions(state.project.id),
    api.qcListJobs(state.project.id),
    api.releaseList(state.project.id),
  ]);
  // 版本 → 质检任务 / 发布快照 徽标（质检、修复、发布、撤销都可从版本历史追溯）
  const qcByRev = new Map();
  for (const j of jobs) {
    if (!qcByRev.has(j.revision_id)) qcByRev.set(j.revision_id, []);
    qcByRev.get(j.revision_id).push(j);
  }
  const relByRev = new Map();
  for (const r of releases) {
    if (!relByRev.has(r.revision_id)) relByRev.set(r.revision_id, []);
    relByRev.get(r.revision_id).push(r);
  }
  wrap.innerHTML = '';
  for (const r of revisions) {
    const div = document.createElement('div');
    div.className = 'rev-item';
    if (r.kind === 'merge') div.classList.add('merge');
    if (r.kind === 'import') div.classList.add('import-rev');
    if (r.kind === 'rollback') div.classList.add('rollback-rev');
    if (r.kind === 'qcfix') div.classList.add('qcfix-rev');
    if (r.id === state.headRevId && !state.viewingRevId) div.classList.add('current');
    if (r.id === state.viewingRevId) div.classList.add('current');
    const kindLabel = { create: '创建', edit: '编辑', merge: '合并', import: '导入', rollback: '回滚', qcfix: '质检修复' }[r.kind];
    let extra = '';
    if (r.kind === 'import' && r.meta?.kind === 'import') {
      const m = r.meta.imported;
      extra = `<br/>新增 ${m.addedCueIds.length} · 修改 ${m.updated.length} · 跳过 ${r.meta.skips?.length || 0}${r.meta.merged ? ' · 含并发合并' : ''}`;
    }
    if (r.kind === 'rollback' && r.meta?.kind === 'rollback') {
      extra = `<br/>回滚 ${r.meta.rolledCueIds.length} 句 · 跳过 ${r.meta.skipped?.length || 0} 句`;
    }
    if (r.kind === 'qcfix' && r.meta?.kind === 'qcfix') {
      extra = `<br/>自动修复 ${r.meta.findingIds?.length || 0} 处`;
    }
    const qcBadges = (qcByRev.get(r.id) || [])
      .map((j) => `<span class="tag">🔍质检#${j.id.slice(2, 8)}${j.status === 'done' && j.summary ? ` 阻${j.summary.blocker}/警${j.summary.warning}` : ''}</span>`)
      .join(' ');
    const relBadges = (relByRev.get(r.id) || [])
      .map((x) => `<span class="tag ${x.status === 'published' ? 'qc-ok' : 'qc-bad'}">📦${x.label}${x.status === 'withdrawn' ? '（已撤销）' : ''}</span>`)
      .join(' ');
    div.innerHTML = `
      <div><b>${escapeHtml(r.message || '（无说明）')}</b></div>
      <div class="meta">
        ${kindLabel} · ${escapeHtml(r.author)} · ${new Date(r.created_at).toLocaleString()}<br/>
        <code>${r.id}</code>${extra}${r.parent2_id ? '<br/>↳ 合并自分支 <code>' + r.parent2_id + '</code>' : ''}
        ${qcBadges || relBadges ? '<br/>' + qcBadges + ' ' + relBadges : ''}
      </div>
    `;
    div.addEventListener('click', () => window.appHandlers.viewRevision(r.id));
    wrap.appendChild(div);
  }
}

export async function renderAudit() {
  const wrap = document.getElementById('audit-list');
  wrap.innerHTML = '加载中…';
  const { audit } = await api.listAudit(state.project.id);
  wrap.innerHTML = '';
  if (!audit.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">暂无审计记录。</p>';
    return;
  }
  for (const a of audit) {
    const div = document.createElement('div');
    div.className = 'audit-item';
    const actionLabel = {
      add: '新增', edit: '修改', delete: '删除', resolve: '冲突裁决', restore: '恢复', skip: '跳过', rollback: '回滚',
      'qc-rule': '质检规则', 'qc-run': '发起质检', 'qc-done': '质检完成', 'qc-cancel': '取消质检',
      'qc-ignore': '质检忽略', 'qc-fix': '质检修复', 'qc-stale': '处理过期', 'qc-confirm': '发布确认',
      'relreq-submit': '提交发布申请', 'relreq-approve': '批准发布申请', 'relreq-reject': '驳回发布申请',
      'relreq-publish': '申请生成发布', 'relreq-invalidate': '申请自动失效',
      publish: '发布快照', withdraw: '撤销发布',
      'diff-create': '生成差异报告', 'diff-view': '查看差异报告', 'diff-export': '导出差异报告', 'diff-delete': '删除差异报告',
      'gatesub-create': '创建门禁订阅', 'gatesub-update': '修改门禁订阅',
      'gatesub-pause': '暂停门禁订阅', 'gatesub-resume': '恢复门禁订阅',
      'gateeval-queue': '评估入队', 'gateeval-start': '评估开始', 'gateeval-done': '评估完成',
      'gateeval-fail': '评估失败', 'gateeval-retry': '评估重试',
      'gate-block': '门禁拦截', 'gateex-create': '创建豁免', 'gateex-revoke': '撤销豁免', 'gatenotify': '门禁通知',
      'disc-create': '创建讨论', 'disc-resolve': '解决讨论', 'disc-reopen': '重新打开讨论',
      'disc-relocate': '重新定位讨论', 'disc-auto-follow': '讨论自动跟随', 'disc-orphan': '讨论待重新定位',
    }[a.action] || a.action;
    div.innerHTML = `
      <div><span class="field">${escapeHtml(a.field)}</span> · ${actionLabel}</div>
      ${a.old_value != null ? `<div class="vals"><span class="old">- ${escapeHtml(short(a.old_value))}</span></div>` : ''}
      ${a.new_value != null ? `<div class="vals"><span class="new">+ ${escapeHtml(short(a.new_value))}</span></div>` : ''}
      <div class="meta">${escapeHtml(a.author)} · ${new Date(a.created_at).toLocaleString()} · 于「${escapeHtml(a.revision_message || '')}」</div>
    `;
    wrap.appendChild(div);
  }
}

function short(v) {
  const s = String(v);
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
