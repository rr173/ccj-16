'use strict';
/**
 * 交付质检规则引擎。
 *
 * 规则可配置在项目级（trackId=''）与轨道级（轨道覆盖优先），五类规则：
 *   duration   单句时长     {minMs, maxMs}
 *   cps        阅读速度     {maxCps}（非空白字符数 / 秒）
 *   line_chars 单行字符数   {maxChars}
 *   gap        空白间隔     {minGapMs}（同轨相邻句最小间隔）
 *   align      跨轨对齐误差 {toleranceMs, trackA?, trackB?}（项目级，时间重叠的跨轨句对）
 *
 * 每条 finding 携带：规则、实际值(actual)、严重级别(severity)、证据(evidence)、
 * 建议处理方式(suggestion，含 safe 标记——只有明确安全的项才允许自动修复)，
 * 以及发现时句子基准值 basis，修复应用时据此校验句子未被他人改动。
 */

const MIN_LEN = 100; // 与 validation.MIN_DURATION 对齐

const RULE_DEFS = {
  duration: {
    label: '单句时长',
    defaultParams: { minMs: 500, maxMs: 10000 },
    paramFields: [
      { key: 'minMs', label: '最短(ms)', type: 'number', min: 0, max: 3600000 },
      { key: 'maxMs', label: '最长(ms)', type: 'number', min: 1, max: 3600000 },
    ],
  },
  cps: {
    label: '阅读速度',
    defaultParams: { maxCps: 20 },
    paramFields: [{ key: 'maxCps', label: '最大字/秒', type: 'number', min: 1, max: 1000 }],
  },
  line_chars: {
    label: '单行字符数',
    defaultParams: { maxChars: 42 },
    paramFields: [{ key: 'maxChars', label: '每行最多字符', type: 'number', min: 1, max: 500 }],
  },
  gap: {
    label: '空白间隔',
    defaultParams: { minGapMs: 100 },
    paramFields: [{ key: 'minGapMs', label: '最小间隔(ms)', type: 'number', min: 0, max: 60000 }],
  },
  align: {
    label: '跨轨对齐误差',
    defaultParams: { toleranceMs: 120, trackA: '', trackB: '' },
    paramFields: [
      { key: 'toleranceMs', label: '容差(ms)', type: 'number', min: 0, max: 60000 },
      { key: 'trackA', label: '轨道A(可空)', type: 'track' },
      { key: 'trackB', label: '轨道B(可空)', type: 'track' },
    ],
  },
};

const RULE_KEYS = Object.keys(RULE_DEFS);
const SEVERITIES = ['blocker', 'warning'];

function msToSrt(ms) {
  ms = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

/** 校验并规范化一条规则配置；非法输入抛错。 */
function normalizeRule(ruleKey, raw) {
  const def = RULE_DEFS[ruleKey];
  if (!def) throw new Error(`未知规则：${ruleKey}`);
  const severity = raw?.severity ?? 'warning';
  if (!SEVERITIES.includes(severity)) throw new Error(`规则 ${ruleKey} 严重级别非法`);
  const params = {};
  for (const f of def.paramFields) {
    const v = raw?.params?.[f.key] ?? def.defaultParams[f.key];
    if (f.type === 'track') {
      params[f.key] = v == null ? '' : String(v);
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < f.min || n > f.max) {
        throw new Error(`规则 ${def.label} 参数「${f.label}」应在 ${f.min}~${f.max} 之间`);
      }
      params[f.key] = Math.round(n);
    }
  }
  if (ruleKey === 'duration' && params.minMs > params.maxMs) {
    throw new Error('单句时长下限不能大于上限');
  }
  return { enabled: raw?.enabled !== false, severity, params };
}

/** 完整校验一份 {ruleKey: cfg} 配置，返回规范化结果。 */
function normalizeRulesConfig(raw) {
  const out = {};
  for (const key of RULE_KEYS) out[key] = normalizeRule(key, raw?.[key]);
  return out;
}

/** 由数据库行组装 { '': {key:cfg}, '<trackId>': {key:cfg} }。 */
function rulesFromRows(rows) {
  const byScope = {};
  for (const r of rows) {
    if (!byScope[r.track_id]) byScope[r.track_id] = {};
    byScope[r.track_id][r.rule_key] = {
      enabled: Boolean(r.enabled),
      severity: r.severity,
      params: JSON.parse(r.params),
    };
  }
  return byScope;
}

/** 某轨道某规则的生效配置：轨道覆盖优先，其次项目级，最后内置默认。 */
function effectiveRule(scoped, trackId, ruleKey) {
  const def = RULE_DEFS[ruleKey];
  return (
    scoped?.[trackId]?.[ruleKey] ||
    scoped?.['']?.[ruleKey] || { enabled: true, severity: 'warning', params: { ...def.defaultParams } }
  );
}

/** 把 scoped 配置展开为 {trackId|'': {key: 生效配置}}，供冻结进任务/快照。 */
function expandRules(scoped, tracks) {
  const out = { '': {} };
  for (const key of RULE_KEYS) out[''][key] = effectiveRule(scoped, '', key);
  for (const t of tracks || []) {
    out[t.id] = {};
    for (const key of RULE_KEYS) out[t.id][key] = effectiveRule(scoped, t.id, key);
  }
  return out;
}

/** 非空白字符数（CJK 与拉丁均按 1 字计）。 */
function charCount(text) {
  return (String(text).match(/\S/g) || []).length;
}

/**
 * 判断把句子 cueId 改到 [ns,ne] 是否安全：
 * 不与同轨其他句重叠、不违反跨轨互斥组。
 */
function canPlace(snap, cueId, ns, ne) {
  const cue = snap.cues.find((c) => c.id === cueId);
  if (!cue) return false;
  const groupOf = (tid) => snap.tracks.find((t) => t.id === tid)?.mutexGroup || null;
  const g = groupOf(cue.trackId);
  for (const c of snap.cues) {
    if (c.id === cueId) continue;
    const sameTrack = c.trackId === cue.trackId;
    const crossMutex = g && c.trackId !== cue.trackId && groupOf(c.trackId) === g;
    if (!sameTrack && !crossMutex) continue;
    if (ns < c.end && ne > c.start) return false;
  }
  return true;
}

function basisOf(cue) {
  return { start: cue.start, end: cue.end, text: cue.text, locked: cue.locked };
}

function mkFinding(cue, ruleKey, severity, actual, evidence, suggestion) {
  return {
    cueId: cue.id,
    trackId: cue.trackId,
    ruleKey,
    severity,
    actual,
    evidence,
    suggestion: suggestion || null,
    basis: basisOf(cue),
  };
}

function shortText(text, n = 24) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 逐句规则：duration / cps / line_chars。供任务分批执行。 */
function perCueFindings(snap, scoped, cue) {
  const out = [];
  const dur = cue.end - cue.start;

  const durRule = effectiveRule(scoped, cue.trackId, 'duration');
  if (durRule.enabled && dur > 0) {
    const { minMs, maxMs } = durRule.params;
    if (dur < minMs) {
      const need = cue.start + minMs;
      const safe = !cue.locked && canPlace(snap, cue.id, cue.start, need);
      out.push(mkFinding(cue, 'duration', durRule.severity,
        { value: dur, limit: minMs, unit: 'ms', kind: 'too_short' },
        `时长 ${dur}ms 低于下限 ${minMs}ms；文本「${shortText(cue.text)}」`,
        { kind: 'set_times', patch: { end: need }, safe, describe: `延长结束至 ${msToSrt(need)}（达到最短时长）` }));
    } else if (dur > maxMs) {
      const need = cue.start + maxMs;
      const safe = !cue.locked && need > cue.start; // 缩短结束不会制造重叠
      out.push(mkFinding(cue, 'duration', durRule.severity,
        { value: dur, limit: maxMs, unit: 'ms', kind: 'too_long' },
        `时长 ${dur}ms 超过上限 ${maxMs}ms；文本「${shortText(cue.text)}」`,
        { kind: 'set_times', patch: { end: need }, safe, describe: `缩短结束至 ${msToSrt(need)}（达到最长时长）` }));
    }
  }

  const cpsRule = effectiveRule(scoped, cue.trackId, 'cps');
  if (cpsRule.enabled && dur > 0) {
    const chars = charCount(cue.text);
    const cps = chars / (dur / 1000);
    const { maxCps } = cpsRule.params;
    if (chars > 0 && cps > maxCps) {
      const needDur = Math.ceil((chars / maxCps) * 1000);
      const need = cue.start + needDur;
      const safe = !cue.locked && canPlace(snap, cue.id, cue.start, need);
      out.push(mkFinding(cue, 'cps', cpsRule.severity,
        { value: Math.round(cps * 10) / 10, limit: maxCps, unit: '字/秒', chars },
        `阅读速度 ${cps.toFixed(1)} 字/秒 超过上限 ${maxCps}（${chars} 字 / ${dur}ms）；文本「${shortText(cue.text)}」`,
        { kind: 'set_times', patch: { end: need }, safe, describe: `延长结束至 ${msToSrt(need)}（降至 ${maxCps} 字/秒）` }));
    }
  }

  const lineRule = effectiveRule(scoped, cue.trackId, 'line_chars');
  if (lineRule.enabled) {
    const lines = String(cue.text).split(/\r?\n/);
    const maxLine = Math.max(...lines.map((l) => l.length), 0);
    const { maxChars } = lineRule.params;
    if (maxLine > maxChars) {
      out.push(mkFinding(cue, 'line_chars', lineRule.severity,
        { value: maxLine, limit: maxChars, unit: '字符' },
        `单行最长 ${maxLine} 字符 超过上限 ${maxChars}；文本「${shortText(cue.text)}」`,
        { kind: 'manual', safe: false, describe: '需人工断行/精简文本，不提供自动修复' }));
    }
  }

  return out;
}

/** 同轨相邻句空白间隔。 */
function gapFindings(snap, scoped) {
  const out = [];
  const byTrack = new Map();
  for (const c of snap.cues) {
    if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
    byTrack.get(c.trackId).push(c);
  }
  for (const [trackId, list] of byTrack) {
    const rule = effectiveRule(scoped, trackId, 'gap');
    if (!rule.enabled) continue;
    const { minGapMs } = rule.params;
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i];
      const b = list[i + 1];
      const gap = b.start - a.end;
      if (gap < 0) continue; // 负间隔即重叠，由时间轴约束负责
      if (gap >= minGapMs) continue;
      const newEnd = b.start - minGapMs;
      const safe = !a.locked && newEnd - a.start >= MIN_LEN;
      out.push(mkFinding(a, 'gap', rule.severity,
        { value: gap, limit: minGapMs, unit: 'ms', otherCueId: b.id },
        `与后句 ${b.id} 间隔 ${gap}ms 小于最小间隔 ${minGapMs}ms；「${shortText(a.text)}」→「${shortText(b.text)}」`,
        safe
          ? { kind: 'set_times', patch: { end: newEnd }, safe, describe: `提前结束至 ${msToSrt(newEnd)}（留出 ${minGapMs}ms 间隔）` }
          : { kind: 'manual', safe: false, describe: '间隔不足且自动压缩会破坏最小时长/句子锁定，需人工调整' }));
    }
  }
  return out;
}

/** 跨轨对齐误差（项目级规则）：时间上有重叠的跨轨句对，起止差超过容差即报。 */
function alignFindings(snap, scoped) {
  const out = [];
  const rule = effectiveRule(scoped, '', 'align'); // 跨轨规则只看项目级
  if (!rule.enabled) return out;
  const { toleranceMs, trackA, trackB } = rule.params;

  const trackIds = snap.tracks.map((t) => t.id);
  const pairs = [];
  if (trackA && trackB && trackIds.includes(trackA) && trackIds.includes(trackB) && trackA !== trackB) {
    pairs.push([trackA, trackB].sort());
  } else {
    for (let i = 0; i < trackIds.length; i++) {
      for (let j = i + 1; j < trackIds.length; j++) pairs.push([trackIds[i], trackIds[j]]);
    }
  }

  for (const [t1, t2] of pairs) {
    const l1 = snap.cues.filter((c) => c.trackId === t1);
    const l2 = snap.cues.filter((c) => c.trackId === t2);
    for (const a of l1) {
      // 配对：t2 上与 a 时间重叠最多的句子
      let best = null;
      let bestOv = 0;
      for (const b of l2) {
        const ov = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        if (ov > bestOv) { bestOv = ov; best = b; }
      }
      if (!best || bestOv <= 0) continue;
      const startDiff = Math.abs(a.start - best.start);
      const endDiff = Math.abs(a.end - best.end);
      if (startDiff <= toleranceMs && endDiff <= toleranceMs) continue;
      const safe = !a.locked && canPlace(snap, a.id, best.start, best.end);
      out.push(mkFinding(a, 'align', rule.severity,
        { value: Math.max(startDiff, endDiff), limit: toleranceMs, unit: 'ms', startDiff, endDiff, otherCueId: best.id, otherTrackId: t2 },
        `与轨道「${t2}」句子 ${best.id} 起点差 ${startDiff}ms、终点差 ${endDiff}ms，容差 ${toleranceMs}ms；「${shortText(a.text)}」↔「${shortText(best.text)}」`,
        safe
          ? { kind: 'set_times', patch: { start: best.start, end: best.end }, safe, describe: `对齐到 ${msToSrt(best.start)} → ${msToSrt(best.end)}` }
          : { kind: 'manual', safe: false, describe: '自动对齐会与同轨/互斥句冲突或句子已锁定，需人工调整' }));
    }
  }
  return out;
}

/** 全量计算（小项目/测试用）；任务执行器内部分批调用 perCueFindings。 */
function computeFindings(snap, scoped) {
  const out = [];
  for (const cue of snap.cues) out.push(...perCueFindings(snap, scoped, cue));
  out.push(...gapFindings(snap, scoped));
  out.push(...alignFindings(snap, scoped));
  return out;
}

function summarize(findings) {
  const byRule = {};
  const byTrack = {};
  let blocker = 0;
  let warning = 0;
  for (const f of findings) {
    byRule[f.ruleKey] = (byRule[f.ruleKey] || 0) + 1;
    byTrack[f.trackId] = (byTrack[f.trackId] || 0) + 1;
    if (f.severity === 'blocker') blocker++;
    else warning++;
  }
  return { total: findings.length, blocker, warning, byRule, byTrack };
}

module.exports = {
  RULE_DEFS,
  RULE_KEYS,
  SEVERITIES,
  normalizeRule,
  normalizeRulesConfig,
  rulesFromRows,
  effectiveRule,
  expandRules,
  perCueFindings,
  gapFindings,
  alignFindings,
  computeFindings,
  summarize,
  canPlace,
  charCount,
  msToSrt,
};
