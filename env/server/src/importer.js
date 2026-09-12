'use strict';
/**
 * 字幕批量导入核心（纯函数，不碰数据库/HTTP）。
 *
 * 流程： parseSubtitle  ->  buildPreview（基于用户当前看到的版本逐项校验）
 *       -> applyImport（只应用被勾选的合法条目，新增/修改/跳过逐条登记）
 * 回滚： planRollback（沿当前快照逐条比对，导入后被他人改过的句子跳过，绝不覆盖）
 *
 * 支持格式：SRT/VTT、CSV/TSV（含表头自动识别或按列位置猜测，字段映射可覆盖）、JSON 数组。
 * 时间一律解析为整数毫秒，非法时间/反向区间按错误条目逐行标出。
 */
const crypto = require('crypto');

const newId = (p) => p + '_' + crypto.randomBytes(9).toString('hex');

const TRACK_COLORS = ['#4e8cff', '#ff9a3c', '#34c77b', '#e0596f', '#9b7bff', '#2fb8c4'];

/* ------------------------------ 时间与文本 ------------------------------ */

/** 与前端一致：毫秒整数；额外容忍 VTT 的点号毫秒与缺少毫秒的 HH:MM:SS。失败返回 null。 */
function parseTimeMs(input) {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return Math.round(input);
  let s = String(input ?? '').trim().replace('，', ',').replace(/^\+/, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s)); // 纯数字按毫秒
  let m = s.match(/^(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})$/);
  if (m) {
    return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4].padEnd(3, '0'));
  }
  m = s.match(/^(\d+):([0-5]?\d):([0-5]?\d)$/);
  if (m) return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000;
  m = s.match(/^([0-5]?\d):([0-5]?\d)[,.](\d{1,3})$/); // MM:SS,mmm
  if (m) return Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3].padEnd(3, '0'));
  m = s.match(/^([0-5]?\d):([0-5]?\d)$/);
  if (m) return Number(m[1]) * 60000 + Number(m[2]) * 1000;
  return null;
}

const normText = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim();
const dupKey = (s) => normText(s).replace(/\s+/g, '').toLowerCase();
const describe = (v) => (v === undefined ? null : JSON.stringify(v));

/* -------------------------------- 解析 -------------------------------- */

/** 识别格式：json | srt | csv。无法识别时由调用方按 csv 尝试，最终 parseError 兜底。 */
function detectFormat(content, filename = '') {
  const c = String(content ?? '').replace(/^﻿/, '').trim();
  const name = String(filename || '').toLowerCase();
  if (c.startsWith('{') || c.startsWith('[')) return 'json';
  if (/\.json$/.test(name)) return 'json';
  if (/\.srt$|\.vtt$/.test(name)) return 'srt';
  if (/\d{1,2}:[0-5]\d:[0-5]\d[,.]\d{3}\s*-->/.test(c)) return 'srt';
  if (/^webvtt/m.test(c) || /-->/m.test(c)) return 'srt';
  return 'csv';
}

/** 解析 SRT/VTT。返回 { rows: [{seq,line,startRaw,endRaw,text,trackSource:''}] }。 */
function parseSrt(content) {
  const lines = String(content).replace(/^﻿/, '').split(/\r?\n/);
  const rows = [];
  let seq = 0;
  for (let i = 0; i < lines.length; ) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;
    const blockLine = i + 1;
    const block = [];
    while (i < lines.length && lines[i].trim()) block.push(lines[i++]);

    // 跳过 WEBVTT/NOTE 块
    if (/^WEBVTT\b/i.test(block[0]) || /^NOTE\b/i.test(block[0])) {
      if (!/-->/.test(block[0])) continue;
    }
    let tIdx = block.findIndex((l) => /-->/.test(l));
    if (tIdx === -1) {
      rows.push({ seq: ++seq, line: blockLine, startRaw: '', endRaw: '', text: block.join('\n'), trackSource: '', parseIssue: 'time-bad' });
      continue;
    }
    const tm = block[tIdx].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    const textLines = block.slice(tIdx + 1);
    rows.push({
      seq: ++seq,
      line: blockLine,
      startRaw: tm?.[1]?.trim() || '',
      endRaw: tm?.[2]?.trim() || '',
      text: textLines.join('\n'),
      trackSource: '',
    });
  }
  return { rows, format: 'srt' };
}

/** 极简 CSV/TSV 解析（支持双引号包裹、引号内换行）。delim 为空则按首行猜测。 */
function parseDelimited(content, delim) {
  const text = String(content).replace(/^﻿/, '');
  if (!delim) {
    const firstLine = text.split(/\r?\n/, 1)[0];
    delim = firstLine.includes('\t') ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
  }
  const records = [];
  let field = '';
  let row = [];
  let line = 1;
  let rowLine = 1;
  let quoted = false;
  const push = () => {
    row.push(field);
    records.push({ fields: row, line: rowLine });
    field = '';
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') line++;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { push(); rowLine = line; continue; }
    field += ch;
  }
  if (field !== '' || row.length) push();
  return { records, delim, format: delim === '\t' ? 'tsv' : 'csv' };
}

const ALIASES = {
  start: ['start', '开始', '开始时间', 'in', 'from', 'starttime', 'startms', '起始时间'],
  end: ['end', '结束', '结束时间', 'out', 'to', 'endtime', 'endms', '终止时间'],
  text: ['text', '文本', '字幕', '字幕文本', '内容', 'sentence', 'content', '台词'],
  track: ['track', '轨道', '轨', 'lane', 'trackname', '轨道名', '声轨'],
};
const normHeader = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');

function guessHeaderMapping(header) {
  const mapping = {};
  header.forEach((h, i) => {
    const n = normHeader(h);
    for (const key of ['start', 'end', 'text', 'track']) {
      if (mapping[key] === undefined && ALIASES[key].some((a) => normHeader(a) === n)) mapping[key] = i;
    }
  });
  return mapping;
}

/** 无表头时按内容猜列：能解析为时间的两列作起止，其余列中末列作文本、起止前的列作轨道。 */
function guessPositionalMapping(records) {
  const mapping = {};
  const sample = records.slice(0, 30);
  const count = Math.max(...sample.map((r) => r.fields.length), 0);
  const timeCols = [];
  for (let c = 0; c < count; c++) {
    const ok = sample.filter((r) => r.fields[c] != null && parseTimeMs(r.fields[c]) !== null).length;
    if (ok >= Math.min(1, sample.length) && sample.some((r) => parseTimeMs(r.fields[c]) !== null)) timeCols.push(c);
  }
  if (timeCols.length >= 2) {
    mapping.start = timeCols[0];
    mapping.end = timeCols[1];
    const others = [];
    for (let c = 0; c < count; c++) if (c !== mapping.start && c !== mapping.end) others.push(c);
    if (others.length) {
      mapping.text = others[others.length - 1];
      const before = others.filter((c) => c < mapping.start);
      if (before.length) mapping.track = before[0];
    }
  }
  return mapping;
}

function rowsFromDelimited(parsed, overrideMapping) {
  /**
   * 兼容未加引号的 SRT 逗号毫秒：相邻的 "00:00:01" 与 "000" 两格合并为
   * "00:00:01,000"。该模式无歧义（前者恰好到秒、后者为 1–3 位数字），
   * 合并后表头识别与按位置猜测都不会再被 "000" 误导。
   */
  const fixFields = (fields) => {
    const out = [];
    for (let i = 0; i < fields.length; i++) {
      const v = fields[i];
      if (typeof v === 'string' && /^\d+:[0-5]?\d:[0-5]?\d$/.test(v.trim()) && /^\d{1,3}$/.test(String(fields[i + 1] ?? '').trim())) {
        out.push(`${v.trim()},${fields[i + 1].trim()}`);
        i++;
      } else {
        out.push(v);
      }
    }
    return out;
  };

  const records = parsed.records
    .filter((r) => r.fields.some((f) => String(f ?? '').trim() !== ''))
    .map((r) => ({ ...r, fields: fixFields(r.fields) }));
  if (!records.length) return { rows: [], columns: [], mapping: {} };
  const header = records[0].fields;
  let mapping = guessHeaderMapping(header);
  let dataRecords = records;
  let columns = header.map((h, i) => ({ key: i, name: h || `列 ${i + 1}` }));
  if (mapping.start === undefined || mapping.text === undefined) {
    // 无有效表头：整条按位置解析
    mapping = guessPositionalMapping(records);
  } else {
    dataRecords = records.slice(1);
    columns = header.map((h, i) => ({ key: i, name: h || `列 ${i + 1}` }));
  }
  mapping = { ...mapping, ...(overrideMapping || {}) };

  const rows = [];
  let seq = 0;
  for (const rec of dataRecords) {
    rows.push({
      seq: ++seq,
      line: rec.line,
      startRaw: mapping.start != null ? rec.fields[mapping.start] ?? '' : '',
      endRaw: mapping.end != null ? rec.fields[mapping.end] ?? '' : '',
      text: mapping.text != null ? rec.fields[mapping.text] ?? '' : '',
      trackSource: mapping.track != null ? String(rec.fields[mapping.track] ?? '').trim() : '',
    });
  }
  return { rows, columns, mapping };
}

function rowsFromJson(content, overrideMapping) {
  const data = JSON.parse(content);
  const arr = Array.isArray(data) ? data : Array.isArray(data.cues) ? data.cues : Array.isArray(data.items) ? data.items : null;
  if (!arr) throw new Error('JSON 顶层应为数组，或含 cues/items 数组的对象');
  const keys = [...new Set(arr.flatMap((o) => (o && typeof o === 'object' ? Object.keys(o) : [])))];
  const header = keys.map((k) => ({ key: k, name: k }));
  let mapping = {};
  for (const k of keys) {
    for (const field of ['start', 'end', 'text', 'track']) {
      if (mapping[field] === undefined && ALIASES[field].some((a) => normHeader(a) === normHeader(k))) mapping[field] = k;
    }
  }
  mapping = { ...mapping, ...(overrideMapping || {}) };
  const rows = arr.map((o, i) => ({
    seq: i + 1,
    line: i + 1,
    startRaw: mapping.start != null ? o?.[mapping.start] ?? '' : '',
    endRaw: mapping.end != null ? o?.[mapping.end] ?? '' : '',
    text: mapping.text != null ? o?.[mapping.text] ?? '' : '',
    trackSource: mapping.track != null ? String(o?.[mapping.track] ?? '').trim() : '',
  }));
  return { rows, columns: header, mapping };
}

/**
 * 解析字幕文件。
 * 返回 { format, rows, columns, mapping, parseError? }。columns/mapping 仅 CSV/JSON 有。
 */
function parseSubtitle(content, { filename = '', mapping = null } = {}) {
  const fmt = detectFormat(content, filename);
  try {
    if (fmt === 'json') {
      const r = rowsFromJson(String(content).replace(/^﻿/, '').trim(), mapping);
      return { format: 'json', ...r };
    }
    if (fmt === 'srt') {
      return { ...parseSrt(content), columns: null, mapping: null };
    }
    const parsed = parseDelimited(content);
    const r = rowsFromDelimited(parsed, mapping);
    return { format: parsed.format, columns: r.columns, mapping: r.mapping, rows: r.rows };
  } catch (e) {
    return { format: fmt, rows: [], columns: null, mapping: null, parseError: e.message };
  }
}

/* ------------------------------ 逐项校验 ------------------------------ */

const ISSUE_LABELS = {
  'time-bad': '非法时间',
  'time-reverse': '时间反向（结束 ≤ 开始）',
  'text-empty': '文本为空',
  'unknown-track': '文件中的轨道在项目中不存在',
  'missing-default-track': '未指定导入轨道',
  'dup-file': '与文件内其他句子重复',
  'dup-project': '项目中已存在同轨同文句子',
  'locked': '目标位置的句子已锁定，不能覆盖',
};

/**
 * 基于用户当前看到的快照生成导入预览。
 * options: { mapping, defaultTrackId, createMissingTracks, trackMap: {来源: 轨道id|'__new__'}, included: {seq:bool} }
 */
function buildPreview(snapshot, content, options = {}, filename = '') {
  const parsed = parseSubtitle(content, { filename, mapping: options.mapping || null });
  if (parsed.parseError) return { ...parsed, filename, rows: [], trackSources: [], summary: emptySummary() };

  const tracks = snapshot.tracks || [];
  const trackNameIds = new Map(tracks.map((t) => [t.name, t.id]));
  const trackById = new Map(tracks.map((t) => [t.id, t]));

  // 轨道来源 -> 解析结果（id | '__new__'），同时给出预览用的默认映射
  const sourceNames = [...new Set(parsed.rows.map((r) => r.trackSource).filter(Boolean))];
  const resolvedSources = new Map();
  const trackSources = sourceNames.map((name) => {
    let target = options.trackMap?.[name];
    let status;
    if (target === '__new__') {
      status = 'new';
    } else if (target && trackById.has(target)) {
      status = 'existing';
    } else {
      const guess = trackNameIds.get(name);
      if (guess) { target = guess; status = 'existing'; }
      else if (options.createMissingTracks) { target = '__new__'; status = 'new'; }
      else { target = null; status = 'unknown'; }
    }
    resolvedSources.set(name, target);
    return { name, target, status };
  });

  const seenText = new Map(); // normText -> 首次出现的 seq
  const rows = parsed.rows.map((r) => {
    const issues = [];
    const text = normText(r.text);
    const startMs = parseTimeMs(r.startRaw);
    const endMs = parseTimeMs(r.endRaw);

    if (text === '') issues.push(issue('text-empty', `第 ${r.seq} 行：文本为空`));
    if (startMs === null) issues.push(issue('time-bad', `第 ${r.seq} 行：开始时间无法解析（${String(r.startRaw).slice(0, 24)}）`, 'start'));
    if (endMs === null) issues.push(issue('time-bad', `第 ${r.seq} 行：结束时间无法解析（${String(r.endRaw).slice(0, 24)}）`, 'end'));
    if (startMs !== null && endMs !== null && endMs <= startMs) {
      issues.push(issue('time-reverse', `第 ${r.seq} 行：结束 ${endMs} ≤ 开始 ${startMs}`));
    }

    // 解析目标轨道
    let trackId = null;
    if (r.trackSource) {
      trackId = resolvedSources.get(r.trackSource) ?? null;
      if (!trackId) {
        issues.push(issue('unknown-track', `第 ${r.seq} 行：轨道「${r.trackSource}」在项目中不存在（可在上方映射为现有轨或选择新建）`));
      }
    } else {
      trackId = options.defaultTrackId && trackById.has(options.defaultTrackId) ? options.defaultTrackId : null;
      if (!trackId) issues.push(issue('missing-default-track', `第 ${r.seq} 行：未选择导入到哪条轨道`));
    }

    // 文件内重复（同文本，与轨无关——SRT 等单轨导出的典型重复）
    const dk = dupKey(text);
    let dupOf = null;
    if (dk) {
      if (seenText.has(dk)) {
        dupOf = seenText.get(dk);
        issues.push(issue('dup-file', `第 ${r.seq} 行：与文件内第 ${dupOf} 行文本重复`));
      } else {
        seenText.set(dk, r.seq);
      }
    }

    // 项目内同轨同文
    let targetCueId = null;
    let action = 'add';
    if (trackId && !issues.some((i) => i.severity === 'error')) {
      const sameText = (snapshot.cues || []).find((c) => c.trackId === trackId && dupKey(c.text) === dk);
      if (sameText) {
        targetCueId = sameText.id;
        action = 'skip';
        const sameSlot = sameText.start === startMs && sameText.end === endMs;
        issues.push(issue(
          'dup-project',
          `第 ${r.seq} 行：${sameSlot ? '时间与文本均与' : '文本与'}项目中已有句子 ${sameText.id} 相同`,
        ));
      } else {
        const sameSlotCue = (snapshot.cues || []).find(
          (c) => c.trackId === trackId && c.start === startMs && c.end === endMs,
        );
        if (sameSlotCue) {
          targetCueId = sameSlotCue.id;
          if (sameSlotCue.locked) {
            issues.push(issue('locked', `第 ${r.seq} 行：同时间槽的句子 ${sameSlotCue.id} 已锁定，禁止覆盖`));
          } else {
            action = 'update'; // 同槽不同文 -> 视为修改该句
          }
        }
      }
    }

    const hasError = issues.some((i) => i.severity === 'error');
    const hasWarning = issues.some((i) => i.severity === 'warning');
    // 只有零问题的行才是"合法条目"；非法时间与重复等都只能跳过
    const legal = !hasError && !hasWarning;
    const included = options.included?.[r.seq] ?? legal;

    return {
      seq: r.seq,
      line: r.line,
      trackSource: r.trackSource,
      trackId,
      startRaw: String(r.startRaw ?? ''),
      endRaw: String(r.endRaw ?? ''),
      startMs,
      endMs,
      text,
      issues,
      action: included ? action : 'skip',
      targetCueId,
      dupOf,
      included,
      editable: legal,
    };
  });

  const summary = summarize(rows);
  return {
    format: parsed.format,
    filename,
    columns: parsed.columns,
    mapping: parsed.mapping,
    rows,
    trackSources,
    options: {
      defaultTrackId: options.defaultTrackId || tracks[0]?.id || null,
      createMissingTracks: Boolean(options.createMissingTracks),
    },
    summary,
  };
}

function issue(code, message, field = null) {
  const severity = ['dup-file', 'dup-project'].includes(code) ? 'warning' : 'error';
  return { code, message, severity, field };
}

function emptySummary() {
  return { total: 0, included: 0, errors: 0, warnings: 0, add: 0, update: 0, skip: 0, reasons: {} };
}

function summarize(rows) {
  const s = emptySummary();
  s.total = rows.length;
  for (const r of rows) {
    const err = r.issues.find((i) => i.severity === 'error');
    const warn = r.issues.find((i) => i.severity === 'warning');
    if (err) { s.errors++; s.reasons[err.code] = (s.reasons[err.code] || 0) + 1; }
    if (warn) { s.warnings++; s.reasons[warn.code] = (s.reasons[warn.code] || 0) + 1; }
    if (r.included) {
      s.included++;
      s[r.action === 'update' ? 'update' : 'add']++;
    } else {
      s.skip++;
      const reason = err?.code || warn?.code || 'manual-exclude';
      s.reasons[reason] = (s.reasons[reason] || 0) + 1;
    }
  }
  return s;
}

/* ------------------------------ 应用导入 ------------------------------ */

/**
 * 把预览中被勾选的条目应用到快照。
 * includedSeqs: 用户确认要导入的行号集合；服务端仍会强制剔除错误行。
 * 返回 { snapshot, addedCueIds, addedTracks, updated, skips }
 */
function applyImport(baseSnapshot, preview, includedSeqs, idGen = newId) {
  const snap = {
    duration: baseSnapshot.duration,
    settings: JSON.parse(JSON.stringify(baseSnapshot.settings || {})),
    tracks: (baseSnapshot.tracks || []).map((t) => ({ ...t })),
    cues: (baseSnapshot.cues || []).map((c) => ({ ...c })),
  };
  const chosen = new Set(includedSeqs || []);

  // 新建轨道（预览中 target === '__new__' 的来源）
  const newTrackByName = new Map();
  for (const src of preview.trackSources || []) {
    if (src.status === 'new' || src.target === '__new__') {
      const id = idGen('t');
      const track = {
        id,
        name: src.name,
        color: TRACK_COLORS[snap.tracks.length % TRACK_COLORS.length],
        mutexGroup: null,
      };
      snap.tracks.push(track);
      newTrackByName.set(src.name, id);
    }
  }
  const addedTracks = snap.tracks.slice((baseSnapshot.tracks || []).length).map((t) => ({ id: t.id, name: t.name }));

  const cueById = new Map(snap.cues.map((c) => [c.id, c]));
  const addedCueIds = [];
  const added = [];
  const updated = [];
  const skips = [];

  for (const row of preview.rows) {
    // 强制只应用零问题的合法条目，客户端勾选不能越权（非法时间/重复/锁定一律跳过）
    const legal = !row.issues.length;
    const include = legal && chosen.has(row.seq);
    if (!include) {
      const err = row.issues.find((i) => i.severity === 'error');
      const warn = row.issues.find((i) => i.severity === 'warning');
      skips.push({
        seq: row.seq,
        line: row.line,
        text: row.text,
        reason: err?.code || warn?.code || 'manual-exclude',
      });
      continue;
    }

    let trackId = row.trackId;
    if (row.trackSource && newTrackByName.has(row.trackSource)) trackId = newTrackByName.get(row.trackSource);

    if (row.action === 'update' && cueById.has(row.targetCueId)) {
      const cue = cueById.get(row.targetCueId);
      if (cue.locked) {
        skips.push({ seq: row.seq, line: row.line, text: row.text, reason: 'locked', cueId: cue.id });
        continue;
      }
      const before = { start: cue.start, end: cue.end, text: cue.text, trackId: cue.trackId, locked: cue.locked };
      cue.start = row.startMs;
      cue.end = row.endMs;
      cue.text = row.text;
      updated.push({
        seq: row.seq,
        cueId: cue.id,
        old: before,
        next: { start: cue.start, end: cue.end, text: cue.text, trackId: cue.trackId, locked: cue.locked },
      });
    } else {
      const cue = {
        id: idGen('c'),
        trackId,
        start: row.startMs,
        end: row.endMs,
        text: row.text,
        locked: false,
      };
      snap.cues.push(cue);
      cueById.set(cue.id, cue);
      addedCueIds.push(cue.id);
      added.push({ cueId: cue.id, seq: row.seq, value: { ...cue } });
    }
  }

  // 与 normalizeSnapshot 相同的排序/时长口径，避免再依赖 validation 层
  snap.cues.sort((a, b) => a.start - b.start || a.end - b.end);
  snap.duration = Math.max(baseSnapshot.duration || 0, ...snap.cues.map((c) => c.end));

  // 新增条目清单（带导入时的完整值，回滚据此判断"是否被他人改过"）
  const importedAdded = added;

  return { snapshot: snap, addedCueIds, added, addedTracks, updated, skips, cueById, importedAdded };
}

/* ------------------------------ 回滚计划 ------------------------------ */

/**
 * 在当前快照上规划"撤销导入"。
 * preSnapshot：导入提交的主父快照（导入前状态）
 * meta.imported：导入提交记录的清单
 *   { addedCueIds:[{cueId,value}], updated:[{cueId,old,next}], addedTracks:[{id,name}] }
 * 只回滚导入后未再被修改的句子；已改/已删/已锁定的逐条跳过并给原因。
 */
function planRollback(preSnapshot, importedMeta, currentSnapshot, idGen = newId) {
  const snap = {
    duration: currentSnapshot.duration,
    settings: JSON.parse(JSON.stringify(currentSnapshot.settings || {})),
    tracks: (currentSnapshot.tracks || []).map((t) => ({ ...t })),
    cues: (currentSnapshot.cues || []).map((c) => ({ ...c })),
  };
  const curById = new Map(snap.cues.map((c) => [c.id, c]));
  const entries = []; // 审计条目
  const rolledCueIds = [];
  const skipped = [];

  const cueEqual = (cue, value) =>
    cue && cue.start === value.start && cue.end === value.end && cue.trackId === value.trackId &&
    cue.text === value.text && cue.locked === false;

  // 新增句：与导入值完全一致才删除，否则视为导入后被他人改动而跳过
  for (const item of importedMeta.addedCueIds || []) {
    const cur = curById.get(item.cueId);
    if (!cur) {
      skipped.push({ cueId: item.cueId, reason: 'deleted-after-import' });
      entries.push(skipEntry(item.cueId, 'deleted-after-import'));
      continue;
    }
    if (!cueEqual(cur, item.value)) {
      skipped.push({ cueId: item.cueId, reason: 'changed-after-import' });
      entries.push(skipEntry(item.cueId, 'changed-after-import'));
      continue;
    }
    entries.push({ field: `cue:${item.cueId}`, action: 'rollback', oldValue: describe(cur), newValue: null });
    snap.cues = snap.cues.filter((c) => c.id !== item.cueId);
    curById.delete(item.cueId);
    rolledCueIds.push(item.cueId);
  }

  // 修改句：当前值仍等于导入写入值才回滚；回滚目标取"导入主父"中的值——
  // 若该句在并发期被对方改过并在冲突裁决中人工选择了导入方，撤销时恢复对方版本而非导入者基点
  const preById = new Map((preSnapshot.cues || []).map((c) => [c.id, c]));
  for (const u of importedMeta.updated || []) {
    const cur = curById.get(u.cueId);
    const preCue = preById.get(u.cueId);
    if (!cur) {
      skipped.push({ cueId: u.cueId, reason: 'deleted-after-import' });
      entries.push(skipEntry(u.cueId, 'deleted-after-import'));
      continue;
    }
    const n = u.next;
    const untouched = cur.start === n.start && cur.end === n.end && cur.text === n.text &&
      cur.trackId === n.trackId && cur.locked === false;
    if (!untouched) {
      skipped.push({ cueId: u.cueId, reason: 'changed-after-import' });
      entries.push(skipEntry(u.cueId, 'changed-after-import'));
      continue;
    }
    if (!preCue) {
      // 对方在并发期删除了该句、冲突裁决时人工保留了导入版本：撤销即删除
      entries.push({ field: `cue:${u.cueId}`, action: 'rollback', oldValue: describe(cur), newValue: null });
      snap.cues = snap.cues.filter((c) => c.id !== u.cueId);
      curById.delete(u.cueId);
      rolledCueIds.push(u.cueId);
      continue;
    }
    entries.push({
      field: `cue:${u.cueId}`,
      action: 'rollback',
      oldValue: describe(cur),
      newValue: describe(preCue),
    });
    cur.start = preCue.start;
    cur.end = preCue.end;
    cur.text = preCue.text;
    cur.trackId = preCue.trackId;
    cur.locked = preCue.locked;
    rolledCueIds.push(u.cueId);
  }

  // 新建轨道：当前无任何句子引用且未被改名/改色才删除
  const rolledTracks = [];
  for (const t of importedMeta.addedTracks || []) {
    const cur = snap.tracks.find((x) => x.id === t.id);
    if (!cur) continue;
    const inUse = snap.cues.some((c) => c.trackId === t.id);
    if (inUse) {
      skipped.push({ trackId: t.id, reason: 'track-in-use' });
      entries.push(skipEntry(t.id, 'track-in-use', 'track'));
      continue;
    }
    if (cur.name !== t.name) {
      skipped.push({ trackId: t.id, reason: 'track-changed' });
      entries.push(skipEntry(t.id, 'track-changed', 'track'));
      continue;
    }
    entries.push({ field: `track:${t.id}`, action: 'rollback', oldValue: describe(cur), newValue: null });
    snap.tracks = snap.tracks.filter((x) => x.id !== t.id);
    rolledTracks.push(t.id);
  }

  snap.cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const preEnds = (preSnapshot.cues || []).map((c) => c.end);
  snap.duration = Math.max(preSnapshot.duration || 0, ...preEnds, ...snap.cues.map((c) => c.end));

  return { snapshot: snap, entries, rolledCueIds, rolledTracks, skipped };
}

function skipEntry(id, reason, entity = 'cue') {
  return {
    field: `${entity}:${id}`,
    action: 'skip',
    oldValue: null,
    newValue: describe({ reason, stage: 'rollback' }),
  };
}

module.exports = {
  parseTimeMs,
  parseSubtitle,
  detectFormat,
  buildPreview,
  applyImport,
  planRollback,
  ISSUE_LABELS,
};
