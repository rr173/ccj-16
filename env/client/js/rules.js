// 拖动边界的推挤约束。所有计算基于当前 cues 的快照（拖动中每帧重算，保证无累计漂移）。
// 原则：边界拖动可推动同轨相邻句；跨轨互斥句与锁定句只形成硬边界；任何结果不得产生新重叠。
const MIN_LEN = 100;
const EPS = 0.5;

/**
 * 规则校验，与服务端 validation.js 的 validate 保持同一套判定，
 * 保证保存前的即时标红与保存后的服务端复检结果一致。
 * 返回 [{ type: 'reverse'|'overlap'|'mutex', cueIds, trackId?|mutexGroup?, message }]
 * （reverse 对应服务端的 hardErrors，这里并入同一列表，调用方按 type 区分）
 */
export function detectViolations(snap) {
  const violations = [];
  if (!snap) return violations;
  const cues = snap.cues || [];
  const tracks = snap.tracks || [];

  for (const c of cues) {
    if (c.end <= c.start) {
      violations.push({
        type: 'reverse',
        cueIds: [c.id],
        message: `句子 ${c.id} 时间反向（结束 ${c.end} ≤ 开始 ${c.start}）`,
      });
    }
  }

  // 同轨重叠：按 start 排序后，每条句与其结束时间之前开始的所有后续句逐一比较，
  // 长句覆盖多条短句时每一对都要标出（只比相邻对会漏掉被长句完全覆盖的非相邻句）
  const byTrack = new Map();
  for (const c of cues) {
    if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
    byTrack.get(c.trackId).push(c);
  }
  for (const [trackId, list] of byTrack) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length && list[j].start < a.end; j++) {
        violations.push({
          type: 'overlap',
          trackId,
          cueIds: [a.id, list[j].id],
          message: `轨道内重叠：${a.id} 与 ${list[j].id}`,
        });
      }
    }
  }

  // 跨轨互斥：与同轨重叠同理，逐句比较其时间窗内开始的所有后续句
  const groups = new Map();
  for (const t of tracks) {
    if (t.mutexGroup) {
      if (!groups.has(t.mutexGroup)) groups.set(t.mutexGroup, []);
      groups.get(t.mutexGroup).push(t.id);
    }
  }
  for (const [group, trackIds] of groups) {
    const list = cues
      .filter((c) => trackIds.includes(c.trackId))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length && list[j].start < a.end; j++) {
        const b = list[j];
        if (a.trackId === b.trackId) continue;
        violations.push({
          type: 'mutex',
          mutexGroup: group,
          cueIds: [a.id, b.id],
          message: `互斥组「${group}」跨轨冲突：${a.id} 与 ${b.id}`,
        });
      }
    }
  }

  return violations;
}

/** 把检测结果整理成 Map<cueId, Set<type>>，供时间轴与句子列表标红。 */
export function violatedCueIds(snap) {
  const map = new Map();
  for (const v of detectViolations(snap)) {
    for (const id of v.cueIds) {
      if (!map.has(id)) map.set(id, new Set());
      map.get(id).add(v.type);
    }
  }
  return map;
}

function groupOf(trackId, tracks) {
  return tracks.find((t) => t.id === trackId)?.mutexGroup || null;
}

/**
 * 拖左边界（改 start）。
 * 向右拖（收窄）：不推挤，同轨左邻句/互斥跨轨句为硬边界。
 * 向左拖（扩展）：同轨接触/重叠链上的未锁定句整体刚体左移；
 *                 链中含锁定句则不能推；链外句（含跨轨互斥句）为硬边界。
 */
export function dragLeft(cueId, rawS, cues, tracks) {
  const drag = cues.find((c) => c.id === cueId);
  if (!drag || drag.locked) return new Map();
  let s = Math.max(0, Math.min(Math.round(rawS), drag.end - MIN_LEN));
  const g = groupOf(drag.trackId, tracks);

  if (s >= drag.start) {
    // 收窄：找左侧硬边界（不与拖动句原区间重叠的句子）
    let bound = 0;
    for (const c of cues) {
      if (c.id === cueId) continue;
      const cross = c.trackId !== drag.trackId;
      if (cross && (!g || groupOf(c.trackId, tracks) !== g)) continue;
      if (c.end <= drag.start + EPS && c.end > bound && s < c.end) {
        bound = c.end; // 目标 start 不可进入 c
      }
    }
    s = Math.max(s, bound);
    return new Map([[cueId, { ...drag, start: Math.round(s) }]]);
  }

  // 扩展：构造同轨向左传播的刚体链
  const chain = new Set([cueId]);
  let grown = true;
  while (grown) {
    grown = false;
    for (const c of cues) {
      if (chain.has(c.id) || c.trackId !== drag.trackId) continue;
      for (const cid of chain) {
        const m = cues.find((x) => x.id === cid);
        // 候选句位于成员左侧，且其 end 已达到/越过成员 start（重叠或紧邻），移动成员必须带动它
        if (c.start < m.start - EPS && c.end >= m.start - EPS) {
          chain.add(c.id);
          grown = true;
          break;
        }
      }
    }
  }

  // 链内锁定句不允许被推动
  const lockedInChain = [...chain].some((id) => id !== cueId && cues.find((c) => c.id === id).locked);
  let d = s - drag.start; // <= 0
  if (lockedInChain) d = 0;

  // 链外硬边界：同轨左邻（含锁定）与互斥组跨轨句
  // 约束形式 d >= c.end - memberStart（只能停在 c 右边）
  let dMin = -Infinity;
  const chainCues = cues.filter((c) => chain.has(c.id));
  const minStart = Math.min(...chainCues.map((c) => c.start));
  for (const c of cues) {
    if (chain.has(c.id)) continue;
    // 同轨、位于链左侧
    if (c.trackId === drag.trackId && c.end <= minStart + EPS) {
      dMin = Math.max(dMin, c.end - minStart);
    }
    // 互斥组跨轨：检查每个链成员移动后是否与原本不重叠的 c 发生重叠
    if (g && c.trackId !== drag.trackId && groupOf(c.trackId, tracks) === g) {
      for (const m of chainCues) {
        const wasOverlap = m.start < c.end - EPS && m.end > c.start + EPS;
        if (!wasOverlap && c.end <= m.start + EPS) {
          dMin = Math.max(dMin, c.end - m.start);
        }
      }
    }
  }
  d = Math.max(d, dMin); // dMin 为负：至多移动到接触硬边界
  if (minStart + d < 0) d = -minStart;

  const result = new Map();
  result.set(cueId, { ...drag, start: Math.round(drag.start + d) });
  for (const c of chainCues) {
    if (c.id === cueId || c.locked || d === 0) continue;
    result.set(c.id, { ...c, start: Math.round(c.start + d), end: Math.round(c.end + d) });
  }
  return result;
}

/** 拖右边界（改 end），与左边界镜像。 */
export function dragRight(cueId, rawE, cues, tracks, duration) {
  const drag = cues.find((c) => c.id === cueId);
  if (!drag || drag.locked) return new Map();
  let e = Math.min(duration, Math.max(Math.round(rawE), drag.start + MIN_LEN));
  const g = groupOf(drag.trackId, tracks);

  if (e <= drag.end) {
    // 收窄：右侧硬边界
    let bound = duration;
    for (const c of cues) {
      if (c.id === cueId) continue;
      const cross = c.trackId !== drag.trackId;
      if (cross && (!g || groupOf(c.trackId, tracks) !== g)) continue;
      if (c.start >= drag.end - EPS && c.start < bound && e > c.start) {
        bound = c.start;
      }
    }
    e = Math.min(e, bound);
    return new Map([[cueId, { ...drag, end: Math.round(e) }]]);
  }

  // 扩展：同轨向右传播的刚体链
  const chain = new Set([cueId]);
  let grown = true;
  while (grown) {
    grown = false;
    for (const c of cues) {
      if (chain.has(c.id) || c.trackId !== drag.trackId) continue;
      for (const cid of chain) {
        const m = cues.find((x) => x.id === cid);
        if (c.end > m.end + EPS && c.start <= m.end + EPS) {
          chain.add(c.id);
          grown = true;
          break;
        }
      }
    }
  }

  const lockedInChain = [...chain].some((id) => id !== cueId && cues.find((c) => c.id === id).locked);
  let d = e - drag.end; // >= 0
  if (lockedInChain) d = 0;

  let dMax = d;
  const chainCues = cues.filter((c) => chain.has(c.id));
  const maxEnd = Math.max(...chainCues.map((c) => c.end));
  for (const c of cues) {
    if (chain.has(c.id)) continue;
    if (c.trackId === drag.trackId && c.start >= maxEnd - EPS) {
      dMax = Math.min(dMax, c.start - maxEnd);
    }
    if (g && c.trackId !== drag.trackId && groupOf(c.trackId, tracks) === g) {
      for (const m of chainCues) {
        const wasOverlap = m.start < c.end - EPS && m.end > c.start + EPS;
        if (!wasOverlap && c.start >= m.end - EPS) {
          dMax = Math.min(dMax, c.start - m.end);
        }
      }
    }
  }
  d = Math.min(d, dMax); // dMax 为正：至多移动到接触硬边界
  if (maxEnd + d > duration) d = duration - maxEnd;

  const result = new Map();
  result.set(cueId, { ...drag, end: Math.round(drag.end + d) });
  for (const c of chainCues) {
    if (c.id === cueId || c.locked || d === 0) continue;
    result.set(c.id, { ...c, start: Math.round(c.start + d), end: Math.round(c.end + d) });
  }
  return result;
}

/** 整体平移：不推挤任何句子；锁定句不可拖；同轨句与互斥跨轨句为硬边界。 */
export function dragMove(cueId, targetStart, cues, tracks, duration) {
  const drag = cues.find((c) => c.id === cueId);
  if (!drag || drag.locked) return new Map();
  const len = drag.end - drag.start;
  let s = Math.max(0, Math.min(Math.round(targetStart), duration - len));
  const g = groupOf(drag.trackId, tracks);

  for (const c of cues) {
    if (c.id === cueId) continue;
    const cross = c.trackId !== drag.trackId;
    if (cross && (!g || groupOf(c.trackId, tracks) !== g)) continue;
    const wasOverlap = drag.start < c.end - EPS && drag.end > c.start + EPS;
    if (wasOverlap) continue; // 已存在的冲突不参与新约束
    if (s < c.end && s + len > c.start) {
      if (s >= drag.start) s = Math.min(s, c.start - len); // 右移：停在 c 左边
      else s = Math.max(s, c.end);                          // 左移：停在 c 右边
    }
  }
  s = Math.max(0, Math.min(s, duration - len));
  return new Map([[cueId, { ...drag, start: s, end: s + len }]]);
}
