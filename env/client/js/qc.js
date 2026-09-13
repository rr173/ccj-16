// 交付质检标签页：规则配置 / 质检任务 / 结果处理工作流
import { api } from './api.js';
import { state } from './state.js';
import { msToSrt } from './time.js';

const RULE_LABEL = { duration: '单句时长', cps: '阅读速度', line_chars: '单行字符数', gap: '空白间隔', align: '跨轨对齐误差' };
const SEV_LABEL = { blocker: '阻断', warning: '警告' };
const STATUS_LABEL = { open: '待处理', ignored: '已忽略', fixed: '已修复', stale: '已过期', confirmed: '已确认' };

let ctx = null; // { toast, getAuthor, refreshHistory }
let qcState = {
  defs: null,
  rules: null,        // { '': {...}, '<trackId>': {...} }
  jobs: [],
  activeJobId: null,
  findings: [],
  filters: { trackId: '', severity: '', status: '' },
  pollTimer: null,
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initQc(context) {
  ctx = context;
  document.querySelector('.tabs button[data-tab="qc"]').addEventListener('click', () => {
    refreshQcTab();
  });
  $('#qc-run-btn').addEventListener('click', startJob);
  $('#qc-save-project-rules').addEventListener('click', () => saveRules(''));
  $('#qc-save-track-rules').addEventListener('click', () => saveRules($('#qc-track-select').value));
  $('#qc-track-select').addEventListener('change', renderTrackRulesForm);
  for (const f of ['track', 'severity', 'status']) {
    $(`#qc-filter-${f}`).addEventListener('change', () => {
      qcState.filters = { trackId: $('#qc-filter-track').value, severity: $('#qc-filter-severity').value, status: $('#qc-filter-status').value };
      loadFindings();
    });
  }
  $('#qc-check-all').addEventListener('change', (e) => {
    document.querySelectorAll('.qc-find-check').forEach((c) => { c.checked = e.target.checked; });
  });
  $('#qc-batch-ignore').addEventListener('click', () => batchDecide('ignore'));
  $('#qc-batch-fix').addEventListener('click', () => batchDecide('fix'));
}

export async function refreshQcTab() {
  if (!state.project) return;
  await Promise.all([loadRules(), loadJobs(), loadRevisionOptions()]);
  renderTrackSelect();
}

/* ==================== 规则配置 ==================== */

async function loadRules() {
  const data = await api.qcGetRules(state.project.id);
  qcState.defs = data.defs;
  qcState.rules = data.rules;
  renderRulesForm('#qc-project-rules', '');
  renderTrackRulesForm();
}

function effectiveCfg(trackId, key) {
  const def = qcState.defs[key];
  return qcState.rules?.[trackId]?.[key] || qcState.rules?.['']?.[key]
    || { enabled: true, severity: 'warning', params: { ...def.defaultParams } };
}

function ruleRowHtml(scope, key, cfg) {
  const def = qcState.defs[key];
  const params = def.paramFields.map((f) => {
    if (f.type === 'track') {
      const opts = ['<option value="">（全部轨道对）</option>']
        .concat((state.snapshot?.tracks || []).map((t) => `<option value="${esc(t.id)}" ${cfg.params[f.key] === t.id ? 'selected' : ''}>${esc(t.name)}</option>`));
      return `<label>${esc(f.label)} <select data-scope="${scope}" data-rule="${key}" data-param="${f.key}">${opts.join('')}</select></label>`;
    }
    return `<label>${esc(f.label)} <input type="number" data-scope="${scope}" data-rule="${key}" data-param="${f.key}" value="${cfg.params[f.key]}" style="width:76px" /></label>`;
  }).join(' ');
  return `<div class="qc-rule-row">
    <label title="启用该规则"><input type="checkbox" data-scope="${scope}" data-rule="${key}" data-flag="enabled" ${cfg.enabled ? 'checked' : ''} /></label>
    <b>${esc(RULE_LABEL[key])}</b>
    <select data-scope="${scope}" data-rule="${key}" data-flag="severity">
      <option value="blocker" ${cfg.severity === 'blocker' ? 'selected' : ''}>阻断</option>
      <option value="warning" ${cfg.severity === 'warning' ? 'selected' : ''}>警告</option>
    </select>
    ${params}
  </div>`;
}

function renderRulesForm(wrapSel, scope) {
  const wrap = $(wrapSel);
  if (!wrap || !qcState.defs) return;
  wrap.innerHTML = Object.keys(qcState.defs).map((key) => ruleRowHtml(scope, key, effectiveCfg(scope, key))).join('');
}

function renderTrackSelect() {
  const sel = $('#qc-track-select');
  const tracks = state.snapshot?.tracks || [];
  sel.innerHTML = tracks.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  renderTrackRulesForm();
}

function renderTrackRulesForm() {
  renderRulesForm('#qc-track-rules', $('#qc-track-select').value || '');
}

function collectRules(scope) {
  const rules = {};
  for (const key of Object.keys(qcState.defs)) {
    const enabled = document.querySelector(`input[data-scope="${scope}"][data-rule="${key}"][data-flag="enabled"]`)?.checked ?? true;
    const severity = document.querySelector(`select[data-scope="${scope}"][data-rule="${key}"][data-flag="severity"]`)?.value || 'warning';
    const params = {};
    for (const f of qcState.defs[key].paramFields) {
      const el = document.querySelector(`[data-scope="${scope}"][data-rule="${key}"][data-param="${f.key}"]`);
      params[f.key] = f.type === 'track' ? el.value : Number(el.value);
    }
    rules[key] = { enabled, severity, params };
  }
  return rules;
}

async function saveRules(scope) {
  try {
    await api.qcPutRules(state.project.id, { trackId: scope, rules: collectRules(scope), author: ctx.getAuthor() });
    await loadRules();
    ctx.toast(scope ? '轨道规则已保存（审计留痕）' : '项目规则已保存（审计留痕）', 'ok');
  } catch (e) {
    ctx.toast('规则保存失败：' + e.message, 'error');
  }
}

/* ==================== 质检任务 ==================== */

async function loadRevisionOptions() {
  const { revisions } = await api.listRevisions(state.project.id);
  const sel = $('#qc-rev-select');
  const cur = sel.value;
  sel.innerHTML = revisions.map((r) =>
    `<option value="${r.id}" ${r.id === (cur || state.headRevId) ? 'selected' : ''}>${esc((r.message || r.kind).slice(0, 24))} · ${r.id.slice(0, 8)} · ${new Date(r.created_at).toLocaleString()}</option>`,
  ).join('');
}

async function loadJobs() {
  const { jobs } = await api.qcListJobs(state.project.id);
  qcState.jobs = jobs;
  renderJobs();
  const running = jobs.find((j) => j.status === 'running');
  clearTimeout(qcState.pollTimer);
  if (running) qcState.pollTimer = setTimeout(loadJobs, 800);
}

function renderJobs() {
  const wrap = $('#qc-jobs');
  if (!qcState.jobs.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">还没有质检任务。选择版本后点击「开始质检」。</p>';
    return;
  }
  const statusTag = { running: '<span class="tag">运行中</span>', done: '<span class="tag qc-ok">完成</span>', cancelled: '<span class="tag qc-bad">已取消</span>', failed: '<span class="tag qc-bad">失败</span>' };
  wrap.innerHTML = '';
  for (const j of qcState.jobs) {
    const div = document.createElement('div');
    div.className = 'qc-job' + (j.id === qcState.activeJobId ? ' active' : '');
    const prog = j.status === 'running' ? ` ${j.progress.done || 0}/${j.progress.total || 0}` : '';
    const sum = j.summary ? `阻断 ${j.summary.blocker} · 警告 ${j.summary.warning}` : '';
    div.innerHTML = `
      <div class="row">
        ${statusTag[j.status] || j.status}<b>#${esc(j.id.slice(2, 8))}</b><span>${esc(sum)}${esc(prog)}</span>
        <span style="flex:1"></span>
        ${j.status === 'running' ? '<button class="small-btn danger" data-act="cancel">取消</button>' : ''}
        ${j.status !== 'running' ? '<button class="small-btn" data-act="rerun">重跑</button>' : ''}
        ${j.status === 'done' ? '<button class="small-btn" data-act="view">查看结果</button>' : ''}
      </div>
      <div class="meta">版本 <code>${esc(j.revision_id.slice(0, 10))}</code> · ${esc(j.author)} · ${new Date(j.created_at).toLocaleString()}</div>`;
    div.querySelector('[data-act=cancel]')?.addEventListener('click', async () => {
      await api.qcCancelJob(state.project.id, j.id, ctx.getAuthor());
      ctx.toast('已取消');
      loadJobs();
    });
    div.querySelector('[data-act=rerun]')?.addEventListener('click', async () => {
      await api.qcStartJob(state.project.id, { revisionId: j.revision_id, author: ctx.getAuthor() });
      ctx.toast('已重新发起质检');
      loadJobs();
    });
    div.querySelector('[data-act=view]')?.addEventListener('click', () => {
      qcState.activeJobId = j.id;
      renderJobs();
      loadFindings();
    });
    wrap.appendChild(div);
  }
}

async function startJob() {
  const revisionId = $('#qc-rev-select').value;
  if (!revisionId) return;
  try {
    const r = await api.qcStartJob(state.project.id, { revisionId, author: ctx.getAuthor() });
    ctx.toast(r.deduplicated ? '相同任务正在运行，已复用' : '质检任务已启动', 'ok');
    qcState.activeJobId = r.job.id;
    await loadJobs();
  } catch (e) {
    ctx.toast('发起失败：' + e.message, 'error');
  }
}

/* ==================== 质检结果 ==================== */

async function loadFindings() {
  const job = qcState.jobs.find((j) => j.id === qcState.activeJobId);
  const panel = $('#qc-findings-panel');
  if (!job || job.status !== 'done') {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  // 结果基于旧版本时提示：处理决定只接受当前 HEAD，过期决定需重新选择
  const stale = job.revision_id !== state.headRevId;
  $('#qc-stale-banner').style.display = stale ? 'block' : 'none';

  const trackSel = $('#qc-filter-track');
  const curTrack = trackSel.value;
  const { revision } = await api.getRevision(job.revision_id);
  trackSel.innerHTML = '<option value="">全部轨道</option>' + revision.snapshot.tracks.map((t) =>
    `<option value="${esc(t.id)}" ${t.id === curTrack ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

  const { findings } = await api.qcFindings(state.project.id, job.id, qcState.filters);
  qcState.findings = findings;
  renderFindings(revision.snapshot);
}

function renderFindings(snap) {
  const wrap = $('#qc-findings');
  const trackName = (id) => snap.tracks.find((t) => t.id === id)?.name || id;
  $('#qc-findings-count').textContent = `共 ${qcState.findings.length} 条`;
  if (!qcState.findings.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">当前筛选下没有结果。</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const f of qcState.findings) {
    const div = document.createElement('div');
    div.className = `qc-finding sev-${f.severity} st-${f.status}`;
    const canDecide = ['open', 'stale'].includes(f.status);
    const canFix = canDecide && f.suggestion?.safe;
    div.innerHTML = `
      <div class="row">
        <input type="checkbox" class="qc-find-check" data-id="${f.id}" />
        <span class="tag ${f.severity === 'blocker' ? 'qc-bad' : 'qc-warn'}">${SEV_LABEL[f.severity]}</span>
        <b>${esc(RULE_LABEL[f.rule_key] || f.rule_key)}</b>
        <span class="tag">${esc(trackName(f.track_id))}</span>
        <code>${esc(f.cue_id)}</code>
        <span style="flex:1"></span>
        <span class="tag qc-st-${f.status}">${STATUS_LABEL[f.status]}</span>
      </div>
      <div class="qc-evidence">${esc(f.evidence)}</div>
      <div class="meta">实际值 <b>${esc(f.actual.value)}${esc(f.actual.unit || '')}</b> / 限制 ${esc(f.actual.limit)}${esc(f.actual.unit || '')}
        · 句子「${esc((f.basis.text || '').slice(0, 30))}」 ${msToSrt(f.basis.start)} → ${msToSrt(f.basis.end)}</div>
      ${f.suggestion ? `<div class="qc-suggestion">建议：${esc(f.suggestion.describe)}${f.suggestion.safe ? ' <span class="tag qc-ok">可自动修复</span>' : ' <span class="tag">需人工</span>'}</div>` : ''}
      ${f.decide_reason ? `<div class="meta">处理理由：${esc(f.decide_reason)}（${esc(f.decided_by || '')}）</div>` : ''}
      <div class="row" style="margin-top:5px">
        ${canDecide ? '<button class="small-btn" data-act="ignore">忽略…</button>' : ''}
        ${canFix ? '<button class="small-btn" data-act="fix">接受建议修复</button>' : ''}
        <button class="small-btn" data-act="history">处理历史</button>
      </div>`;
    div.querySelector('[data-act=ignore]')?.addEventListener('click', () => decide([f.id], 'ignore'));
    div.querySelector('[data-act=fix]')?.addEventListener('click', () => decide([f.id], 'fix'));
    div.querySelector('[data-act=history]')?.addEventListener('click', () => showHistory(f));
    wrap.appendChild(div);
  }
}

function checkedIds() {
  return [...document.querySelectorAll('.qc-find-check:checked')].map((c) => c.dataset.id);
}

async function batchDecide(kind) {
  const ids = checkedIds();
  if (!ids.length) return ctx.toast('先勾选结果', 'error');
  await decide(ids, kind);
}

async function decide(ids, kind) {
  let reason = '';
  if (kind === 'ignore') {
    reason = prompt(`忽略 ${ids.length} 条结果的理由（写入审计）：`) || '';
    if (!reason.trim()) return ctx.toast('已取消：忽略需要填写理由');
  } else if (!confirm(`对 ${ids.length} 条结果应用自动修复？（只作用于明确安全项，修复前后都会检查时间轴约束）`)) {
    return;
  }
  try {
    if (kind === 'ignore') {
      await api.qcDecide(state.project.id, { findingIds: ids, action: 'ignore', reason, baseRevId: state.headRevId, author: ctx.getAuthor() });
      ctx.toast(`已忽略 ${ids.length} 条`, 'ok');
    } else {
      const r = await api.qcFix(state.project.id, { findingIds: ids, baseRevId: state.headRevId, reason, author: ctx.getAuthor() });
      ctx.toast(`已修复 ${r.fixed} 处并保存为新版本`, 'ok');
      // 修复产生了新版本：刷新编辑区与版本历史
      state.headRevId = r.revision.id;
      state.project.head_id = r.revision.id;
      if (!state.dirty && !state.viewingRevId) {
        state.snapshot = JSON.parse(JSON.stringify(r.revision.snapshot));
        state.baseRevId = r.revision.id;
      }
      ctx.refreshHistory?.();
      ctx.onFixed?.();
    }
    await loadFindings();
  } catch (e) {
    if (e.status === 409 && e.data?.stale) {
      ctx.toast('项目已有新版本，基于旧版本的处理已过期，请刷新后重新选择', 'error');
    } else if (e.data?.failures) {
      ctx.toast('部分不可修复：' + e.data.failures.map((f) => f.reason).join('；'), 'error');
    } else {
      ctx.toast('操作失败：' + e.message, 'error');
    }
    await loadFindings();
  }
}

async function showHistory(f) {
  const [{ events }, { history }] = await Promise.all([
    api.qcFinding(state.project.id, f.id),
    api.qcCueHistory(state.project.id, f.cue_id),
  ]);
  const actLabel = { found: '发现', ignore: '忽略', fix: '修复', stale: '过期', confirm: '发布确认' };
  const fmt = (e) => `<div class="qc-event"><b>${actLabel[e.action] || e.action}</b> · ${esc(e.actor)} · ${new Date(e.created_at).toLocaleString()}${e.reason ? `<br/>理由：${esc(e.reason)}` : ''}${e.revision_id ? `<br/>关联版本 <code>${esc(e.revision_id.slice(0, 10))}</code>` : ''}</div>`;
  $('#qc-history-title').textContent = `句子 ${f.cue_id} 的质检历史`;
  $('#qc-history-body').innerHTML =
    `<div class="pane-section-title">本条结果（${RULE_LABEL[f.rule_key]}）</div>` + events.map(fmt).join('') +
    `<div class="pane-section-title">该句全部 ${history.length} 条质检记录</div>` +
    history.map((h) => `<div class="qc-event"><b>${esc(RULE_LABEL[h.rule_key] || h.rule_key)}</b> · ${STATUS_LABEL[h.status]} · 任务 #${esc(h.job_id.slice(2, 8))}${h.events.map(fmt).join('')}</div>`).join('');
  $('#qc-history-modal').classList.add('show');
}

export function closeQcHistory() {
  $('#qc-history-modal').classList.remove('show');
}
