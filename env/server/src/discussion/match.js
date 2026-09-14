'use strict';
/**
 * 讨论锚点的跨版本跟随匹配。
 *
 * 原则：只有能**唯一对应到原字幕内容**时讨论才自动跟随；
 * 对应字幕被删除、拆分（一句变多句）或无法唯一匹配时进入待重新定位（orphan），
 * 绝不悄悄挂到错误内容上。
 *
 * 判定方式：
 *   1) 稳定句子编号（cue id）仍在新版本中：直接跟随（即便文本/时间/轨道被修改）；
 *   2) 旧编号消失：用「文本相似度 + 时间接近度」在新版本中找候选——
 *      · 恰好一个强候选：自动跟随（记录 auto-follow 定位历史）；
 *      · 两个及以上候选（删除后重建为多句/拆分）：orphan，原因 split，保留候选；
 *      · 一个中等候选（不能唯一确认）：orphan，原因 ambiguous，保留候选；
 *      · 没有候选：orphan，原因 deleted。
 *   3) 时间范围锚点：不绑定句子身份，只要范围所在轨仍存在就保留在同一时间坐标上；
 *      轨道被删除时 orphan，原因 track-deleted。
 */

const { textSimilarity, timeProximity } = require('../report/match');

// 自动跟随阈值：强候选必须文本与时间都有足够证据，避免误挂
const STRONG_SIM = 0.5;
const STRONG_TIME = 0.55;
const STRONG_SCORE = 0.6;
// 候选收集阈值（split/ambiguous 的候选要带给页面，阈值以下视为无对应）
const CANDIDATE_SIM = 0.3;
const CANDIDATE_TIME = 0.35;
const CANDIDATE_SCORE = 0.4;

/**
 * 为一个旧 cue 锚点计算迁移结果。
 * 返回 { outcome: 'follow'|'orphan', cueId?, reason?, candidates? }
 */
function resolveCueAnchor(oldCue, newSnap) {
  const same = (newSnap.cues || []).find((c) => c.id === oldCue.id);
  if (same) return { outcome: 'follow', cueId: same.id, via: 'id' };

  const candidates = [];
  for (const c of newSnap.cues || []) {
    const sim = textSimilarity(oldCue.text, c.text);
    const time = timeProximity(oldCue, c);
    const score = 0.65 * sim + 0.35 * time;
    if ((sim >= CANDIDATE_SIM && time >= CANDIDATE_TIME) || score >= CANDIDATE_SCORE) {
      candidates.push({ cueId: c.id, trackId: c.trackId, start: c.start, end: c.end, text: c.text, sim, time, score });
    }
  }
  // 确定性排序：分数降序，平分按 cueId，保证多次执行结果一致
  candidates.sort((a, b) =>
    b.score - a.score || (a.cueId < b.cueId ? -1 : a.cueId > b.cueId ? 1 : 0),
  );

  if (candidates.length === 0) return { outcome: 'orphan', reason: 'deleted', candidates: [] };
  if (candidates.length >= 2) return { outcome: 'orphan', reason: 'split', candidates };
  const only = candidates[0];
  if (only.sim >= STRONG_SIM && only.time >= STRONG_TIME && only.score >= STRONG_SCORE) {
    return { outcome: 'follow', cueId: only.cueId, via: 'content', candidates };
  }
  return { outcome: 'orphan', reason: 'ambiguous', candidates };
}

/** 时间范围锚点：轨道仍存在则保留，否则 track-deleted。track=''（全部轨）永远保留。 */
function resolveRangeAnchor(anchor) {
  if (!anchor.track) return { outcome: 'keep' };
  return { outcome: 'keep' }; // 轨道存在性由调用方依据快照校验
}

module.exports = { resolveCueAnchor, resolveRangeAnchor };
