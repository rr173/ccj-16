'use strict';
/**
 * 多版本盲审对照的分组与匿名化。
 *
 * 分组（绝不按数组下标、绝不硬配）——统一边模型：
 *  1) 稳定句子编号（cue id）相同的跨版本句子之间是满分边（最可靠）；
 *  2) 其余跨版本句子两两计算「文本相似度（字符 bigram Dice）+ 时间接近度」
 *     加权分（复用差异报告的度量），达阈值成为内容边；
 *  3) 全部边按确定性顺序贪心并查集合并，每组每个版本至多一句——
 *     因此「某版删除后以新编号重建」的句子会并入同编号组，而不是单列成新增；
 *  4) 一句在同一其他版本里有 ≥2 个强候选（稳定编号边也算强候选：拆分时其中
 *     一半往往保留原编号）→ 一对多（拆分/合并）无法可靠对应；该句所在的整个
 *     强候选连通分量整体排除（全部边不进对照项，分量内每句都单列为一对多），
 *     保证一对多内容全部单列、每个对照项每个版本至多一条。
 *
 * 匿名化：每位审阅人看到的候选顺序由 sha256(roundId:reviewer:itemKey) 确定性洗牌，
 * 同一审阅人稳定、不同审阅人彼此独立；映射只在服务端计算，不下发。
 */
const crypto = require('crypto');
const { textSimilarity, timeProximity } = require('../report/match');

// 与差异报告一致的内容匹配阈值
const PAIR_SCORE = 0.45;
const PAIR_SIM_GUARD = 0.34;
const PAIR_TIME_GUARD = 0.9;
// 强候选阈值（用于一对多判定）。time 取 0.5：一句被拆成两句时，
// 原句与每一半的时间重叠率约 0.5，阈值过高会漏判拆分导致硬配
const STRONG_SCORE = 0.6;
const STRONG_SIM = 0.5;
const STRONG_TIME = 0.5;

const REASON_NO_COUNTERPART = 'no-counterpart'; // 无可靠对应（新增/删除）
const REASON_ONE_TO_MANY = 'one-to-many';       // 一对多（拆分等），不能硬配成一组

function pairScore(a, b) {
  const sim = textSimilarity(a.text, b.text);
  const time = timeProximity(a, b);
  return { sim, time, score: 0.65 * sim + 0.35 * time };
}

function isPairCandidate(s) {
  return s.score >= PAIR_SCORE && (s.sim >= PAIR_SIM_GUARD || s.time >= PAIR_TIME_GUARD);
}

function isStrongCandidate(s) {
  return s.score >= STRONG_SCORE && s.sim >= STRONG_SIM && s.time >= STRONG_TIME;
}

/* ---------------- 并查集（确定性：按边分数降序合并） ---------------- */

function makeDisjointSet() {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    let cur = x;
    while (parent.get(cur) !== cur) { const nxt = parent.get(cur); parent.set(cur, r); cur = nxt; }
    return r;
  };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  return { add, find, union };
}

/**
 * 把 2~3 个版本的句子组成对照项。
 * versions: [{slot, cues:[{id, trackId, start, end, text, locked}], tracks}]
 * 返回 { items, unmatched }：
 *  items: [{key, matchedBy, similarity, candidates:[{slot, cueId, ...}]}]（≥2 个版本各至多一句）
 *  unmatched: [{slot, cueId, ..., reason}]（新增/删除/一对多，单列）
 */
function buildComparison(versions) {
  const trackNameOf = (slot, trackId) => {
    const v = versions.find((x) => x.slot === slot);
    const t = (v?.tracks || []).find((x) => x.id === trackId);
    return t ? t.name : trackId;
  };
  // 全部句子拍平：nodeId = `${slot}:${cueId}`
  const nodes = [];
  for (const v of versions) {
    const seen = new Set();
    for (const c of v.cues || []) {
      if (seen.has(c.id)) continue; // 同一快照内编号唯一（防御）
      seen.add(c.id);
      nodes.push({
        nodeId: `${v.slot}:${c.id}`,
        slot: v.slot,
        cueId: c.id,
        trackId: c.trackId,
        trackName: trackNameOf(v.slot, c.trackId),
        start: c.start,
        end: c.end,
        text: c.text,
        locked: Boolean(c.locked),
      });
    }
  }

  /* 边：稳定编号边（满分，最可靠）+ 内容相似边（加权分） */
  const edges = [];
  const strongEdges = []; // 强候选边：用于一对多判定（编号边也算强候选）
  const byCueId = new Map();
  for (const n of nodes) {
    if (!byCueId.has(n.cueId)) byCueId.set(n.cueId, []);
    byCueId.get(n.cueId).push(n);
  }
  for (const group of byCueId.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].slot === group[j].slot) continue;
        // 稳定编号是最可靠的对应；拆分时保留原编号的那一半同样计为强候选
        const e = { a: group[i], b: group[j], score: 1, via: 'id', sim: 1, time: 1 };
        edges.push(e);
        strongEdges.push(e);
      }
    }
  }
  const contentEdges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (a.slot === b.slot || a.cueId === b.cueId) continue;
      const s = pairScore(a, b);
      if (isPairCandidate(s)) {
        const e = { a, b, ...s, via: 'content' };
        edges.push(e);
        contentEdges.push(e);
        if (isStrongCandidate(s)) strongEdges.push(e);
      }
    }
  }

  /* 一对多判定：某句在同一其他版本有 ≥2 个强候选（含稳定编号边）→ 拆分/合并，
     无法可靠对应；该句所在的整个强候选连通分量整体排除——
     分量内所有句子都单列为一对多，其任何边（编号边/内容边）都不进对照项，
     保证一对多内容全部单列、每个对照项每个版本至多一条。 */
  const strongByNode = new Map(); // nodeId -> Map<otherSlot, count>
  for (const c of strongEdges) {
    for (const [self, other] of [[c.a, c.b], [c.b, c.a]]) {
      if (!strongByNode.has(self.nodeId)) strongByNode.set(self.nodeId, new Map());
      const m = strongByNode.get(self.nodeId);
      m.set(other.slot, (m.get(other.slot) || 0) + 1);
    }
  }
  const seeds = new Set(); // 一对多中心句
  for (const [nodeId, bySlot] of strongByNode) {
    for (const cnt of bySlot.values()) {
      if (cnt >= 2) seeds.add(nodeId);
    }
  }
  // 中心句沿强候选边扩展为整个连通分量
  const strongDS = makeDisjointSet();
  for (const n of nodes) strongDS.add(n.nodeId);
  for (const e of strongEdges) strongDS.union(e.a.nodeId, e.b.nodeId);
  const excluded = new Set(); // 一对多分量：全部单列，其边全部排除
  if (seeds.size) {
    const seedRoots = new Set();
    for (const id of seeds) seedRoots.add(strongDS.find(id));
    for (const n of nodes) if (seedRoots.has(strongDS.find(n.nodeId))) excluded.add(n.nodeId);
  }

  /* 贪心并查集合并：编号边优先，内容边按分数降序；每组每版本至多一句 */
  edges.sort((x, y) =>
    y.score - x.score ||
    (x.via === y.via ? 0 : x.via === 'id' ? -1 : 1) ||
    (x.a.nodeId < y.a.nodeId ? -1 : x.a.nodeId > y.a.nodeId ? 1 : 0) ||
    (x.b.nodeId < y.b.nodeId ? -1 : x.b.nodeId > y.b.nodeId ? 1 : 0),
  );
  const ds = makeDisjointSet();
  for (const n of nodes) ds.add(n.nodeId);
  const groupSlots = new Map(); // root -> Set<slot>
  for (const n of nodes) groupSlots.set(n.nodeId, new Set([n.slot])); // 单句组也登记本版本
  const groupEdges = new Map(); // root -> [contentScore,...]（组相似度取内容边最低分）
  const rootSlots = (root) => groupSlots.get(root) || new Set();
  for (const e of edges) {
    if (excluded.has(e.a.nodeId) || excluded.has(e.b.nodeId)) continue; // 一对多分量不配对
    const ra = ds.find(e.a.nodeId);
    const rb = ds.find(e.b.nodeId);
    if (ra === rb) continue;
    const slotsA = rootSlots(ra);
    const slotsB = rootSlots(rb);
    // 合并后同一版本出现两句 → 不允许（保持每组每版本至多一句）
    let clash = false;
    for (const s of slotsA) if (slotsB.has(s)) { clash = true; break; }
    if (clash) continue;
    ds.union(ra, rb);
    const root = ds.find(e.a.nodeId);
    const merged = new Set([...slotsA, ...slotsB]);
    groupSlots.set(root, merged);
    groupSlots.delete(root === ra ? rb : ra);
    const scores = [...(groupEdges.get(ra) || []), ...(groupEdges.get(rb) || [])];
    if (e.via === 'content') scores.push(e.score);
    groupEdges.set(root, scores);
    groupEdges.delete(root === ra ? rb : ra);
  }

  const groups = new Map(); // root -> [node]
  for (const n of nodes) {
    const root = ds.find(n.nodeId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(n);
  }
  const items = [];
  const unmatched = [];
  for (const [root, members] of groups) {
    if (members.length >= 2 && !members.some((m) => excluded.has(m.nodeId))) {
      const sameId = members.every((m) => m.cueId === members[0].cueId);
      const scores = groupEdges.get(root) || [];
      items.push({
        key: sameId ? `id:${members[0].cueId}` : `mx:${[...new Set(members.map((m) => m.cueId))].sort().join('+')}`,
        matchedBy: sameId ? 'id' : 'content',
        similarity: scores.length ? Math.round(Math.min(...scores) * 1000) / 1000 : null,
        candidates: members.map(stripNode),
      });
    } else {
      // 一对多分量内的每一句都标为一对多；其余落单句为无可靠对应
      for (const n of members) {
        unmatched.push({
          ...stripNode(n),
          reason: excluded.has(n.nodeId) ? REASON_ONE_TO_MANY : REASON_NO_COUNTERPART,
        });
      }
    }
  }

  // 对照项稳定排序：候选最早开始时间 → key
  for (const it of items) it.candidates.sort((x, y) => x.slot - y.slot);
  items.sort((x, y) => {
    const sx = Math.min(...x.candidates.map((c) => c.start));
    const sy = Math.min(...y.candidates.map((c) => c.start));
    return sx - sy || (x.key < y.key ? -1 : 1);
  });
  unmatched.sort((x, y) => x.start - y.start || x.slot - y.slot || (x.cueId < y.cueId ? -1 : 1));
  return { items, unmatched };
}

function stripNode(n) {
  return {
    slot: n.slot,
    cueId: n.cueId,
    trackId: n.trackId,
    trackName: n.trackName,
    start: n.start,
    end: n.end,
    text: n.text,
    locked: n.locked,
  };
}

/* ---------------- 审阅人独立的匿名候选顺序 ---------------- */

const LABELS = ['A', 'B', 'C'];

/** 确定性洗牌种子：同一（轮次, 审阅人, 对照项）永远得到同一顺序 */
function seedFor(roundId, reviewer, itemKey) {
  return crypto.createHash('sha256').update(`blind:${roundId}:${reviewer}:${itemKey}`).digest();
}

/**
 * 把对照项的候选槽位映射为该审阅人的匿名标签顺序。
 * 返回 [{label:'A'|'B'|'C', slot}]，按标签序（即审阅人看到的展示顺序）。
 */
function anonymize(roundId, reviewer, itemKey, slots) {
  const order = [...slots];
  const seed = seedFor(roundId, reviewer, itemKey);
  // Fisher-Yates，用种子字节做确定性随机源（候选最多 3 个，种子 32 字节足够）
  for (let i = order.length - 1, k = 0; i > 0; i--, k++) {
    const j = seed[k] % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.map((slot, idx) => ({ label: LABELS[idx], slot }));
}

/** 审阅人视角：候选按匿名标签排列（不含槽位/版本信息） */
function labelOrder(roundId, reviewer, item) {
  const slots = item.candidates.map((c) => c.slot);
  return anonymize(roundId, reviewer, item.key, slots).map(({ label, slot }) => ({
    label,
    candidate: item.candidates.find((c) => c.slot === slot),
  }));
}

/** 服务端解码：审阅人提交的匿名标签 → 候选槽位；标签非法返回 null */
function decodeLabel(roundId, reviewer, itemKey, slots, label) {
  const map = anonymize(roundId, reviewer, itemKey, slots);
  const hit = map.find((m) => m.label === label);
  return hit ? hit.slot : null;
}

/** 服务端编码：存储的候选槽位 → 该审阅人的匿名标签 */
function encodeSlot(roundId, reviewer, itemKey, slots, slot) {
  const map = anonymize(roundId, reviewer, itemKey, slots);
  const hit = map.find((m) => m.slot === slot);
  return hit ? hit.label : null;
}

module.exports = {
  REASON_NO_COUNTERPART,
  REASON_ONE_TO_MANY,
  buildComparison,
  anonymize,
  labelOrder,
  decodeLabel,
  encodeSlot,
  pairScore,
};
