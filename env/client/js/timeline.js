import { state, emit, applyDrag } from './state.js';
import { violatedCueIds } from './rules.js';
import { dragLeft, dragRight, dragMove } from './rules.js';
import { msToSrt } from './time.js';

const LANE_H = 64;
let violations = new Map();

export function initTimeline() {
  document.getElementById('timeline-wrap').addEventListener('click', (e) => {
    if (e.target.closest('.cue-block')) return;
    // 点击空白轨道：把播放头移到该时刻
    const lane = e.target.closest('.lane');
    if (lane) {
      const x = e.clientX - lane.getBoundingClientRect().left + document.getElementById('timeline-wrap').scrollLeft - 14;
      state.player.time = Math.round(Math.max(0, x / state.zoom));
      emit('player');
    }
  });
}

export function renderTimeline() {
  const snap = state.snapshot;
  if (!snap) return;
  violations = violatedCueIds(snap);
  renderRuler(snap.duration);

  const lanes = document.getElementById('lanes');
  lanes.innerHTML = '';
  const widthPx = snap.duration * state.zoom;
  for (const t of snap.tracks) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.width = widthPx + 'px';
    const label = document.createElement('span');
    label.className = 'lane-label';
    label.textContent = t.name + (t.mutexGroup ? ` · 互斥:${t.mutexGroup}` : '');
    lane.appendChild(label);
    for (const c of snap.cues.filter((c) => c.trackId === t.id)) {
      lane.appendChild(renderCueBlock(c, t.color));
    }
    lanes.appendChild(lane);
  }
  document.getElementById('timeline').style.width = widthPx + 14 + 'px';
  updatePlayhead();
}

function renderRuler(duration) {
  const ruler = document.getElementById('ruler');
  ruler.innerHTML = '';
  const pxPerMs = state.zoom;
  const targetPx = 110;
  const raw = targetPx / pxPerMs;
  const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
  const step = steps.find((s) => s * pxPerMs >= targetPx) || 600000;
  ruler.style.width = duration * pxPerMs + 'px';
  for (let t = 0; t <= duration; t += step) {
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = t * pxPerMs + 'px';
    const span = document.createElement('span');
    span.textContent = msToSrt(t);
    tick.appendChild(span);
    ruler.appendChild(tick);
  }
}

function renderCueBlock(cue, color) {
  const block = document.createElement('div');
  block.className = 'cue-block';
  block.dataset.id = cue.id;
  if (cue.id === state.selectedCueId) block.classList.add('selected');
  if (cue.locked) block.classList.add('locked');
  const types = violations.get(cue.id);
  if (types) {
    if (types.has('reverse')) block.classList.add('bad-reverse');
    if (types.has('overlap')) block.classList.add('bad-overlap');
    if (types.has('mutex')) block.classList.add('bad-mutex');
    block.title = [...types].join(', ');
  }
  block.style.left = cue.start * state.zoom + 'px';
  block.style.width = Math.max(4, (cue.end - cue.start) * state.zoom) + 'px';
  block.style.setProperty('--cue-color', cue.locked ? '#6b7686' : color);

  const text = document.createElement('span');
  text.className = 'cue-text';
  text.textContent = cue.text || '(空)';
  block.appendChild(text);

  for (const side of ['l', 'r']) {
    const h = document.createElement('div');
    h.className = `handle ${side}`;
    h.dataset.side = side;
    block.appendChild(h);
  }

  block.addEventListener('mousedown', onCueMouseDown);
  return block;
}

function onCueMouseDown(e) {
  if (state.readOnly) return;
  const block = e.currentTarget;
  const id = block.dataset.id;
  const cue = state.snapshot.cues.find((c) => c.id === id);
  if (!cue) return;

  const side = e.target.dataset.side;
  if (cue.locked && side) return;

  const startX = e.clientX;
  const origStart = cue.start;
  const origEnd = cue.end;
  const moved = { v: false };

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (Math.abs(dx) < 3 && !moved.v) return;
    moved.v = true;
    const dms = dx / state.zoom;
    const snap = state.snapshot;
    let result;
    if (side === 'l') {
      result = dragLeft(id, origStart + dms, snap.cues, snap.tracks);
    } else if (side === 'r') {
      result = dragRight(id, origEnd + dms, snap.cues, snap.tracks, snap.duration);
    } else {
      if (cue.locked) return;
      result = dragMove(id, origStart + dms, snap.cues, snap.tracks, snap.duration);
    }
    applyDrag(result);
    if (state.selectedCueId !== id) {
      state.selectedCueId = id;
      emit('select');
    }
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (!moved.v) {
      // 视为点选
      state.selectedCueId = id;
      state.player.time = cue.start;
      emit('select');
    }
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  e.preventDefault();
}

export function updatePlayhead() {
  if (!state.snapshot) return;
  document.getElementById('playhead').style.left = 14 + state.player.time * state.zoom + 'px';
}

/** 外部（列表等）选中后滚动到该句 */
export function scrollToCue(id) {
  const block = document.querySelector(`.cue-block[data-id="${id}"]`);
  if (block) block.scrollIntoView({ block: 'nearest', inline: 'center' });
}
