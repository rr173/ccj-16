'use strict';
/** 发布快照的 SRT / VTT 渲染。发布时一次性渲染并随快照冻结，下载内容永不变化。 */

function fmt(ms, sep) {
  ms = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))}${sep}${p(ms % 1000, 3)}`;
}

function renderSrt(cues) {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  return sorted
    .map((c, i) => `${i + 1}\n${fmt(c.start, ',')} --> ${fmt(c.end, ',')}\n${c.text}`)
    .join('\n\n') + (sorted.length ? '\n' : '');
}

function renderVtt(cues) {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const body = sorted
    .map((c) => `${fmt(c.start, '.')} --> ${fmt(c.end, '.')}\n${c.text}`)
    .join('\n\n');
  return 'WEBVTT\n\n' + body + (sorted.length ? '\n' : '');
}

/**
 * 为冻结快照渲染全部文件：
 * { srt: { all, <trackId>... }, vtt: { all, <trackId>... } }
 */
function renderFiles(snapshot) {
  const files = { srt: {}, vtt: {} };
  files.srt.all = renderSrt(snapshot.cues);
  files.vtt.all = renderVtt(snapshot.cues);
  for (const t of snapshot.tracks) {
    const cues = snapshot.cues.filter((c) => c.trackId === t.id);
    files.srt[t.id] = renderSrt(cues);
    files.vtt[t.id] = renderVtt(cues);
  }
  return files;
}

module.exports = { renderSrt, renderVtt, renderFiles };
