'use strict';
/** 发布快照与任意后续版本的逐句差异对比。 */

const CUE_FIELDS = ['trackId', 'start', 'end', 'text', 'locked'];
const TRACK_FIELDS = ['name', 'color', 'mutexGroup'];

function diffEntities(baseArr, otherArr, fields) {
  const base = new Map((baseArr || []).map((e) => [e.id, e]));
  const other = new Map((otherArr || []).map((e) => [e.id, e]));
  const out = [];
  for (const id of new Set([...base.keys(), ...other.keys()])) {
    const b = base.get(id);
    const o = other.get(id);
    if (b && !o) {
      out.push({ id, type: 'removed', item: b });
    } else if (!b && o) {
      out.push({ id, type: 'added', item: o });
    } else {
      const changes = {};
      for (const f of fields) {
        if (JSON.stringify(b[f]) !== JSON.stringify(o[f])) {
          changes[f] = { from: b[f], to: o[f] };
        }
      }
      if (Object.keys(changes).length) out.push({ id, type: 'changed', changes, item: o });
    }
  }
  return out;
}

/**
 * 逐句对比：fromSnap（快照冻结内容）→ toSnap（任意后续版本）。
 * 返回 { cues, tracks, summary }；cues 按类型与 id 排序，便于逐句展示。
 */
function diffSnapshots(fromSnap, toSnap) {
  const cues = diffEntities(fromSnap.cues, toSnap.cues, CUE_FIELDS);
  const tracks = diffEntities(fromSnap.tracks, toSnap.tracks, TRACK_FIELDS);
  const count = (list, t) => list.filter((x) => x.type === t).length;
  return {
    cues,
    tracks,
    summary: {
      cues: { added: count(cues, 'added'), removed: count(cues, 'removed'), changed: count(cues, 'changed') },
      tracks: { added: count(tracks, 'added'), removed: count(tracks, 'removed'), changed: count(tracks, 'changed') },
    },
  };
}

module.exports = { diffSnapshots };
