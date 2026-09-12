import { uid } from './time.js';

/**
 * 全局应用状态。
 * snapshot  : 当前编辑中的项目快照（duration/tracks/cues/settings）
 * baseRevId : snapshot 所基于（已同步）的服务器版本，保存时作为三向合并的共同祖先
 * headRevId : 已知的最新 HEAD
 * viewing   : 正在浏览的历史版本（非 HEAD 时只读）
 */
const listeners = new Set();

export const state = {
  project: null,
  snapshot: null,
  baseRevId: null,
  headRevId: null,
  viewingRevId: null,
  readOnly: false,
  selectedCueId: null,
  hiddenTracks: new Set(),
  dirty: false,
  // 冲突解决会话
  conflictSession: null,
  // 播放器
  player: { playing: false, time: 0, speed: 1 },
  zoom: 0.08, // px / ms
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(reason) { for (const fn of listeners) fn(reason); }

export function setDirty(v = true) {
  state.dirty = v && !state.readOnly;
  emit('dirty');
}

export function loadProject(project, head, { readOnly = false, viewingRevId = null } = {}) {
  state.project = project;
  state.snapshot = JSON.parse(JSON.stringify(head.snapshot));
  state.baseRevId = head.id;
  state.headRevId = project.head_id;
  state.viewingRevId = readOnly ? viewingRevId : null;
  state.readOnly = readOnly;
  state.selectedCueId = null;
  state.dirty = false;
  state.conflictSession = null;
  state.hiddenTracks = new Set();
  state.player.time = 0;
  state.player.playing = false;
  emit('load');
}

export function cueById(id) {
  return state.snapshot.cues.find((c) => c.id === id);
}

export function updateCue(id, patch) {
  if (state.readOnly) return;
  const c = cueById(id);
  if (!c) return;
  if (c.locked && !('locked' in patch && Object.keys(patch).length === 1)) return;
  Object.assign(c, patch);
  setDirty();
  emit('cue-edit');
}

export function addCue(trackId) {
  if (state.readOnly) return;
  const t = state.player.time || 0;
  const cue = {
    id: uid('c'),
    trackId: trackId || state.snapshot.tracks[0]?.id,
    start: Math.round(t),
    end: Math.min(state.snapshot.duration, Math.round(t) + 1500),
    text: '新句子',
    locked: false,
  };
  state.snapshot.cues.push(cue);
  state.selectedCueId = cue.id;
  setDirty();
  emit('cue-edit');
}

export function deleteCue(id) {
  if (state.readOnly) return;
  const c = cueById(id);
  if (!c || c.locked) return;
  state.snapshot.cues = state.snapshot.cues.filter((x) => x.id !== id);
  if (state.selectedCueId === id) state.selectedCueId = null;
  setDirty();
  emit('cue-edit');
}

export function addTrack() {
  if (state.readOnly) return;
  state.snapshot.tracks.push({
    id: uid('t'), name: `轨道 ${state.snapshot.tracks.length + 1}`,
    color: '#' + Math.floor(Math.random() * 0x606060 + 0x808080).toString(16).padStart(6, '0'),
    mutexGroup: null,
  });
  setDirty();
  emit('tracks');
}

/** 应用拖动结果：Map<id, 新cue对象>。锁定句（拖动结果中不应出现）永不被写入。 */
export function applyDrag(result) {
  if (state.readOnly) return;
  for (const [id, next] of result) {
    const c = cueById(id);
    if (!c || c.locked) continue;
    c.start = next.start;
    c.end = next.end;
  }
  setDirty();
  emit('drag');
}

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});
