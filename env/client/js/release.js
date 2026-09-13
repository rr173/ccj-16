// 发布快照标签页：预检 → 警告逐项确认 → 发布 / 下载 / 逐句对比 / 撤销
import { api } from './api.js';
import { state } from './state.js';
import { msToSrt } from './time.js';

let ctx = null;
const rel = { preflight: null, checked: new Set(), releases: [], revisions: [] };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initRelease(context) {
  ctx = context;
  document.querySelector('.tabs button[data-tab="release"]').addEventListener('click', refreshReleaseTab);
  $('#rel-check-btn').addEventListener('click', runPreflight);
  $('#rel-publish-btn').addEventListener('click', doPublish);
}

export async function refreshReleaseTab() {
  if (!state.project) return;
  const [{ revisions }, { releases }] = await Promise.all([
    api.listRevisions(state.project.id),
    api.releaseList(state.project.id),
  ]);
  rel.revisions = revisions;
  rel.releases = releases;
  const sel = $('#rel-rev-select');
  sel.innerHTML = revisions.map((r) =>
    `<option value="${r.id}" ${r.id === state.headRevId ? 'selected' : ''}>${esc((r.message || r.kind).slice(0, 24))} · ${r.id.slice(0, 8)}</option>`,
  ).join('');
  rel.preflight = null;
  $('#rel-preflight').innerHTML = '<p style="color:var(--muted)">选择版本后点击「预检」。</p>';
  $('#rel-publish-btn').disabled = true;
  renderReleases();
}

/* ==================== 预检与发布 ==================== */

async function runPreflight() {
  const revisionId = $('#rel-rev-select').value;
  try {
    rel.preflight = await api.releasePreflight(state.project.id, revisionId);
    rel.checked = new Set();
    renderPreflight();
  } catch (e) {
    ctx.toast('预检失败：' + e.message, 'error');
  }
}

function renderPreflight() {
  const p = rel.preflight;
  const wrap = $('#rel-preflight');
  if (!p) return;
  const parts = [];
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
    parts.push(`<div class="rel-gate warn">⚠ ${p.warningsPending.length} 条警告级问题需逐项确认：</div>`);
    parts.push(...p.warningsPending.map((f) =>
      `<label class="rel-item warn"><input type="checkbox" class="rel-warn-check" data-id="${f.id}" ${rel.checked.has(f.id) ? 'checked' : ''}/> 警告 · ${esc(f.cue_id)} · ${esc(f.evidence)}</label>`));
  }
  wrap.innerHTML = parts.join('');
  wrap.querySelectorAll('.rel-warn-check').forEach((c) => {
    c.addEventListener('change', () => {
      c.checked ? rel.checked.add(c.dataset.id) : rel.checked.delete(c.dataset.id);
      updatePublishBtn();
    });
  });
  updatePublishBtn();
}

function updatePublishBtn() {
  const p = rel.preflight;
  const btn = $('#rel-publish-btn');
  if (!p || !p.canPublish) {
    btn.disabled = true;
    btn.textContent = '确认并发布';
    return;
  }
  const left = p.warningsPending.filter((w) => !rel.checked.has(w.id)).length;
  btn.disabled = left > 0;
  btn.textContent = left > 0 ? `还有 ${left} 条警告未确认` : '确认并发布';
}

async function doPublish() {
  const p = rel.preflight;
  if (!p) return;
  const message = $('#rel-message').value.trim();
  try {
    const r = await api.releasePublish(state.project.id, {
      revisionId: p.revisionId,
      confirmations: p.warningsPending.map((w) => w.id),
      author: ctx.getAuthor(),
      message,
    });
    if (r.deduplicated) {
      ctx.toast(`该版本已发布过（${r.release.label}），未产生重复快照`, '');
    } else {
      ctx.toast(`已发布 ${r.release.label}`, 'ok');
    }
    ctx.refreshAudit?.();
    await refreshReleaseTab();
  } catch (e) {
    if (e.data?.preflight) {
      rel.preflight = e.data.preflight;
      renderPreflight();
    }
    ctx.toast('发布失败：' + e.message, 'error');
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
      <div class="meta">来源版本 <code>${esc(r.revision_id.slice(0, 10))}</code> · ${esc(r.author)} · ${new Date(r.created_at).toLocaleString()}</div>
      <div class="meta">质检摘要：阻断 ${s.blocker.total}（修复 ${s.blocker.fixed} / 忽略 ${s.blocker.ignored}）· 警告 ${s.warning.total}（确认 ${s.warning.confirmed.length} / 忽略 ${s.warning.ignored.length}）${r.message ? `<br/>说明：${esc(r.message)}` : ''}</div>
      ${r.status === 'withdrawn' ? `<div class="meta">撤销：${esc(r.withdrawn_by)} · ${new Date(r.withdrawn_at).toLocaleString()}${r.withdraw_reason ? ' · ' + esc(r.withdraw_reason) : ''}</div>` : ''}
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
