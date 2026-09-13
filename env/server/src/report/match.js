'use strict';
/**
 * 版本差异报告的句子匹配与逐项对比。
 *
 * 匹配分两级，绝不按数组下标比较：
 *  1) 稳定句子编号（cue id）直接配对——跨轨道移动、前后顺序变化都不受影响；
 *  2) id 对不上的句子（被删除后以新 id 重建等），用「时间接近度 + 文本相似度」
 *     加权打分做确定性贪心配对，避免把同一句的修改误报成「删除 + 新增」。
 *
 * 每个配对按字段展开成逐项差异：track（跨轨移动）/ time / text / lock，
 * 完全一致的配对记为 unchanged；未配对的句子记为 added / deleted。
 */

const DIFF_TYPES = ['added', 'deleted', 'track', 'time', 'text', 'lock', 'unchanged'];

/* ---------------- 文本相似度：字符 bigram 的 Dice 系数（对中日韩等无空格语言同样有效） ---------------- */

function bigramCounts(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

function textSimilarity(a, b) {
  a = String(a ?? '').trim();
  b = String(b ?? '').trim();
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  if (a.length === 1 || b.length === 1) return 0; // 单字无 bigram，且已确认不相等
  const A = bigramCounts(a);
  const B = bigramCounts(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  return (2 * inter) / ((a.length - 1) + (b.length - 1));
}

/* ---------------- 时间接近度：重叠率为主，无重叠时按间隔距离衰减 ---------------- */

function timeProximity(a, b) {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  if (union <= 0) return a.start === b.start ? 1 : 0;
  if (overlap > 0) return overlap / union;
  const gap = Math.max(a.start, b.start) - Math.min(a.end, b.end);
  return Math.max(0, 1 - gap / 2000) * 0.4; // 间隔 2s 内仍给部分分，避免轻微错位被判成两句
}

/**
 * 句子配对。返回 { pairs, added, deleted }：
 *  pairs: [{ a, b, matchedBy: 'id'|'content', similarity }]
 *  added/deleted: 未能配对的句子（b 侧新增 / a 侧删除）
 */
function matchCues(fromCues, toCues) {
  const fromById = new Map((fromCues || []).map((c) => [c.id, c]));
  const toById = new Map((toCues || []).map((c) => [c.id, c]));

  const pairs = [];
  const unmatchedFrom = [];
  const unmatchedTo = new Map();
  for (const a of fromCues || []) {
    const b = toById.get(a.id);
    if (b) pairs.push({ a, b, matchedBy: 'id', similarity: 1 });
    else unmatchedFrom.push(a);
  }
  for (const b of toCues || []) {
    if (!fromById.has(b.id)) unmatchedTo.set(b.id, b);
  }

  // 内容匹配：候选打分 = 0.65·文本相似 + 0.35·时间接近，阈值之上贪心配对。
  // 守卫条件防止「同一时间槽但文本几乎无关」或「文本相同但时间毫不相干」被强行配对。
  const candidates = [];
  for (const a of unmatchedFrom) {
    for (const [, b] of unmatchedTo) {
      const sim = textSimilarity(a.text, b.text);
      const time = timeProximity(a, b);
      const score = 0.65 * sim + 0.35 * time;
      if (score >= 0.45 && (sim >= 0.34 || time >= 0.9)) {
        candidates.push({ a, b, score, sim });
      }
    }
  }
  // 确定性排序：分数降序，平分按双方 id 字典序，保证同一输入永远得到同一报告
  candidates.sort((x, y) =>
    y.score - x.score ||
    (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0) ||
    (x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0),
  );
  const usedFrom = new Set();
  const usedTo = new Set();
  for (const c of candidates) {
    if (usedFrom.has(c.a.id) || usedTo.has(c.b.id)) continue;
    usedFrom.add(c.a.id);
    usedTo.add(c.b.id);
    pairs.push({ a: c.a, b: c.b, matchedBy: 'content', similarity: Math.round(c.sim * 1000) / 1000 });
    unmatchedTo.delete(c.b.id);
  }

  return {
    pairs,
    added: [...unmatchedTo.values()],
    deleted: unmatchedFrom.filter((c) => !usedFrom.has(c.id)),
  };
}

/* ---------------- 逐项差异展开 ---------------- */

const cueDigest = (c) => ({ trackId: c.trackId, start: c.start, end: c.end, text: c.text, locked: c.locked });

/**
 * 逐句对比两个快照。返回 { items, summary }。
 * item: { key, type, cueIdFrom, cueIdTo, trackId, trackIdFrom, trackIdTo, trackName,
 *         oldValue, newValue, matchedBy, similarity, start }
 */
function computeDiff(fromSnap, toSnap) {
  const fromTracks = new Map((fromSnap.tracks || []).map((t) => [t.id, t]));
  const toTracks = new Map((toSnap.tracks || []).map((t) => [t.id, t]));
  const trackNameOf = (trackId, preferTo = true) => {
    const t = (preferTo ? toTracks.get(trackId) : fromTracks.get(trackId)) || fromTracks.get(trackId) || toTracks.get(trackId);
    return t ? t.name : trackId;
  };

  const { pairs, added, deleted } = matchCues(fromSnap.cues || [], toSnap.cues || []);
  const items = [];
  const push = (it) => items.push(it);

  for (const p of pairs) {
    const { a, b } = p;
    const base = {
      cueIdFrom: a.id,
      cueIdTo: b.id,
      trackId: b.trackId,
      trackIdFrom: a.trackId,
      trackIdTo: b.trackId,
      trackName: trackNameOf(b.trackId),
      matchedBy: p.matchedBy,
      similarity: p.matchedBy === 'content' ? p.similarity : null,
      start: b.start,
    };
    let changed = false;
    if (a.trackId !== b.trackId) {
      changed = true;
      push({ ...base, key: `${a.id}:track`, type: 'track', oldValue: a.trackId, newValue: b.trackId });
    }
    if (a.start !== b.start || a.end !== b.end) {
      changed = true;
      push({
        ...base, key: `${a.id}:time`, type: 'time',
        oldValue: { start: a.start, end: a.end }, newValue: { start: b.start, end: b.end },
      });
    }
    if (a.text !== b.text) {
      changed = true;
      push({ ...base, key: `${a.id}:text`, type: 'text', oldValue: a.text, newValue: b.text });
    }
    if (Boolean(a.locked) !== Boolean(b.locked)) {
      changed = true;
      push({ ...base, key: `${a.id}:lock`, type: 'lock', oldValue: Boolean(a.locked), newValue: Boolean(b.locked) });
    }
    if (!changed) {
      push({ ...base, key: `${a.id}:unchanged`, type: 'unchanged', oldValue: cueDigest(a), newValue: cueDigest(b) });
    }
  }

  for (const b of added) {
    push({
      key: `${b.id}:added`, type: 'added',
      cueIdFrom: null, cueIdTo: b.id,
      trackId: b.trackId, trackIdFrom: null, trackIdTo: b.trackId,
      trackName: trackNameOf(b.trackId),
      oldValue: null, newValue: cueDigest(b),
      matchedBy: null, similarity: null, start: b.start,
    });
  }
  for (const a of deleted) {
    push({
      key: `${a.id}:deleted`, type: 'deleted',
      cueIdFrom: a.id, cueIdTo: null,
      trackId: a.trackId, trackIdFrom: a.trackId, trackIdTo: null,
      trackName: trackNameOf(a.trackId, false),
      oldValue: cueDigest(a), newValue: null,
      matchedBy: null, similarity: null, start: a.start,
    });
  }

  // 稳定排序：轨道 → 时间 → 句子 → 类型，保证同一输入的输出逐项一致
  const typeOrder = { added: 0, deleted: 1, track: 2, time: 3, text: 4, lock: 5, unchanged: 6 };
  items.sort((x, y) =>
    (x.trackId < y.trackId ? -1 : x.trackId > y.trackId ? 1 : 0) ||
    x.start - y.start ||
    ((x.cueIdTo || x.cueIdFrom) < (y.cueIdTo || y.cueIdFrom) ? -1 : 1) ||
    typeOrder[x.type] - typeOrder[y.type],
  );

  const byType = Object.fromEntries(DIFF_TYPES.map((t) => [t, 0]));
  const byTrack = {};
  for (const it of items) {
    byType[it.type]++;
    byTrack[it.trackId] = (byTrack[it.trackId] || 0) + 1;
  }
  return {
    items,
    summary: {
      total: items.length,
      byType,
      byTrack,
      matched: {
        byId: pairs.filter((p) => p.matchedBy === 'id').length,
        byContent: pairs.filter((p) => p.matchedBy === 'content').length,
      },
      cues: { from: (fromSnap.cues || []).length, to: (toSnap.cues || []).length },
    },
  };
}

module.exports = { DIFF_TYPES, textSimilarity, timeProximity, matchCues, computeDiff };
