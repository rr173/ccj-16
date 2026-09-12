'use strict';
/**
 * 快照规范化与规则校验。
 *
 * 统一时间基准：start/end 一律为整数毫秒。
 * violations:
 *   reverse   —— 反向区间（end <= start），属硬错误，拒绝提交
 *   overlap   —— 同一轨内时间重叠，警告（仍可保存，但界面即时标红）
 *   mutex     —— 跨轨互斥组在同一时刻只能出现一条字幕，冲突即时标红
 */

const MIN_DURATION = 100;

function normalizeSnapshot(snap) {
  if (!snap || typeof snap !== 'object') throw new Error('snapshot 无效');
  const tracksRaw = Array.isArray(snap.tracks) ? snap.tracks : [];
  const cuesRaw = Array.isArray(snap.cues) ? snap.cues : [];

  const tracks = [];
  const seenTrack = new Set();
  for (const t of tracksRaw) {
    if (!t || typeof t.id !== 'string' || seenTrack.has(t.id)) continue;
    seenTrack.add(t.id);
    tracks.push({
      id: t.id,
      name: String(t.name ?? '轨道'),
      color: String(t.color ?? '#4e8cff'),
      mutexGroup: t.mutexGroup == null ? null : String(t.mutexGroup),
    });
  }

  const cues = [];
  const seenCue = new Set();
  for (const c of cuesRaw) {
    if (!c || typeof c.id !== 'string' || seenCue.has(c.id)) continue;
    if (!seenTrack.has(c.trackId)) continue; // 丢弃孤儿
    seenCue.add(c.id);
    const start = Math.max(0, Math.round(Number(c.start) || 0));
    const end = Math.round(Number(c.end) || 0);
    cues.push({
      id: c.id,
      trackId: c.trackId,
      start,
      end,
      text: String(c.text ?? ''),
      locked: Boolean(c.locked),
    });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);

  const duration = Math.max(
    MIN_DURATION,
    Math.round(Number(snap.duration) || 0),
    ...cues.map((c) => c.end),
  );

  return {
    duration,
    tracks,
    cues,
    settings: snap.settings && typeof snap.settings === 'object' ? snap.settings : {},
  };
}

/** 返回 { hardErrors: [...], violations:[{type,cueIds,trackId?,message}] } */
function validate(snap) {
  const hardErrors = [];
  const violations = [];

  for (const c of snap.cues) {
    if (c.end <= c.start) {
      hardErrors.push({
        type: 'reverse',
        cueId: c.id,
        message: `句子 ${c.id} 时间反向（结束 ${c.end} ≤ 开始 ${c.start}）`,
      });
    }
  }

  // 同轨重叠
  const byTrack = new Map();
  for (const c of snap.cues) {
    if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
    byTrack.get(c.trackId).push(c);
  }
  for (const [trackId, list] of byTrack) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < list[i - 1].end && list[i - 1].end > list[i].start) {
        violations.push({
          type: 'overlap',
          trackId,
          cueIds: [list[i - 1].id, list[i].id],
          message: `轨道内重叠：${list[i - 1].id} 与 ${list[i].id}`,
        });
      }
    }
  }

  // 跨轨互斥
  const groups = new Map();
  for (const t of snap.tracks) {
    if (t.mutexGroup) {
      if (!groups.has(t.mutexGroup)) groups.set(t.mutexGroup, []);
      groups.get(t.mutexGroup).push(t.id);
    }
  }
  for (const [group, trackIds] of groups) {
    const list = snap.cues
      .filter((c) => trackIds.includes(c.trackId))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      if (b.start < a.end && a.trackId !== b.trackId) {
        violations.push({
          type: 'mutex',
          mutexGroup: group,
          cueIds: [a.id, b.id],
          message: `互斥组「${group}」跨轨冲突：${a.id} 与 ${b.id}`,
        });
      }
    }
  }

  return { hardErrors, violations };
}

/** 生成相对上一版本的审计差异（parentSnap = 主父快照）。 */
function diffForAudit(parentSnap, newSnap) {
  const entries = [];
  const describe = (v) => (v === undefined ? null : JSON.stringify(v));

  const cueFields = ['trackId', 'start', 'end', 'text', 'locked'];
  const pCues = new Map((parentSnap?.cues || []).map((c) => [c.id, c]));
  const nCues = new Map((newSnap.cues || []).map((c) => [c.id, c]));
  for (const id of new Set([...pCues.keys(), ...nCues.keys()])) {
    const p = pCues.get(id);
    const n = nCues.get(id);
    if (p && !n) {
      entries.push({ field: `cue:${id}`, action: 'delete', oldValue: describe(p), newValue: null });
    } else if (!p && n) {
      entries.push({ field: `cue:${id}`, action: 'add', oldValue: null, newValue: describe(n) });
    } else if (p && n) {
      for (const f of cueFields) {
        if (JSON.stringify(p[f]) !== JSON.stringify(n[f])) {
          entries.push({
            field: `cue:${id}:${f}`,
            action: 'edit',
            oldValue: describe(p[f]),
            newValue: describe(n[f]),
          });
        }
      }
    }
  }

  const trackFields = ['name', 'color', 'mutexGroup'];
  const pTracks = new Map((parentSnap?.tracks || []).map((t) => [t.id, t]));
  const nTracks = new Map((newSnap.tracks || []).map((t) => [t.id, t]));
  for (const id of new Set([...pTracks.keys(), ...nTracks.keys()])) {
    const p = pTracks.get(id);
    const n = nTracks.get(id);
    if (p && !n) {
      entries.push({ field: `track:${id}`, action: 'delete', oldValue: describe(p), newValue: null });
    } else if (!p && n) {
      entries.push({ field: `track:${id}`, action: 'add', oldValue: null, newValue: describe(n) });
    } else if (p && n) {
      for (const f of trackFields) {
        if (JSON.stringify(p[f]) !== JSON.stringify(n[f])) {
          entries.push({
            field: `track:${id}:${f}`,
            action: 'edit',
            oldValue: describe(p[f]),
            newValue: describe(n[f]),
          });
        }
      }
    }
  }
  return entries;
}

module.exports = { normalizeSnapshot, validate, diffForAudit, MIN_DURATION };
