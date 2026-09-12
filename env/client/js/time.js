// 全部时间以整数毫秒为统一内部基准；界面显示 SRT 风格 HH:MM:SS,mmm
export function msToSrt(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(milli, 3)}`;
}

export function parseTime(str) {
  if (typeof str === 'number') return Math.round(str);
  str = String(str).trim().replace('，', ',');
  // 毫秒纯数字
  if (/^\d+$/.test(str)) return Number(str);
  const m = str.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) throw new Error('时间格式应为 HH:MM:SS,mmm 或毫秒数');
  const h = Number(m[1] || 0);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0'));
  return h * 3600000 + min * 60000 + s * 1000 + ms;
}

export function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
