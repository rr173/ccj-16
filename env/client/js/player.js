import { state, emit, subscribe } from './state.js';
import { msToSrt } from './time.js';

/**
 * 预览时钟：不使用 setInterval 累加，而是以 performance.now() 为挂钟锚点换算内容时间。
 *   contentTime = heldTime + (wallNow - anchorWall) * speed   （播放中）
 * 暂停、切变速、拖动进度条都重新锚定，保证始终是同一内容时刻、无漂移。
 */
let anchorWall = 0;
let rafId = null;

export function initPlayer() {
  const playBtn = document.getElementById('play-btn');
  const scrub = document.getElementById('preview-scrub');
  const speedSel = document.getElementById('preview-speed');

  playBtn.addEventListener('click', () => (state.player.playing ? pause() : play()));
  scrub.addEventListener('input', () => seek(Number(scrub.value)));
  speedSel.addEventListener('change', () => setSpeed(Number(speedSel.value)));

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      state.player.playing ? pause() : play();
    }
  });

  subscribe((reason) => {
    if (reason === 'load') {
      stopLoop();
      state.player.playing = false;
      state.player.time = 0;
      scrub.max = state.snapshot.duration;
      scrub.value = 0;
      speedSel.value = String(state.player.speed);
      render();
    }
    if (['player', 'select', 'drag', 'cue-edit', 'tracks'].includes(reason)) render();
  });
}

export function play() {
  const p = state.player;
  if (!state.snapshot) return;
  if (p.time >= state.snapshot.duration) p.time = 0;
  p.playing = true;
  anchorWall = performance.now();
  document.getElementById('play-btn').textContent = '⏸';
  if (!rafId) loop();
}

export function pause() {
  const p = state.player;
  if (p.playing) {
    p.time = currentTime();
    anchorWall = performance.now();
  }
  p.playing = false;
  document.getElementById('play-btn').textContent = '▶';
}

export function setSpeed(speed) {
  const p = state.player;
  if (p.playing) {
    p.time = currentTime();
    anchorWall = performance.now();
  }
  p.speed = speed;
}

export function seek(t) {
  const p = state.player;
  t = Math.max(0, Math.min(Math.round(t), state.snapshot?.duration || 0));
  p.time = t;
  anchorWall = performance.now();
  render();
  emit('player');
}

export function currentTime() {
  const p = state.player;
  if (!p.playing) return p.time;
  return p.time + (performance.now() - anchorWall) * p.speed;
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function loop() {
  const snap = state.snapshot;
  if (!snap) { stopLoop(); return; }
  const p = state.player;
  if (p.playing) {
    const t = currentTime();
    if (t >= snap.duration) {
      p.time = snap.duration;
      pause();
    }
    render();
  }
  rafId = p.playing ? requestAnimationFrame(loop) : null;
}

function render() {
  const snap = state.snapshot;
  if (!snap) return;
  const t = currentTime();
  document.getElementById('time-current').textContent = msToSrt(t);
  document.getElementById('time-total').textContent = msToSrt(snap.duration);
  const scrub = document.getElementById('preview-scrub');
  scrub.max = snap.duration;
  scrub.value = Math.round(t);

  // 精确同步：当前时刻落在 [start, end) 内的句子才显示；隐藏轨道只影响显示，不影响时钟
  const active = snap.cues.filter(
    (c) => t >= c.start && t < c.end && !state.hiddenTracks.has(c.trackId),
  );
  document.getElementById('subtitle-overlay').textContent = active
    .map((c) => c.text)
    .filter(Boolean)
    .join('\n');

  document.getElementById('playhead').style.left = 14 + t * state.zoom + 'px';
}

export function renderPlayer() { render(); }
