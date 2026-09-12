import { state } from './state.js';

/**
 * 打开冲突解决。
 * session = { merged, conflicts, base, head, mineSnapshot, choices: Map<key, 'mine'|'theirs'> }
 * merged 是服务器已自动合好的完整快照（冲突点为占位值），用户选择后在其基础上改写。
 */
export function openConflictModal(result, mineSnapshot, onConfirm, onCancel) {
  const session = {
    merged: JSON.parse(JSON.stringify(result.merged)),
    conflicts: result.conflicts,
    head: result.head,
    base: result.base,
    mineSnapshot,
    choices: new Map(),
  };
  state.conflictSession = session;

  const list = document.getElementById('conflict-list');
  list.innerHTML = '';

  session.conflicts.forEach((conflict, idx) => {
    const key = conflictKey(conflict);
    const card = document.createElement('div');
    card.className = 'conflict-card';
    card.innerHTML = `<h3>${conflictTitle(conflict)}</h3><div class="conflict-choice"></div>`;
    const choiceBox = card.querySelector('.conflict-choice');

    const mineDesc = describeSide(conflict, 'mine');
    const theirsDesc = describeSide(conflict, 'theirs');

    const options = [
      { side: 'mine', label: '保留我的版本', desc: mineDesc },
      { side: 'theirs', label: '采用对方版本', desc: theirsDesc },
    ].filter((o) => o.desc !== null);

    options.forEach((o) => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="radio" name="conf-${idx}" value="${o.side}" />
        <b>${o.label}</b><pre>${o.desc ?? '(无)'}</pre>`;
      label.addEventListener('click', () => {
        session.choices.set(key, o.side);
        choiceBox.querySelectorAll('label').forEach((l) => l.classList.toggle('picked', l === label));
      });
      choiceBox.appendChild(label);
    });

    list.appendChild(card);
  });

  const modal = document.getElementById('conflict-modal');
  modal.classList.add('show');

  const confirmBtn = document.getElementById('conflict-confirm');
  const cancelBtn = document.getElementById('conflict-cancel');

  const cleanup = () => {
    modal.classList.remove('show');
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
    state.conflictSession = null;
  };
  confirmBtn.onclick = () => {
    const unresolved = session.conflicts.filter((c) => !session.choices.has(conflictKey(c)));
    if (unresolved.length) {
      alert(`还有 ${unresolved.length} 处冲突未选择`);
      return;
    }
    const resolvedSnapshot = applyChoices(session);
    cleanup();
    onConfirm(resolvedSnapshot, session);
  };
  cancelBtn.onclick = () => { cleanup(); onCancel?.(); };
}

/** 根据用户选择，把每个冲突点落实到 merged 快照中。 */
function applyChoices(session) {
  const snap = session.merged;
  const cuesById = new Map(snap.cues.map((c) => [c.id, c]));
  const tracksById = new Map(snap.tracks.map((t) => [t.id, t]));

  for (const conflict of session.conflicts) {
    const side = session.choices.get(conflictKey(conflict));
    const chosen = sideEntity(conflict, side);

    if (conflict.kind === 'edit-edit') {
      const target = conflict.entity === 'cue' ? cuesById.get(conflict.id) : tracksById.get(conflict.id);
      for (const fc of conflict.fields) {
        // 一张卡片代表该实体的冲突字段集合，选一方即取该方全部冲突字段，非冲突字段保持自动合并结果
        target[fc.field] = chosen[fc.field];
      }
    } else if (conflict.kind === 'delete-edit') {
      // 对方改了、我删了
      if (side === 'mine') {
        if (conflict.entity === 'cue') snap.cues = snap.cues.filter((c) => c.id !== conflict.id);
        else {
          snap.tracks = snap.tracks.filter((t) => t.id !== conflict.id);
          snap.cues = snap.cues.filter((c) => c.trackId !== conflict.id);
        }
      } // theirs：merged 占位中已保留
    } else if (conflict.kind === 'edit-delete') {
      // 我改了、对方删了
      if (side === 'theirs') {
        if (conflict.entity === 'cue') snap.cues = snap.cues.filter((c) => c.id !== conflict.id);
        else {
          snap.tracks = snap.tracks.filter((t) => t.id !== conflict.id);
          snap.cues = snap.cues.filter((c) => c.trackId !== conflict.id);
        }
      } // mine：merged 占位中已保留
    } else if (conflict.kind === 'add-add') {
      const target = conflict.entity === 'cue' ? cuesById.get(conflict.id) : tracksById.get(conflict.id);
      Object.assign(target, chosen);
    } else if (conflict.kind === 'orphan-cue') {
      if (side === 'theirs') snap.cues = snap.cues.filter((c) => c.id !== conflict.id);
      // 选择保留我的句子时，其所属轨道若在合并中被删，需要一并找回
      if (side === 'mine' && chosen) {
        const mineTrack = session.mineSnapshot.tracks.find((t) => t.id === chosen.trackId);
        if (mineTrack && !tracksById.has(mineTrack.id)) {
          snap.tracks.push(mineTrack);
          tracksById.set(mineTrack.id, mineTrack);
        }
      }
    }
  }

  // 轨道被删除时级联其下句子
  const trackIds = new Set(snap.tracks.map((t) => t.id));
  snap.cues = snap.cues.filter((c) => trackIds.has(c.trackId));
  snap.cues.sort((a, b) => a.start - b.start);
  return snap;
}

function sideEntity(conflict, side) {
  return side === 'mine' ? conflict.mine : conflict.theirs;
}

function conflictKey(c) {
  if (c.kind === 'edit-edit') return `${c.entity}:${c.id}:${c.fields.map((f) => f.field).join(',')}`;
  return `${c.entity}:${c.id}:${c.kind}`;
}

function conflictTitle(c) {
  const what = c.entity === 'cue' ? '句子' : '轨道';
  if (c.kind === 'edit-edit') {
    const fl = c.fields.map((f) => ({ trackId: '所属轨', start: '开始时间', end: '结束时间', text: '文本', locked: '锁定', name: '名称', color: '颜色', mutexGroup: '互斥组' }[f.field] || f.field)).join('、');
    return `${what} ${c.id}：双方都修改了「${fl}」`;
  }
  if (c.kind === 'delete-edit') return `${what} ${c.id}：你已删除，但对方修改了它`;
  if (c.kind === 'edit-delete') return `${what} ${c.id}：你修改了它，但对方已删除`;
  if (c.kind === 'add-add') return `${what} ${c.id}：双方都新增了同一 id`;
  if (c.kind === 'orphan-cue') return `句子 ${c.id}：轨道在一边被删除`;
  return c.id;
}

function describeSide(c, side) {
  const e = sideEntity(c, side);
  if (!e) return '（删除）';
  if (c.kind === 'edit-edit') {
    return c.fields.map((f) => `${f.field}: ${JSON.stringify(sideEntity(c, side)[f.field])}`).join('\n');
  }
  return JSON.stringify(e, null, 1);
}
