'use strict';
/**
 * 通用实体三向合并（用于 cues 与 tracks）。
 *
 * base：共同祖先；mine：我基于 base 编辑后的结果；theirs：当前服务器 HEAD。
 * 仅自动合入"无冲突"的差异：
 *   - 两边都改同一字段且值不同        -> 字段级冲突
 *   - 一边编辑、另一边删除            -> delete/edit 冲突
 *   - 两边新增同一 id                 -> add/add 冲突（正常不会发生，id 由客户端生成）
 *   - 同一 cue 被改到不同 track       -> edit/edit 冲突（trackId 作为字段参与）
 * 冲突由调用方交给用户逐处选择，不会用任一方整体覆盖另一方。
 */

const FIELDS = {
  cue: ['trackId', 'start', 'end', 'text', 'locked'],
  track: ['name', 'color', 'mutexGroup'],
};

function deepEqual(a, b) {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}

function mergeEntities(baseArr = [], mineArr = [], theirsArr = [], type) {
  const fields = FIELDS[type];
  const base = new Map(baseArr.map((e) => [e.id, e]));
  const mine = new Map(mineArr.map((e) => [e.id, e]));
  const theirs = new Map(theirsArr.map((e) => [e.id, e]));
  const allIds = new Set([...base.keys(), ...mine.keys(), ...theirs.keys()]);

  const out = [];
  const conflicts = [];

  for (const id of allIds) {
    const b = base.get(id);
    const m = mine.get(id);
    const t = theirs.get(id);

    // 1) 双方都删除
    if (!m && !t) continue;

    // 2) 我这边没有：我删除（祖先存在）或对方单独新增（祖先不存在）
    if (!m) {
      if (!b) {
        out.push({ ...t }); // 对方单独新增，自动并入
        continue;
      }
      const tChanged = fields.some((f) => !deepEqual(b?.[f], t[f]));
      if (!tChanged) {
        continue; // 对方未改，删除自动生效
      }
      conflicts.push({
        kind: 'delete-edit',
        entity: type,
        id,
        theirs: t,
        base: b,
      });
      // 占位：冲突解决前先保留对方版本
      out.push({ ...t });
      continue;
    }

    // 3) 对方没有：对方删除（祖先存在）或我单独新增（祖先不存在）
    if (!t) {
      if (!b) {
        out.push({ ...m }); // 我单独新增，自动并入
        continue;
      }
      const mChanged = fields.some((f) => !deepEqual(b?.[f], m[f]));
      if (!mChanged) {
        continue; // 对方删除，我未改，删除生效
      }
      conflicts.push({
        kind: 'edit-delete',
        entity: type,
        id,
        mine: m,
        base: b,
      });
      out.push({ ...m });
      continue;
    }

    // 4) 双方都新增
    if (!b) {
      const same = fields.every((f) => deepEqual(m[f], t[f]));
      if (same) {
        out.push({ ...m });
      } else {
        conflicts.push({ kind: 'add-add', entity: type, id, mine: m, theirs: t });
        out.push({ ...m }); // 占位
      }
      continue;
    }

    // 5) 双方都存在且祖先存在 —— 逐字段合并
    const merged = { ...b, ...m };
    let hasConflict = false;
    const fieldConflicts = [];
    for (const f of fields) {
      const mv = m[f];
      const tv = t[f];
      const mineChanged = !deepEqual(b[f], mv);
      const theirsChanged = !deepEqual(b[f], tv);
      if (mineChanged && theirsChanged && !deepEqual(mv, tv)) {
        hasConflict = true;
        fieldConflicts.push({
          field: f,
          base: b[f],
          mine: mv,
          theirs: tv,
        });
        merged[f] = tv; // 占位，等待用户选择
      } else if (mineChanged) {
        merged[f] = mv;
      } else if (theirsChanged) {
        merged[f] = tv;
      } else {
        merged[f] = b[f];
      }
    }
    if (hasConflict) {
      conflicts.push({
        kind: 'edit-edit',
        entity: type,
        id,
        base: b,
        mine: m,
        theirs: t,
        fields: fieldConflicts,
      });
    }
    out.push(merged);
  }

  return { entities: out, conflicts };
}

/** 合并整个项目快照；轨道被删时其下 cue 级联丢弃（孤儿防御）。 */
function mergeSnapshots(baseSnap, mineSnap, theirsSnap) {
  const tracksRes = mergeEntities(baseSnap.tracks || [], mineSnap.tracks || [], theirsSnap.tracks || [], 'track');
  const cuesRes = mergeEntities(baseSnap.cues || [], mineSnap.cues || [], theirsSnap.cues || [], 'cue');

  const trackIds = new Set(tracksRes.entities.map((t) => t.id));
  let cues = cuesRes.entities;
  const orphanCueConflicts = [];
  const lostCues = cues.filter((c) => !trackIds.has(c.trackId));
  if (lostCues.length) {
    // 保留冲突信息以便审计/提示，实体不写入结果
    for (const c of lostCues) {
      orphanCueConflicts.push({
        kind: 'orphan-cue',
        entity: 'cue',
        id: c.id,
        mine: mineSnap.cues?.find((x) => x.id === c.id),
        theirs: theirsSnap.cues?.find((x) => x.id === c.id),
      });
    }
    cues = cues.filter((c) => trackIds.has(c.trackId));
  }

  const settings = mergeSettings(baseSnap.settings || {}, mineSnap.settings || {}, theirsSnap.settings || {});

  return {
    snapshot: {
      duration: Math.max(mineSnap.duration || 0, theirsSnap.duration || 0, baseSnap.duration || 0),
      tracks: tracksRes.entities,
      cues,
      settings,
    },
    conflicts: [...cuesRes.conflicts, ...tracksRes.conflicts, ...orphanCueConflicts],
  };
}

function mergeSettings(base, mine, theirs) {
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
  const out = {};
  for (const k of keys) {
    const b = base[k], m = mine[k], t = theirs[k];
    if (deepEqual(m, t)) out[k] = m;
    else if (deepEqual(b, m)) out[k] = t;
    else if (deepEqual(b, t)) out[k] = m;
    // 双方改且不同：settings 冲突保守取 theirs，客户端保存界面一般不并发改设置
    else out[k] = t;
  }
  return out;
}

module.exports = { mergeEntities, mergeSnapshots, deepEqual };
