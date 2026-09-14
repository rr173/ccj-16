// 多阶段会签与审批策略 单元测试（进程内直接驱动数据层）
// 说明：本文件含顶层 await，Node 将按 ES module 加载；故在动态 import 之前
// 先把 DATA_DIR 指到独立临时目录，确保不污染默认数据。
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-unit-'));
process.env.DATA_DIR = dir;

const store = (await import('../server/src/store.js')).default;
const qc = (await import('../server/src/qc/store.js')).default;
const approval = (await import('../server/src/qc/approval.js')).default;

let passed = 0;
function ok(cond, name, extra) {
  assert(cond, name + (extra ? ' ' + JSON.stringify(extra) : ''));
  passed++;
  console.log('  ✓', name);
}

/* ---------- 策略参数规范化 ---------- */
console.log('策略参数规范化');
assert.throws(() => approval.normalizeStages('x'), /数组/);
ok(true, '非数组策略被拒绝');
assert.throws(() => approval.normalizeStages([{ role: '', minApprovals: 1 }]), /审核角色/);
ok(true, '缺少角色被拒绝');
assert.throws(() => approval.normalizeStages([{ role: 'a', minApprovals: 0 }]), /1-99/);
ok(true, '最少同意人数下限校验');
assert.throws(() => approval.normalizeStages([{ role: 'a', minApprovals: 1.5 }]), /1-99/);
ok(true, '最少同意人数须为整数');
assert.throws(() => approval.normalizeStages([{ role: 'a', minApprovals: 1, ttlMs: -1 }]), /有效期/);
ok(true, '负数有效期被拒绝');
assert.throws(() => approval.normalizeStages(new Array(11).fill({ role: 'a', minApprovals: 1 })), /最多/);
ok(true, '阶段数量上限校验');
const norm = approval.normalizeStages([{ role: ' 审校 ', minApprovals: 2, allowResubmit: false, ttlMs: 3600000 }]);
ok(norm.length === 1 && norm[0].role === '审校' && norm[0].minApprovals === 2
  && norm[0].allowResubmit === false && norm[0].ttlMs === 3600000, '角色去空白/人数/驳回重提/有效期规范化');
ok(approval.normalizeStages([{ role: 'a', minApprovals: 1 }])[0].allowResubmit === true, '驳回重提默认允许');
ok(approval.normalizeStages(null).length === 0, '空策略等价于未配置');

/* ---------- 策略保存 / 清除 / 指纹 ---------- */
console.log('策略保存与指纹');
const { project } = store.createProject('审批策略单测', 'alice');
const pid = project.id;
ok(approval.getPolicy(pid) === null, '新项目无策略');
const p1 = approval.putPolicy(pid, { stages: [{ role: '审校', minApprovals: 2, ttlMs: 0 }], author: 'lead' });
ok(p1.policy && p1.policy.stages.length === 1 && typeof p1.policy.hash === 'string', '策略已保存并带指纹');
const p2 = approval.putPolicy(pid, { stages: [{ role: '审校', minApprovals: 2, ttlMs: 0 }], author: 'lead' });
ok(p2.policy.hash === p1.policy.hash, '相同策略指纹稳定');
const p3 = approval.putPolicy(pid, { stages: [{ role: '终审', minApprovals: 1, ttlMs: 0 }], author: 'lead' });
ok(p3.policy.hash !== p1.policy.hash, '策略变化指纹变化');
const cleared = approval.putPolicy(pid, { stages: [], author: 'lead' });
ok(cleared.policy === null && approval.getPolicy(pid) === null, '清除策略恢复单步审批');

/* ---------- 阶段实例与事件 ---------- */
console.log('阶段实例与事件');
approval.putPolicy(pid, { stages: [{ role: '审校', minApprovals: 1, ttlMs: 0 }], author: 'lead' });
approval.createStages(pid, 'rq_test', approval.getPolicy(pid).stages, 'alice', Date.now());
const stages = approval.stagesWithDecisions('rq_test');
ok(stages.length === 1 && stages[0].status === 'active' && stages[0].role === '审校', '阶段实例激活并冻结角色');
approval.addEvent(pid, 'rq_test', 0, 'stage-activate', 'alice', { role: '审校' });
const { db } = await import('../server/src/db.js');
const evCount = db.prepare('SELECT COUNT(*) AS c FROM relreq_events WHERE request_id=?').get('rq_test').c;
ok(evCount === 2, '事件流落库（建阶段 + 手工事件）');

console.log(`\n审批策略单元测试全部通过（${passed} 项断言）`);
