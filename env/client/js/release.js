// 发布标签页：预检 → 提交发布申请（绑定版本+预检结果）→ 审核（批准/驳回）→ 批准后生成发布快照
// 多阶段会签：项目负责人可配置有顺序的审批阶段（角色/最少同意人数/驳回重提/有效期）；
// 申请冻结当时策略与门禁事件，逐阶段会签，全部阶段通过才批准；阶段超时可由负责人重开；
// 版本/预检/门禁事件/策略变化申请自动失效；驳回后重新提交生成新申请版本并保留关联。
import { api } from './api.js';
import { state } from './state.js';
import { msToSrt } from './time.js';

let ctx = null;
const rel = {
  preflight: null, checked: new Set(), releases: [], requests: [], revisions: [],
  gateStatus: null, policy: null, policyDraft: null, detailFor: null,
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dt = (t) => (t ? new Date(t).toLocaleString() : '—');

const REQ_STATUS = {
  pending: { label: '待处理', cls: 'qc-warn' },
  approved: { label: '已批准', cls: 'qc-ok' },
  rejected: { label: '已驳回', cls: 'qc-bad' },
  invalidated: { label: '已失效', cls: 'qc-bad' },
  expired: { label: '已过期', cls: 'qc-warn' },
  published: { label: '已发布', cls: 'qc-ok' },
};
const INVALID_TEXT = {
  'new-revision': '该版本之后项目产生了新提交',
  'blockers-changed': '阻断问题重新出现或处理情况变化',
  'warnings-changed': '警告确认项发生变化',
  'hard-error': '时间轴硬约束不再通过',
  'qc-changed': '质检结果发生变化（任务/处理状态与申请时不一致）',
  'policy-changed': '审批策略发生变化',
  'gate-changed': '门禁评估事件发生变化',
};
const STAGE_STATUS = {
  waiting: { label: '等待', cls: '' },
  active: { label: '会签中', cls: 'active' },
  approved: { label: '已通过', cls: 'approved' },
  rejected: { label: '已驳回', cls: 'rejected' },
  expired: { label: '已过期', cls: 'expired' },
};
const ttlText = (ms) => {
  if (!ms) return '不限期';
  if (ms % 86400000 === 0) return `${ms / 86400000} 天`;
  if (ms % 3600000 === 0) return `${ms / 3600000} 小时`;
  return `${Math.round(ms / 60000)} 分钟`;
};

export function initRelease(context) {
  ctx = context;
  document.querySelector('.tabs button[data-tab="release"]').addEventListener('click', refreshReleaseTab);
  $('#rel-rev-select').addEventListener('change', () => {
    rel.preflight = null;
    $('#rel-preflight').innerHTML = '<p style="color:var(--muted)">选择版本后点击「预检」。</p>';
    renderRequests();
    updateApplyButton();
  });
  $('#rel-check-btn').addEventListener('click', runPreflight);
  $('#rel-apply-btn').addEventListener('click', onMainButton);
  $('#rel-policy-add').addEventListener('click', () => {
    rel.policyDraft.push({ role: '', minApprovals: 1, allowResubmit: true, ttlHours: 0 });
    renderPolicyEditor();
  });
  $('#rel-policy-save').addEventListener('click', savePolicy);
  $('#rel-policy-clear').addEventListener('click', clearPolicy);
  $('#rel-policy-cancel').addEventListener('click', () => {
    rel.policyDraft = null;
    $('#rel-policy-editor').style.display = 'none';
    renderPolicy();
  });
}

export async function refreshReleaseTab() {
  if (!state.project) return;
  const [{ revisions }, { releases }, { requests }, { policy }] = await Promise.all([
    api.listRevisions(state.project.id),
    api.releaseList(state.project.id),
    api.releaseRequestList(state.project.id), // 服务端读取时复检并自动失效/过期扫描
    api.approvalPolicyGet(state.project.id),
  ]);
  rel.revisions = revisions;
  rel.releases = releases;
  rel.requests = requests;
  rel.policy = policy;
  const sel = $('#rel-rev-select');
  const keep = sel.value;
  sel.innerHTML = revisions.map((r) =>
    `<option value="${r.id}" ${r.id === keep || (!keep && r.id === state.headRevId) ? 'selected' : ''}>${esc((r.message || r.kind).slice(0, 24))} · ${r.id.slice(0, 8)}</option>`,
  ).join('');
  rel.preflight = null;
  $('#rel-preflight').innerHTML = '<p style="color:var(--muted)">选择版本后点击「预检」。</p>';
  $('#rel-message').value = '';
  renderPolicy();
  renderRequests();
  renderReleases();
  updateApplyButton();
}

/* ==================== 审批策略配置 ==================== */

function renderPolicy() {
  const wrap = $('#rel-policy');
  const p = rel.policy;
  if (!p) {
    wrap.innerHTML = `<div class="rel-policy-summary">未配置审批策略：发布申请为<b>单步审批</b>（一名审核人批准即通过）。
      <button class="small-btn" id="rel-policy-edit">配置多阶段会签…</button></div>`;
  } else {
    const stages = p.stages.map((s, i) =>
      `${i + 1}．<b>${esc(s.role)}</b>（≥${s.minApprovals} 人同意 · ${ttlText(s.ttlMs)}${s.allowResubmit ? '' : ' · 驳回后不可重提'}）`,
    ).join(' → ');
    wrap.innerHTML = `<div class="rel-policy-summary">当前策略：${stages}
      <div class="meta">${esc(p.updatedBy)} 更新于 ${dt(p.updatedAt)} · 提交申请时冻结；此后修改策略会使进行中的申请失效
      <button class="small-btn" id="rel-policy-edit">修改策略…</button></div></div>`;
  }
  wrap.querySelector('#rel-policy-edit').addEventListener('click', openPolicyEditor);
}

function openPolicyEditor() {
  rel.policyDraft = (rel.policy?.stages || []).map((s) => ({
    role: s.role, minApprovals: s.minApprovals, allowResubmit: s.allowResubmit, ttlHours: s.ttlMs / 3600000,
  }));
  if (!rel.policyDraft.length) {
    rel.policyDraft.push({ role: '', minApprovals: 1, allowResubmit: true, ttlHours: 0 });
  }
  $('#rel-policy-editor').style.display = 'block';
  renderPolicyEditor();
}

function renderPolicyEditor() {
  const wrap = $('#rel-policy-stages');
  wrap.innerHTML = rel.policyDraft.map((s, i) => `
    <div class="stage-row" data-i="${i}">
      <span class="stage-no">阶段 ${i + 1}</span>
      <input type="text" data-k="role" placeholder="审核角色（如 终审）" value="${esc(s.role)}" />
      <label>最少同意 <input type="number" data-k="minApprovals" min="1" max="99" value="${s.minApprovals}" /> 人</label>
      <label>有效期 <input type="number" data-k="ttlHours" min="0" max="2160" step="0.5" value="${s.ttlHours}" />小时(0=不限)</label>
      <label><input type="checkbox" data-k="allowResubmit" ${s.allowResubmit ? 'checked' : ''} /> 允许驳回后重新提交</label>
      <button class="small-btn danger" data-del="${i}">删除</button>
    </div>`).join('') || '<p style="color:var(--muted);font-size:12px">尚无阶段，点击「+ 添加阶段」。</p>';
  wrap.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const row = inp.closest('.stage-row');
      const s = rel.policyDraft[Number(row.dataset.i)];
      const k = inp.dataset.k;
      if (k === 'allowResubmit') s.allowResubmit = inp.checked;
      else if (k === 'minApprovals') s.minApprovals = Math.max(1, Math.min(99, Math.round(Number(inp.value) || 1)));
      else if (k === 'ttlHours') s.ttlHours = Math.max(0, Number(inp.value) || 0);
      else s.role = inp.value;
    });
  });
  wrap.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      rel.policyDraft.splice(Number(btn.dataset.del), 1);
      renderPolicyEditor();
    });
  });
}

async function savePolicy() {
  // 先收集未失焦的输入
  document.querySelectorAll('#rel-policy-stages .stage-row').forEach((row) => {
    const s = rel.policyDraft[Number(row.dataset.i)];
    s.role = row.querySelector('[data-k=role]').value;
    s.minApprovals = Math.max(1, Math.min(99, Math.round(Number(row.querySelector('[data-k=minApprovals]').value) || 1)));
    s.ttlHours = Math.max(0, Number(row.querySelector('[data-k=ttlHours]').value) || 0);
    s.allowResubmit = row.querySelector('[data-k=allowResubmit]').checked;
  });
  const stages = rel.policyDraft.map((s) => ({
    role: s.role.trim(), minApprovals: s.minApprovals, allowResubmit: s.allowResubmit,
    ttlMs: Math.round(s.ttlHours * 3600000),
  }));
  if (!stages.length) return ctx.toast('至少保留一个阶段；如需单步审批请用「清除策略」', 'error');
  if (stages.some((s) => !s.role)) return ctx.toast('每个阶段都要填写审核角色', 'error');
  try {
    const { policy } = await api.approvalPolicyPut(state.project.id, { stages, author: ctx.getAuthor() });
    rel.policy = policy;
    rel.policyDraft = null;
    $('#rel-policy-editor').style.display = 'none';
    ctx.toast('审批策略已保存；进行中的申请若冻结策略不一致已自动失效', 'ok');
    ctx.refreshAudit?.();
    await refreshRequestsOnly();
    renderPolicy();
  } catch (e) {
    ctx.toast('保存策略失败：' + e.message, 'error');
  }
}

async function clearPolicy() {
  if (!confirm('清除审批策略后恢复单步审批；进行中的申请会因策略变化立即失效。确定清除？')) return;
  try {
    const { policy } = await api.approvalPolicyPut(state.project.id, { stages: [], author: ctx.getAuthor() });
    rel.policy = policy;
    rel.policyDraft = null;
    $('#rel-policy-editor').style.display = 'none';
    ctx.toast('审批策略已清除，恢复单步审批', 'ok');
    ctx.refreshAudit?.();
    await refreshRequestsOnly();
    renderPolicy();
  } catch (e) {
    ctx.toast('清除失败：' + e.message, 'error');
  }
}

function activeRequestFor(revisionId) {
  return rel.requests.find((q) => q.revision_id === revisionId && ['pending', 'approved'].includes(q.status));
}

/* ==================== 预检 ==================== */

async function runPreflight() {
  const revisionId = $('#rel-rev-select').value;
  try {
    // 预检同时触发服务端对旧申请的复检（通过列表刷新）；并行拉取门禁状态（缺失评估会触发入队）
    const [p] = await Promise.all([
      api.releasePreflight(state.project.id, revisionId),
      refreshRequestsOnly(),
      loadGateBlocks(revisionId),
    ]);
    rel.preflight = p;
    rel.checked = new Set();
    renderPreflight();
    // 门禁评估可能仍在运行：短轮询直到完成再刷新一次门禁区块
    if (rel.gateStatus?.pending) {
      for (let i = 0; i < 30 && rel.gateStatus?.pending; i++) {
        await new Promise((r) => setTimeout(r, 300));
        await loadGateBlocks(revisionId);
        renderPreflight();
      }
    }
  } catch (e) {
    ctx.toast('预检失败：' + e.message, 'error');
  }
}

async function refreshRequestsOnly() {
  const { requests } = await api.releaseRequestList(state.project.id);
  rel.requests = requests;
  renderRequests();
  updateApplyButton();
}

function renderPreflight() {
  const p = rel.preflight;
  const wrap = $('#rel-preflight');
  if (!p) return;
  const parts = [];
  parts.push(gateGateHtml(p));
  parts.push(p.hardErrors.length
    ? `<div class="rel-gate bad">✗ 时间轴硬约束未通过：${esc(p.hardErrors[0].message)}（共 ${p.hardErrors.length} 处）</div>`
    : '<div class="rel-gate ok">✓ 时间轴硬约束通过（无反向区间）</div>');
  if (!p.job) {
    parts.push('<div class="rel-gate bad">✗ 该版本还没有已完成的质检，请先在「质检」页发起。</div>');
  } else {
    parts.push(`<div class="rel-gate ok">✓ 质检任务 #${esc(p.job.id.slice(2, 8))}（${new Date(p.job.finished_at).toLocaleString()}）</div>`);
  }
  if (p.blockerUnhandled.length) {
    parts.push(`<div class="rel-gate bad">✗ ${p.blockerUnhandled.length} 条阻断级问题未处理：</div>`);
    parts.push(...p.blockerUnhandled.map((f) =>
      `<div class="rel-item bad">阻断 · ${esc(f.cue_id)} · ${esc(f.evidence)}<div class="meta">状态：${esc(f.status)}${f.status === 'stale' ? '（项目已有新版本，请到「质检」页重新处理）' : ''}</div></div>`));
  } else if (p.job) {
    parts.push('<div class="rel-gate ok">✓ 阻断级问题全部已处理</div>');
  }
  if (p.warningsPending.length) {
    parts.push(`<div class="rel-gate warn">⚠ ${p.warningsPending.length} 条警告级问题需随申请逐项确认：</div>`);
    parts.push(...p.warningsPending.map((f) =>
      `<label class="rel-item warn"><input type="checkbox" class="rel-warn-check" data-id="${f.id}" ${rel.checked.has(f.id) ? 'checked' : ''}/> 警告 · ${esc(f.cue_id)} · ${esc(f.evidence)}</label>`));
  }
  if (p.headRevId !== p.revisionId) {
    parts.push(`<div class="rel-gate warn">ℹ 申请将绑定当前项目 HEAD（${esc(p.headRevId.slice(0, 8))}）的阻断处理情况；HEAD 再产生新提交时申请自动失效。</div>`);
  }
  const active = activeRequestFor(p.revisionId);
  if (active) {
    const st = REQ_STATUS[active.status];
    parts.push(`<div class="rel-gate ${active.status === 'approved' ? 'ok' : 'warn'}">
      ${active.status === 'approved'
        ? `✓ 申请 ${esc(active.id.slice(0, 10))} 已被 ${esc(active.reviewer)} 批准，可直接生成发布快照。`
        : `⏳ 申请 ${esc(active.id.slice(0, 10))} 已提交，等待审核人处理（申请人 ${esc(active.applicant)}）。`}
    </div>`);
  }
  wrap.innerHTML = parts.join('');
  wrap.querySelectorAll('.rel-warn-check').forEach((c) => {
    c.addEventListener('change', () => {
      c.checked ? rel.checked.add(c.dataset.id) : rel.checked.delete(c.dataset.id);
      updateApplyButton();
    });
  });
  wrap.querySelectorAll('[data-exempt]').forEach((btn) => {
    btn.addEventListener('click', () => createGateExemption(btn.dataset.exempt));
  });
  updateApplyButton();
}

/* ---------- 发布回归门禁：403 时展示命中事件与豁免入口 ---------- */

async function loadGateBlocks(revisionId) {
  try {
    const gs = await api.gateStatus(state.project.id, revisionId);
    rel.gateStatus = gs;
  } catch (e) {
    rel.gateStatus = null;
  }
}

function gateGateHtml(p) {
  const gs = rel.gateStatus;
  if (!gs || gs.subscriptionCount === 0) return '';
  if (gs.pending) {
    return '<div class="rel-gate warn">⏳ 发布回归门禁评估运行中，请稍后重试提交…</div>';
  }
  if (!gs.blocked) return '<div class="rel-gate ok">✓ 发布回归门禁通过（所有订阅均无未豁免回归）</div>';
  const rows = gs.unexempted.map((b) => `
    <div class="rel-item bad">
      ✗ 订阅「${esc(b.subscriptionName)}」事件 <b>${esc(b.eventNo)}</b>：
      新增 ${b.counts.new} · 恶化 ${b.counts.worsened} · 持续 ${b.counts.persisting} · 新质检问题 ${b.counts.qcNew}
      <div class="row" style="margin-top:4px"><button class="small-btn primary" data-exempt="${esc(b.eventId)}">审核人创建具名豁免…</button></div>
    </div>`).join('');
  return `<div class="rel-gate bad">✗ 发布回归门禁未通过：需审核人针对<b>本次事件与该版本</b>创建具名豁免（填写理由）；豁免不能用于后续新版本。</div>${rows}`;
}

async function createGateExemption(eventId) {
  const name = prompt('具名豁免（名称/审核具名）：', '');
  if (name == null || !name.trim()) return ctx.toast('豁免必须具名', 'error');
  const reason = prompt('豁免理由（必填，写入审计）：', '');
  if (reason == null || !reason.trim()) return ctx.toast('豁免必须填写理由', 'error');
  try {
    await api.gateExCreate(state.project.id, eventId, { name: name.trim(), reason: reason.trim(), author: ctx.getAuthor() });
    ctx.toast('豁免已创建，可继续发布流程', 'ok');
    ctx.refreshAudit?.();
    await runPreflight();
  } catch (e) {
    ctx.toast('创建豁免失败：' + e.message, 'error');
  }
}

function updateApplyButton() {
  const btn = $('#rel-apply-btn');
  const revisionId = $('#rel-rev-select').value;
  const active = revisionId ? activeRequestFor(revisionId) : null;
  if (active) {
    btn.disabled = active.status !== 'approved';
    btn.textContent = active.status === 'approved' ? '生成发布快照' : '申请待审核…';
    btn.dataset.requestId = active.id;
    return;
  }
  btn.dataset.requestId = '';
  const p = rel.preflight;
  if (!p || !p.canPublish || p.revisionId !== revisionId) {
    btn.disabled = true;
    btn.textContent = '提交发布申请';
    return;
  }
  const left = p.warningsPending.filter((w) => !rel.checked.has(w.id)).length;
  btn.disabled = left > 0;
  btn.textContent = left > 0 ? `还有 ${left} 条警告未确认` : '提交发布申请';
}

async function onMainButton() {
  const btn = $('#rel-apply-btn');
  if (btn.dataset.requestId) {
    await doPublish(btn.dataset.requestId);
    return;
  }
  await doApply();
}

/* ==================== 申请 / 审核 / 发布 ==================== */

async function doApply() {
  const p = rel.preflight;
  if (!p) return;
  const message = $('#rel-message').value.trim();
  try {
    const r = await api.releaseRequestCreate(state.project.id, {
      revisionId: p.revisionId,
      confirmations: p.warningsPending.map((w) => w.id),
      author: ctx.getAuthor(),
      message,
    });
    ctx.toast(r.deduplicated
      ? `该版本已有${r.request.status === 'approved' ? '已批准' : '待处理'}申请，未重复提交`
      : '发布申请已提交，等待审核', r.deduplicated ? '' : 'ok');
    ctx.refreshAudit?.();
    await refreshRequestsOnly();
    renderPreflight();
  } catch (e) {
    if (e.data?.preflight) {
      rel.preflight = e.data.preflight;
      renderPreflight();
    }
    if (e.data?.gateBlocked) {
      await loadGateBlocks(p.revisionId);
      renderPreflight();
      ctx.toast('被发布回归门禁拦截：请审核人针对命中事件创建具名豁免', 'error');
    } else if (e.status === 423 || e.data?.gatePending) {
      ctx.toast('门禁评估仍在运行，请稍候重试', 'error');
      setTimeout(runPreflight, 800);
    } else {
      ctx.toast('申请失败：' + e.message, 'error');
    }
  }
}

async function doApprove(req) {
  const stage = currentStage(req);
  const comment = prompt(`批准发布申请 ${req.id.slice(3, 11)}${stage ? `（当前阶段：${stage.role}）` : ''} 的审核意见（可留空）：`, '') ?? '';
  try {
    const r = await api.releaseApprove(req.id, { author: ctx.getAuthor(), comment });
    if (r.deduplicated) {
      ctx.toast('你在本阶段已提交过相同意见（幂等，未重复记录）', '');
    } else if (r.outcome === 'collecting') {
      const s = currentStage(r.request);
      ctx.toast(`已同意（会签 ${r.approvals}/${s ? s.min_approvals : '?'}），等待其他审核人`, 'ok');
    } else if (r.outcome === 'stage-approved') {
      ctx.toast('当前阶段会签通过，已进入下一阶段', 'ok');
    } else {
      ctx.toast('申请已批准，可生成发布快照', 'ok');
    }
    ctx.refreshAudit?.();
    await refreshRequestsOnly();
    if (rel.preflight) renderPreflight();
  } catch (e) {
    await refreshRequestsOnly();
    if (e.data?.expired) {
      ctx.toast('阶段已超时过期：需负责人重新开启后才能继续会签', 'error');
    } else {
      ctx.toast('批准失败：' + e.message, 'error');
    }
  }
}

async function doReject(req) {
  const stage = currentStage(req);
  const comment = prompt(`驳回发布申请 ${req.id.slice(3, 11)}${stage ? `（当前阶段：${stage.role}）` : ''} 的审核意见（必填，写入审计）：`, '');
  if (comment == null) return;
  if (!comment.trim()) { ctx.toast('驳回必须填写审核意见', 'error'); return; }
  try {
    await api.releaseReject(req.id, { author: ctx.getAuthor(), comment: comment.trim() });
    ctx.toast('申请已驳回', '');
    ctx.refreshAudit?.();
    await refreshRequestsOnly();
    if (rel.preflight) renderPreflight();
  } catch (e) {
    await refreshRequestsOnly();
    if (e.data?.expired) {
      ctx.toast('阶段已超时过期：需负责人重新开启后才能继续会签', 'error');
    } else {
      ctx.toast('驳回失败：' + e.message, 'error');
    }
  }
}

async function doReopen(req) {
  try {
    await api.releaseReopen(req.id, { author: ctx.getAuthor() });
    ctx.toast('已重新开启当前阶段（获得新的有效期窗口）', 'ok');
    ctx.refreshAudit?.();
    await refreshRequestsOnly();
  } catch (e) {
    await refreshRequestsOnly();
    ctx.toast('重新开启失败：' + e.message, 'error');
  }
}

async function doPublish(requestId) {
  try {
    const r = await api.releasePublish(state.project.id, { requestId, author: ctx.getAuthor() });
    if (r.deduplicated) {
      ctx.toast(`该版本已发布过（${r.release.label}），未产生重复快照`, '');
    } else {
      ctx.toast(`已发布 ${r.release.label}`, 'ok');
    }
    ctx.refreshAudit?.();
    await refreshReleaseTab();
  } catch (e) {
    await refreshRequestsOnly();
    if (rel.preflight) renderPreflight();
    if (e.data?.gateBlocked) {
      await loadGateBlocks(rel.preflight?.revisionId || '');
      if (rel.preflight) renderPreflight();
      ctx.toast('被发布回归门禁拦截：需对命中事件创建具名豁免', 'error');
    } else {
      ctx.toast('发布失败：' + e.message, 'error');
    }
  }
}

async function reapply(req) {
  $('#rel-rev-select').value = req.revision_id;
  $('#rel-message').value = req.message || '';
  await runPreflight();
  ctx.toast('已重新预检，请逐项确认警告后重新提交申请', '');
  document.querySelector('#rel-preflight')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ==================== 审批记录 ==================== */

function renderRequests() {
  const wrap = $('#rel-requests');
  if (!rel.requests.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">还没有发布申请。预检通过后可提交。</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const q of rel.requests) {
    const st = REQ_STATUS[q.status] || { label: q.status, cls: '' };
    const revMsg = rel.revisions.find((r) => r.id === q.revision_id)?.message || q.revision_id.slice(0, 8);
    const div = document.createElement('div');
    div.className = `rel-card relreq is-${q.status}` + (q.status === 'invalidated' || q.status === 'rejected' ? ' withdrawn' : '');
    const relRow = q.release_id
      ? rel.releases.find((r) => r.id === q.release_id)
      : null;
    div.innerHTML = `
      <div class="row">
        <b>申请 ${esc(q.id.slice(3, 11))}</b>
        <span class="tag ${st.cls}">${st.label}</span>
        <span style="flex:1"></span>
        <span class="meta">${esc(revMsg.slice(0, 20))} · ${esc(q.revision_id.slice(0, 8))}</span>
      </div>
      <div class="meta">申请人 ${esc(q.applicant)} · ${dt(q.created_at)}${q.message ? ` · 说明：${esc(q.message)}` : ''}</div>
      <div class="meta">绑定预检：${q.hasHardErrors ? '硬约束未通过 · ' : ''}阻断待处理 ${q.blockerCount} · 待确认警告 ${q.warningCount} · HEAD ${esc(q.boundHeadRevId.slice(0, 8))}</div>
      ${q.reviewer ? `<div class="meta">审核人 ${esc(q.reviewer)} · ${dt(q.reviewed_at)}${q.review_comment ? ` · 意见：${esc(q.review_comment)}` : ''}</div>` : ''}
      ${q.status === 'invalidated' ? `<div class="rel-item bad" style="margin-top:5px">✗ 已失效：${esc(INVALID_TEXT[q.invalid_reason] || q.invalid_reason)}（${dt(q.invalidated_at)}），请重新预检后重新申请。</div>` : ''}
      ${relRow ? `<div class="meta" style="margin-top:4px">关联发布：<b>${esc(relRow.label)}</b></div>` : ''}
      <div class="row" style="margin-top:6px;flex-wrap:wrap;gap:6px"></div>`;
    const actions = div.querySelector('.row:last-child');
    if (q.status === 'pending') {
      const b1 = document.createElement('button');
      b1.className = 'small-btn primary'; b1.textContent = '批准';
      b1.addEventListener('click', () => doApprove(q));
      const b2 = document.createElement('button');
      b2.className = 'small-btn danger'; b2.textContent = '驳回…';
      b2.addEventListener('click', () => doReject(q));
      actions.append(b1, b2);
    } else if (q.status === 'approved') {
      const b = document.createElement('button');
      b.className = 'small-btn primary'; b.textContent = '生成发布快照';
      b.addEventListener('click', () => doPublish(q.id));
      actions.append(b);
    } else if (q.status === 'invalidated') {
      const b = document.createElement('button');
      b.className = 'small-btn'; b.textContent = '重新预检并申请…';
      b.addEventListener('click', () => reapply(q));
      actions.append(b);
    }
    wrap.appendChild(div);
  }
}

/* ==================== 发布历史 ==================== */

function renderReleases() {
  const wrap = $('#rel-list');
  if (!rel.releases.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">还没有发布快照。</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const r of rel.releases) {
    const div = document.createElement('div');
    div.className = 'rel-card' + (r.status === 'withdrawn' ? ' withdrawn' : '');
    const s = r.qc_summary;
    div.innerHTML = `
      <div class="row">
        <b>${esc(r.label)}</b>
        ${r.status === 'published' ? '<span class="tag qc-ok">已发布</span>' : '<span class="tag qc-bad">已撤销</span>'}
        <span style="flex:1"></span>
        <span class="meta">${r.cueCount} 句 · ${r.trackCount} 轨</span>
      </div>
      <div class="meta">来源版本 <code>${esc(r.revision_id.slice(0, 10))}</code> · ${esc(r.author)} · ${new Date(r.created_at).toLocaleString()}${s.approvedBy ? ` · 审批人 ${esc(s.approvedBy)}` : ''}</div>
      <div class="meta">质检摘要：阻断 ${s.blocker.total}（修复 ${s.blocker.fixed} / 忽略 ${s.blocker.ignored}）· 警告 ${s.warning.total}（确认 ${s.warning.confirmed.length} / 忽略 ${s.warning.ignored.length}）${r.message ? `<br/>说明：${esc(r.message)}` : ''}</div>
      ${r.status === 'withdrawn' ? `<div class="meta">撤销：${esc(r.withdrawn_by)} · ${new Date(r.withdrawn_at).toLocaleString()}${r.withdraw_reason ? ` · ${esc(r.withdraw_reason)}` : ''}</div>` : ''}
      <div class="row" style="margin-top:6px;flex-wrap:wrap;gap:6px">
        ${r.status === 'published' ? `
          <a class="small-btn link" href="/api/releases/${r.id}/files/srt/all" download>SRT·全部</a>
          <a class="small-btn link" href="/api/releases/${r.id}/files/vtt/all" download>VTT·全部</a>
          ${(rel.revisions.length ? `<select class="rel-diff-rev" style="max-width:150px">${rel.revisions.map((v) => `<option value="${v.id}">${esc((v.message || v.kind).slice(0, 16))}·${v.id.slice(0, 6)}</option>`).join('')}</select>
          <button class="small-btn" data-act="diff">对比版本</button>` : '')}
          <button class="small-btn danger" data-act="withdraw">撤销发布…</button>` : `
          <button class="small-btn" data-act="diff">对比版本</button>`}
      </div>
      <div class="rel-diff" style="display:none"></div>`;
    div.querySelector('[data-act=withdraw]')?.addEventListener('click', async () => {
      const reason = prompt(`撤销发布 ${r.label} 的理由（写入审计）：`) || '';
      if (!reason.trim()) return;
      try {
        await api.releaseWithdraw(r.id, { author: ctx.getAuthor(), reason });
        ctx.toast(`${r.label} 已撤销`, 'ok');
        ctx.refreshAudit?.();
        refreshReleaseTab();
      } catch (e) {
        ctx.toast('撤销失败：' + e.message, 'error');
      }
    });
    div.querySelector('[data-act=diff]')?.addEventListener('click', async () => {
      const against = div.querySelector('.rel-diff-rev')?.value || rel.revisions[0]?.id;
      const box = div.querySelector('.rel-diff');
      if (box.style.display === 'block') { box.style.display = 'none'; return; }
      const d = await api.releaseDiff(r.id, against);
      box.innerHTML = renderDiff(d);
      box.style.display = 'block';
    });
    wrap.appendChild(div);
  }
}

function renderDiff(d) {
  const s = d.summary.cues;
  const rows = [];
  rows.push(`<div class="meta">与「${esc(d.against.message || d.against.id.slice(0, 8))}」对比：新增 ${s.added} · 删除 ${s.removed} · 变更 ${s.changed}</div>`);
  if (!d.cues.length) rows.push('<div class="rel-item">句子内容完全一致。</div>');
  for (const c of d.cues) {
    if (c.type === 'added') {
      rows.push(`<div class="rel-item ok">+ 新增 <code>${esc(c.id)}</code> 「${esc((c.item.text || '').slice(0, 40))}」 ${msToSrt(c.item.start)} → ${msToSrt(c.item.end)}</div>`);
    } else if (c.type === 'removed') {
      rows.push(`<div class="rel-item bad">- 删除 <code>${esc(c.id)}</code> 「${esc((c.item.text || '').slice(0, 40))}」</div>`);
    } else {
      const fields = Object.entries(c.changes).map(([f, v]) => {
        const fmtV = (x) => (['start', 'end'].includes(f) ? msToSrt(x) : String(x).slice(0, 40));
        return `${f}: ${esc(fmtV(v.from))} → ${esc(fmtV(v.to))}`;
      }).join('<br/>');
      rows.push(`<div class="rel-item warn">~ 变更 <code>${esc(c.id)}</code><br/>${fields}</div>`);
    }
  }
  return rows.join('');
}
