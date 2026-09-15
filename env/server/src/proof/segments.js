'use strict';
/**
 * 校对批次自动切片。
 *
 * 规则（连续且不重叠）：
 *   1. 只取参与轨道上的字幕，按 (start,end,id) 排序，轨道间在时间上交叠的字幕
 *      必须落在同一片段（避免后续合入时跨片段互相影响）。
 *   2. 相邻字幕之间的空隙 > gapMs 时优先在此切开（gapMs=0 表示不因空隙切）。
 *   3. 继续纳入会使片段时间跨度（首句开始 → 最晚结束）超过 maxSegmentMs 时，
 *      在下一句之前切开。
 *   4. 若新句本身与当前片段已有时段交叠，则第 3 步不切（交叠永不跨片段），
 *      作为「单句超长 / 跨轨交叠」的必要例外保留。
 *
 * 片段之间在时间区间上严格不重叠；每条字幕恰好出现在一个片段。
 */

const DEFAULT_GAP_MS = 2000;
const DEFAULT_MAX_SEGMENT_MS = 30000;
const MIN_MAX_SEGMENT_MS = 1000;
const MAX_MAX_SEGMENT_MS = 6 * 3600 * 1000;

function normalizeParams({ gapMs, maxSegmentMs } = {}) {
  const gap = Math.round(Number(gapMs ?? DEFAULT_GAP_MS));
  const max = Math.round(Number(maxSegmentMs ?? DEFAULT_MAX_SEGMENT_MS));
  if (!Number.isFinite(gap) || gap < 0) throw new Error('空隙阈值应为非负整数毫秒');
  if (!Number.isFinite(max) || max < MIN_MAX_SEGMENT_MS || max > MAX_MAX_SEGMENT_MS) {
    throw new Error(`最大片段时长应在 ${MIN_MAX_SEGMENT_MS} ~ ${MAX_MAX_SEGMENT_MS} 毫秒之间`);
  }
  return { gapMs: gap, maxSegmentMs: max };
}

/**
 * @param snapshot 基准版本快照 {tracks,cues,...}
 * @param opts {trackIds:string[], gapMs:number, maxSegmentMs:number}
 * @returns {{segments: Array<{seq,startMs,endMs,cueIds,cues}>, params}}
 */
function planSegments(snapshot, opts = {}) {
  const { gapMs, maxSegmentMs } = normalizeParams(opts);

  const tracks = Array.isArray(snapshot?.tracks) ? snapshot.tracks : [];
  const trackName = new Map(tracks.map((t) => [t.id, String(t.name ?? t.id)]));
  const allowed = new Set(
    Array.isArray(opts.trackIds) && opts.trackIds.length
      ? opts.trackIds.filter((id) => trackName.has(String(id))).map(String)
      : tracks.map((t) => t.id),
  );
  if (Array.isArray(opts.trackIds) && opts.trackIds.length && allowed.size === 0) {
    throw new Error('所选轨道在该版本中不存在');
  }

  const cues = (Array.isArray(snapshot?.cues) ? snapshot.cues : [])
    .filter((c) => c && allowed.has(c.trackId))
    .map((c) => ({
      id: String(c.id),
      trackId: String(c.trackId),
      start: Math.max(0, Math.round(Number(c.start) || 0)),
      end: Math.round(Number(c.end) || 0),
      text: String(c.text ?? ''),
      locked: Boolean(c.locked),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : 1));

  const segments = [];
  let cur = null;
  for (const cue of cues) {
    if (!cur) {
      cur = { startMs: cue.start, endMs: cue.end, cues: [cue] };
      continue;
    }
    const overlapsCurrent = cue.start < cur.endMs;
    const gapBreak = !overlapsCurrent && gapMs > 0 && cue.start - cur.endMs > gapMs;
    const wouldExceed = Math.max(cur.endMs, cue.end) - cur.startMs > maxSegmentMs;
    // 交叠的字幕永远不切开（跨片段重叠会破坏不重叠不变量）
    if (!overlapsCurrent && (gapBreak || wouldExceed)) {
      push(segments, cur);
      cur = { startMs: cue.start, endMs: cue.end, cues: [cue] };
    } else {
      cur.cues.push(cue);
      cur.endMs = Math.max(cur.endMs, cue.end);
    }
  }
  if (cur) push(segments, cur);

  return {
    segments: segments.map((s) => ({
      ...s,
      cueIds: s.cues.map((c) => c.id),
      cues: s.cues.map((c) => ({ cue: c, trackName: trackName.get(c.trackId) || c.trackId })),
    })),
    params: { gapMs, maxSegmentMs, trackIds: [...allowed] },
  };
}

function push(list, cur) {
  list.push({ seq: list.length + 1, startMs: cur.startMs, endMs: cur.endMs, cues: cur.cues });
}

module.exports = {
  planSegments,
  normalizeParams,
  DEFAULT_GAP_MS,
  DEFAULT_MAX_SEGMENT_MS,
  MIN_MAX_SEGMENT_MS,
  MAX_MAX_SEGMENT_MS,
};
