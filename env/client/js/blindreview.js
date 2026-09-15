// 多版本字幕盲审对照：创建轮次 → 匿名盲审（保存续作/提交）→ 进度 → 关闭后冻结结果
import { api } from './api.js';
import { state, subscribe } from './state.js';
import { msToSrt } from './time.js';

let ctx = null;
// 当前打开的视图：null=轮次列表；{type:'review'|'progress'|'result', roundId, ...}
let view = null;
let revisionsCache = [];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dt = (t) => (t ? new Date(t).toLocaleString() : '—');

const REASON_LABEL = { 'no-counterpart': '无可靠对应（新增/删除）', 'one-to-many': '一对多，无法可靠配对' };

export function initBlindReview(context) {
  ctx = context;
  $('#blind-create-btn').addEventListener('click', createRound);
  $('#blind-refresh').addEventListener('click', refreshBlind);
  document.querySelector('.tabs button[data-tab="blind"]').addEventListener('click', () => {
    // 页签内「返回列表」时也会触发刷新；这里保持与讨论/质检一致的按需加载
    refreshBlind();
  });
  $('#blind-events-close').addEventListener('click', () => $('#blind-events-modal').classList.remove('show'));
  // 切换项目后若停留在盲审页签，丢弃跨项目的打开视图并刷新
  subscribe((reason) => {
    if (reason === 'load') {
      if (view && view.projectId !== (state.project && state.project.id)) view = null;
      refreshBlind();
    }
  });
}

export async function refreshBlind() {
  if (!state.project) return;
  try {
    const [{ rounds }, { revisions }] = await Promise.all([
      api.blindList(state.project.id),
      api.listRevisions(state.project.id),
    ]);
    revisionsCache = revisions;
    renderRoundList(rounds);
    if (view) await renderView();
  } catch (e) {
    ctx.toast('加载盲审轮次失败：' + e.message, 'error');
  }
}

/* ==================== 创建 ==================== */

async function createRound() {
  const checks = [...document.querySelectorAll('.blind-rev-check:checked')];
  const revisionIds = checks.map((c) => c.value);
  if (revisionIds.length < 2 || revisionIds.length > 3) {
    ctx.toast('请勾选 2~3 个历史版本', 'error');
    return;
  }
  const minSubmitters = Number($('#blind-min').value);
  try {
    const r = await api.blindCreate(state.project.id, {
      revisionIds,
      minSubmitters,
      title: $('#blind-title').value.trim(),
      author: ctx.getAuthor(),
    });
    ctx.toast(`盲审轮次已创建：${r.round.item_count} 个对照项，${r.round.unmatched_count} 条单列内容（内容已冻结）`, 'ok');
    ctx.refreshAudit?.();
    setView({ type: 'progress', roundId: r.round.id });
    await refreshBlind();
  } catch (e) {
    ctx.toast('创建失败：' + e.message, 'error');
  }
}

function renderRevPicker() {
  // 版本选择器：按创建顺序（旧→新）展示，默认不勾选
  const wrap = $('#blind-rev-picker');
  const revs = [...revisionsCache].reverse(); // 列表接口按时间倒序，翻转为旧→新
  const items = revs.map((r) => `
    <label class="blind-rev">
      <input type="checkbox" class="blind-rev-check" value="${esc(r.id)}" />
      <span>${esc((r.message || r.kind).slice(0, 24))} · ${esc(r.id.slice(0, 8))} · ${dt(r.created_at)}</span>
    </label>`);
  wrap.innerHTML = items.length
    ? items.join('')
    : '<p style="color:var(--muted);font-size:12px">还没有历史版本。</p>';
}

/* ==================== 轮次列表 ==================== */

function renderRoundList(rounds) {
  const wrap = $('#blind-rounds');
  renderRevPicker();
  if (!rounds.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">还没有盲审轮次。勾选 2~3 个历史版本后创建。</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const rd of rounds) {
    const p = rd.progress;
    const div = document.createElement('div');
    div.className = 'qc-job';
    const statusTag = rd.status === 'closed'
      ? '<span class="tag qc-ok">已关闭</span>'
      : '<span class="tag qc-warn">进行中</span>';
    div.innerHTML = `
      <div class="row">
        <b>${esc(rd.title || '未命名轮次')}</b> ${statusTag}
        ${rd.revealed ? '<span class="tag">已揭示来源</span>' : '<span class="tag">盲态</span>'}
      </div>
      <div class="meta">
        对照项 ${rd.item_count} · 单列内容 ${rd.unmatched_count} · 候选版本 ${rd.version_count} 个<br/>
        门槛完成比例 <b>${p.validSubmitters}</b> / ${rd.min_submitters}（${p.thresholdCompletionPct ?? 0}%） · 参与 ${p.totalReviewers} 人
        ${p.thresholdMet ? '· <span class="tag qc-ok">已达门槛</span>' : '· 未达门槛'}
      </div>
      <div class="meta">创建：${esc(rd.created_by)} · ${dt(rd.created_at)}${rd.closed_at ? ` · 关闭：${dt(rd.closed_at)}` : ''}</div>
      <div class="row" style="margin-top:6px"></div>`;
    const actions = div.querySelector('.row:last-child');
    const mk = (label, cls, fn, title) => {
      const b = document.createElement('button');
      b.className = 'small-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', fn);
      actions.appendChild(b);
      return b;
    };
    if (rd.status === 'open') {
      mk('进入盲审', 'primary', () => openReview(rd.id));
      mk('进度', '', () => openProgress(rd.id));
      if (p.thresholdMet) {
        mk('揭示来源', '', async () => {
          await api.blindReveal(rd.id, ctx.getAuthor());
          ctx.toast('已揭示来源（达到最少有效提交人数）', 'ok');
          ctx.refreshAudit?.();
          refreshBlind();
        });
        mk('关闭轮次', 'danger', () => closeRound(rd));
      }
    } else {
      mk('查看结果', 'primary', () => openResult(rd.id));
      mk('进度', '', () => openProgress(rd.id));
    }
    mk('操作记录', '', () => openEvents(rd.id));
    wrap.appendChild(div);
  }
}

/* ==================== 视图容器 ==================== */

function setView(v) {
  view = v;
  if (view) view.projectId = state.project?.id;
}

async function renderView() {
  if (!view) { $('#blind-view').innerHTML = ''; return; }
  if (view.type === 'review') await renderReview(view.roundId);
  else if (view.type === 'progress') await renderProgress(view.roundId);
  else if (view.type === 'result') await renderResult(view.roundId);
}

function viewShell(title, subtitle) {
  const wrap = $('#blind-view');
  const back = view?.backLabel && view.backTarget
    ? `<button class="small-btn" id="blind-back">${esc(view.backLabel)}</button>` : '';
  wrap.innerHTML = `
    <div class="pane-section-title" style="display:flex;align-items:center;gap:8px">
      ${back}<span>${esc(title)}</span>
    </div>
    ${subtitle ? `<div class="hint" style="color:var(--muted);font-size:12px;margin-bottom:8px">${subtitle}</div>` : ''}
    <div id="blind-view-body"></div>`;
  if (view?.backTarget) {
    $('#blind-back').addEventListener('click', () => { view = view.backTarget === 'list' ? null : { ...view.backTarget }; refreshBlind(); });
  }
  return $('#blind-view-body');
}

/* ==================== 盲审视图 ==================== */

async function openReview(roundId) {
  setView({ type: 'review', roundId, backLabel: '← 返回列表', backTarget: 'list' });
  await renderView();
}

async function renderReview(roundId) {
  let payload;
  try {
    payload = await api.blindReview(roundId, ctx.getAuthor());
  } catch (e) {
    ctx.toast('进入盲审失败：' + e.message, 'error');
    view = null;
    await refreshBlind();
    return;
  }
  const closed = payload.round.status === 'closed';
  const submitted = payload.submission.status === 'submitted';
  const readonly = closed || submitted;
  const body = viewShell(
    payload.round.title || '盲审',
    `逐项对照：为每项选择更好的候选、判「相当」或「无法判断」，可填写意见。`
    + (closed ? '轮次已关闭，仅供回看。' : submitted ? '已提交，结果以本次提交为准。' : '保存后刷新或重新进入会接着原进度。'),
  );

  const answers = {};
  for (const it of payload.items) {
    if (it.myAnswer) answers[it.key] = { ...it.myAnswer };
  }
  let baseVersion = payload.submission.version;

  const renderItems = (items) => items.map((it, idx) => `
    <div class="blind-item" data-key="${esc(it.key)}">
      <div class="blind-item-head">
        <b>对照项 ${idx + 1}</b>
        <span class="blind-item-state tag" data-state-for="${esc(it.key)}"></span>
      </div>
      <div class="blind-cands" style="grid-template-columns:repeat(${it.candidates.length},1fr)">
        ${it.candidates.map((c) => `
          <div class="blind-cand">
            <div class="blind-cand-label">候选 ${esc(c.label)}</div>
            <div class="meta">${esc(c.trackName)} · ${msToSrt(c.start)} → ${msToSrt(c.end)}${c.locked ? ' · 🔒' : ''}</div>
            <div class="blind-cand-text">${esc(c.text)}</div>
          </div>`).join('')}
      </div>
      <div class="blind-choice" data-key="${esc(it.key)}">
        ${it.candidates.map((c) => `
          <label><input type="radio" name="blind-${esc(it.key)}" value="better:${esc(c.label)}"
            ${answers[it.key]?.choice === 'better' && answers[it.key]?.candidate === c.label ? 'checked' : ''}
            ${readonly ? 'disabled' : ''}/> ${esc(c.label)} 更好</label>`).join('')}
        <label><input type="radio" name="blind-${esc(it.key)}" value="equal"
          ${answers[it.key]?.choice === 'equal' ? 'checked' : ''} ${readonly ? 'disabled' : ''}/> 相当</label>
        <label><input type="radio" name="blind-${esc(it.key)}" value="unknown"
          ${answers[it.key]?.choice === 'unknown' ? 'checked' : ''} ${readonly ? 'disabled' : ''}/> 无法判断</label>
        <input class="blind-comment" data-key="${esc(it.key)}" placeholder="意见（可选）"
          value="${esc(answers[it.key]?.comment || '')}" ${readonly ? 'disabled' : ''}/>
      </div>
    </div>`).join('');

  const itemHtml = renderItems(payload.items);
  const unmatchedHtml = payload.unmatched.length
    ? `<div class="pane-section-title">无法可靠配对的内容（单列，不参与对照）</div>
       ${payload.unmatched.map((u) => `
         <div class="blind-unmatched">
           <span class="tag">单列</span> ${esc(u.trackName)} · ${msToSrt(u.start)} → ${msToSrt(u.end)}
           <div class="blind-cand-text">${esc(u.text)}</div>
         </div>`).join('')}`
    : '';

  body.innerHTML = `
    ${closed ? '<div class="qc-stale-banner" style="display:block">轮次已关闭，不再接受新选择。</div>'
      : submitted ? '<div class="qc-stale-banner" style="display:block">你已提交本次盲审，不能再修改；如需改判请联系组织者拒绝后重试。</div>' : ''}
    <div class="blind-progress" id="blind-progress-text"></div>
    ${itemHtml}
    ${unmatchedHtml}
    ${payload.round.itemCount ? `
      <div class="row" style="display:flex;gap:8px;margin-top:10px;position:sticky;bottom:0;background:var(--panel);padding:8px 0">
        <button class="small-btn primary" id="blind-save-btn" ${readonly ? 'disabled' : ''}>保存进度</button>
        <button class="small-btn" id="blind-submit-btn" ${readonly ? 'disabled' : ''}>提交（定稿）</button>
      </div>` : '<p style="color:var(--muted)">本轮没有可对照的内容。</p>'}
  `;

  const updateProgress = () => {
    const answered = payload.items.filter((it) => answers[it.key]?.choice).length;
    $('#blind-progress-text').textContent = `已作答 ${answered} / ${payload.items.length}`;
    for (const it of payload.items) {
      const el = body.querySelector(`[data-state-for="${CSS.escape(it.key)}"]`);
      if (el) {
        el.textContent = answers[it.key]?.choice ? '已答' : '未答';
        el.className = 'blind-item-state tag ' + (answers[it.key]?.choice ? 'qc-ok' : 'qc-warn');
      }
    }
  };
  updateProgress();

  // 选择变化即时更新本地状态
  body.querySelectorAll('.blind-choice input[type=radio]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const key = radio.name.slice('blind-'.length);
      const cur = answers[key] || { choice: null, candidate: null, comment: '' };
      if (radio.value.startsWith('better:')) {
        cur.choice = 'better';
        cur.candidate = radio.value.slice('better:'.length);
      } else {
        cur.choice = radio.value;
        cur.candidate = null;
      }
      answers[key] = cur;
      updateProgress();
    });
  });
  body.querySelectorAll('.blind-comment').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.key;
      const cur = answers[key] || { choice: null, candidate: null, comment: '' };
      cur.comment = input.value;
      answers[key] = cur;
    });
  });

  const collectAnswers = () => {
    const out = {};
    for (const [key, a] of Object.entries(answers)) {
      if (!a.choice) continue;
      out[key] = { choice: a.choice, candidate: a.choice === 'better' ? a.candidate : null, comment: a.comment || '' };
    }
    return out;
  };

  $('#blind-save-btn')?.addEventListener('click', async () => {
    const token = crypto.randomUUID();
    try {
      const r = await api.blindSave(roundId, { reviewer: ctx.getAuthor(), baseVersion, answers: collectAnswers(), clientToken: token });
      baseVersion = r.submission.version;
      ctx.toast('进度已保存', 'ok');
      ctx.refreshAudit?.();
    } catch (e) {
      if (e.status === 409 && e.data?.current) {
        ctx.toast('该轮次已有新的保存（可能来自另一标签页），已载入最新进度', 'error');
        await renderView();
      } else {
        ctx.toast('保存失败：' + e.message, 'error');
      }
    }
  });

  $('#blind-submit-btn')?.addEventListener('click', async () => {
    const answered = payload.items.filter((it) => answers[it.key]?.choice).length;
    if (answered < payload.items.length) {
      ctx.toast(`还有 ${payload.items.length - answered} 个对照项未作答，全部作答后才能提交`, 'error');
      return;
    }
    if (!confirm('提交后不能再修改（如需改判需组织者拒绝）。确认提交？')) return;
    try {
      // 先保存再提交，保证提交的是当前页面内容
      const r = await api.blindSave(roundId, { reviewer: ctx.getAuthor(), baseVersion, answers: collectAnswers(), clientToken: crypto.randomUUID() });
      baseVersion = r.submission.version;
      const s = await api.blindSubmit(roundId, { reviewer: ctx.getAuthor(), expectedVersion: baseVersion, clientToken: crypto.randomUUID() });
      baseVersion = s.submission.version;
      ctx.toast('已提交', 'ok');
      ctx.refreshAudit?.();
      await renderView();
    } catch (e) {
      if (e.status === 409 && e.data?.current) {
        ctx.toast('提交前进度已有更新，已载入最新进度', 'error');
        await renderView();
      } else {
        ctx.toast('提交失败：' + e.message, 'error');
      }
    }
  });
}

/* ==================== 进度视图（组织者） ==================== */

async function openProgress(roundId) {
  setView({ type: 'progress', roundId, backLabel: '← 返回列表', backTarget: 'list' });
  await renderView();
}

async function renderProgress(roundId) {
  const { round: rd } = await api.blindDetail(state.project.id, roundId);
  const p = rd.progress;
  const body = viewShell(
    rd.title || '盲审轮次',
    `门槛完成比例 ${p.validSubmitters} / ${rd.min_submitters}（${p.thresholdCompletionPct ?? 0}%） · 参与 ${p.totalReviewers} 人`
    + (rd.status === 'closed' ? ' · 已关闭' : p.thresholdMet ? ' · 已达门槛，可揭示来源或关闭' : ' · 未达门槛前不能揭示来源或关闭'),
  );
  const levelTag = { none: '<span class="tag">无投票</span>', unanimous: '<span class="tag qc-ok">一致</span>', split: '<span class="tag qc-warn">分歧</span>' };
  body.innerHTML = `
    <div class="pane-section-title">门槛完成比例</div>
    <div class="qc-job">
      <div class="row">
        <b>有效提交 ${p.validSubmitters} / ${rd.min_submitters}</b>
        <span class="tag ${p.thresholdMet ? 'qc-ok' : 'qc-warn'}">${p.thresholdCompletionPct ?? 0}%</span>
        <span class="meta">参与 ${p.totalReviewers} 人${p.thresholdMet ? ' · 已达门槛' : ' · 未达门槛'}</span>
      </div>
      <div class="blind-ratio-bar" title="门槛完成比例">
        <div class="blind-ratio-fill ${p.thresholdMet ? 'qc-ok-bg' : ''}" style="width:${p.thresholdCompletionPct ?? 0}%"></div>
      </div>
    </div>
    <div class="pane-section-title">审阅人进度</div>
    ${p.reviewers.length ? p.reviewers.map((r) => `
      <div class="qc-job">
        <div class="row">
          <b>${esc(r.reviewer)}</b>
          <span class="tag ${r.status === 'submitted' ? 'qc-ok' : r.status === 'rejected' ? 'qc-bad' : ''}">${
            { draft: '作答中', submitted: '已提交', rejected: '已拒绝' }[r.status] || r.status}</span>
          <span class="meta">${r.answered}/${r.total} 项 · 完成 ${r.completionPct ?? 0}%</span>
          ${r.submitted_at ? `<span class="meta">提交于 ${dt(r.submitted_at)}</span>` : ''}
        </div>
        <div class="blind-ratio-bar" title="个人作答完成比例">
          <div class="blind-ratio-fill ${r.status === 'submitted' ? 'qc-ok-bg' : ''}" style="width:${r.completionPct ?? 0}%"></div>
        </div>
        ${r.status === 'rejected' ? `<div class="meta">拒绝：${esc(r.reject_reason || '')}（${esc(r.rejected_by || '')} · ${dt(r.rejected_at)}）</div>` : ''}
        ${r.status === 'submitted' && rd.status === 'open' ? `<div class="row" style="margin-top:4px"><button class="small-btn danger blind-reject" data-reviewer="${esc(r.reviewer)}">拒绝该提交…</button></div>` : ''}
      </div>`).join('') : '<p style="color:var(--muted)">还没有审阅人参与。</p>'}
    <div class="pane-section-title">逐项分歧程度（匿名聚合）</div>
    ${p.perItem.map((it, i) => `
      <div class="qc-finding">
        <div class="row">
          <b>对照项 ${i + 1}</b> ${levelTag[it.level]}
          <span class="meta">更好 ${it.better} · 相当 ${it.equal} · 无法判断 ${it.unknown}${it.distribution.length ? ` · 首选分布 ${it.distribution.join(' / ')}` : ''}</span>
        </div>
      </div>`).join('')}
    <div class="row" style="display:flex;gap:8px;margin-top:8px">
      ${rd.status === 'open' && p.thresholdMet ? `
        <button class="small-btn" id="blind-reveal-btn">揭示来源</button>
        <button class="small-btn danger" id="blind-close-btn">关闭轮次并生成结果</button>` : ''}
      ${rd.status === 'closed' ? '<button class="small-btn primary" id="blind-open-result">查看冻结结果</button>' : ''}
    </div>`;
  body.querySelectorAll('.blind-reject').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reason = prompt('拒绝理由（必填，该提交将不计入有效人数，对方可修改后重新提交）：');
      if (reason == null) return;
      if (!reason.trim()) { ctx.toast('拒绝必须填写理由', 'error'); return; }
      try {
        await api.blindReject(roundId, { reviewer: btn.dataset.reviewer, reason: reason.trim(), author: ctx.getAuthor() });
        ctx.toast('已拒绝该提交', 'ok');
        ctx.refreshAudit?.();
        await renderView();
      } catch (e) {
        ctx.toast('拒绝失败：' + e.message, 'error');
      }
    });
  });
  $('#blind-reveal-btn')?.addEventListener('click', async () => {
    try {
      await api.blindReveal(roundId, ctx.getAuthor());
      ctx.toast('已揭示来源', 'ok');
      ctx.refreshAudit?.();
      await refreshBlind();
    } catch (e) {
      ctx.toast('揭示失败：' + e.message, 'error');
    }
  });
  $('#blind-close-btn')?.addEventListener('click', () => closeRound(rd));
  $('#blind-open-result')?.addEventListener('click', () => openResult(roundId));
}

async function closeRound(rd) {
  if (!confirm(`关闭轮次「${rd.title || '未命名'}」？\n关闭后不再接受新选择，并生成冻结结果（平票保留为平票）。`)) return;
  try {
    const r = await api.blindClose(rd.id, ctx.getAuthor());
    ctx.toast(r.deduplicated ? '轮次已关闭，返回既有结果' : '轮次已关闭，结果已冻结', 'ok');
    ctx.refreshAudit?.();
    setView({ type: 'result', roundId: rd.id, backLabel: '← 返回列表', backTarget: 'list' });
    await refreshBlind();
  } catch (e) {
    ctx.toast('关闭失败：' + e.message, 'error');
  }
}

/* ==================== 结果视图 ==================== */

async function openResult(roundId) {
  setView({ type: 'result', roundId, backLabel: '← 返回列表', backTarget: 'list' });
  await renderView();
}

async function renderResult(roundId) {
  let result;
  try {
    const { result: res } = await api.blindResult(roundId);
    result = res;
  } catch (e) {
    ctx.toast('读取结果失败：' + e.message, 'error');
    view = null;
    await refreshBlind();
    return;
  }
  const body = viewShell(
    '盲审冻结结果',
    `有效提交 ${result.validSubmitters} / 门槛 ${result.minSubmitters} · 对照项 ${result.summary.itemCount}（胜出 ${result.summary.winnerCount} · 平票 ${result.summary.tieCount}）· 单列内容 ${result.summary.unmatchedCount} 条 · 生成于 ${dt(result.generatedAt)}`,
  );
  const verName = (slot) => {
    const v = result.versions.find((x) => x.slot === slot);
    return v ? `${esc(v.label)}` : `槽位 ${slot}`;
  };
  body.innerHTML = `
    <div class="pane-section-title">候选版本</div>
    ${result.versions.map((v) => `<div class="meta" style="margin-bottom:3px">版本 ${'ABC'[v.slot]}：${esc(v.label)} · 作者 ${esc(v.author)} · ${esc(v.message || '')}</div>`).join('')}
    <div class="pane-section-title">逐项结果</div>
    ${result.items.map((it, idx) => `
      <div class="qc-finding">
        <div class="row">
          <b>对照项 ${idx + 1}</b>
          ${it.outcome === 'winner'
            ? `<span class="tag qc-ok">胜出：版本 ${'ABC'[it.winnerSlot]}</span>`
            : '<span class="tag qc-warn">平票</span>'}
          <span class="meta">${it.candidates.map((c) => `版本${'ABC'[c.slot]} ${it.votes.bySlot[c.slot] || 0} 票`).join(' · ')} · 相当 ${it.votes.equal} · 无法判断 ${it.votes.unknown}</span>
        </div>
        <div class="blind-cands" style="grid-template-columns:repeat(${it.candidates.length},1fr);margin-top:6px">
          ${it.candidates.map((c) => `
            <div class="blind-cand ${it.outcome === 'winner' && it.winnerSlot === c.slot ? 'blind-winner' : ''}">
              <div class="blind-cand-label">版本 ${'ABC'[c.slot]} · ${esc(c.versionLabel || '')}</div>
              <div class="meta">${esc(c.trackName)} · ${msToSrt(c.start)} → ${msToSrt(c.end)}</div>
              <div class="blind-cand-text">${esc(c.text)}</div>
            </div>`).join('')}
        </div>
        ${it.opinions.length ? `<div class="meta" style="margin-top:6px">意见：${it.opinions.map((o) => `
          <div>${esc(o.reviewer)}：${{ better: `选版本${'ABC'[o.candidateSlot]}更好`, equal: '相当', unknown: '无法判断' }[o.choice]}${o.comment ? ` — ${esc(o.comment)}` : ''}</div>`).join('')}</div>` : ''}
      </div>`).join('')}
    ${result.unmatched.length ? `
      <div class="pane-section-title">无法可靠配对的内容（单列）</div>
      ${result.unmatched.map((u) => `
        <div class="blind-unmatched">
          <span class="tag">单列</span> 版本 ${'ABC'[u.slot]} · ${esc(u.versionLabel || '')} · ${esc(u.trackName)} · ${msToSrt(u.start)} → ${msToSrt(u.end)}
          <span class="tag" style="margin-left:6px">${REASON_LABEL[u.reason] || u.reason}</span>
          <div class="blind-cand-text">${esc(u.text)}</div>
        </div>`).join('')}` : ''}
    <div class="row" style="margin-top:8px">
      <button class="small-btn" id="blind-export-btn">导出结果 JSON</button>
    </div>`;
  $('#blind-export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `blind_result_${roundId.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* ==================== 操作记录 ==================== */

async function openEvents(roundId) {
  try {
    const { events } = await api.blindEvents(roundId);
    $('#blind-events-body').innerHTML = events.length ? events.map((e) => `
      <div class="audit-item">
        <div class="meta">${dt(e.created_at)} · ${esc(e.actor)}</div>
        <div class="field">${esc(e.action)}</div>
        ${e.detail ? `<div class="vals">${esc(JSON.stringify(e.detail))}</div>` : ''}
      </div>`).join('') : '<p style="color:var(--muted)">暂无记录。</p>';
    $('#blind-events-modal').classList.add('show');
  } catch (e) {
    ctx.toast('读取操作记录失败：' + e.message, 'error');
  }
}
