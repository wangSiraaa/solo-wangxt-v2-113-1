import {
  RevisionError,
  checkRevision,
  diffPayloads,
  isDirtyAgainst,
  nextBranchName,
  payloadFromProject,
  planCheckpoint,
  planLegacyMigration,
  planRestore,
  projectFromPayload,
  validatePayload,
  validateRevision
} from '../src/lib/revisions.ts';
import { glideSample, p6mSample } from '../src/lib/samples.ts';
import type { ProjectMeta, Revision, RevisionPayload } from '../src/types.ts';

let failures = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name}`);
  }
}

function expectRevisionError(name: string, fn: () => unknown, match: string) {
  try {
    fn();
    failures += 1;
    console.error(`✗ ${name}（未抛出预期错误）`);
  } catch (error) {
    const ok = error instanceof RevisionError && error.message.includes(match);
    if (ok) {
      console.log(`✓ ${name}`);
    } else {
      failures += 1;
      console.error(`✗ ${name}（错误类型或消息不符: ${String(error)}）`);
    }
  }
}

const meta = (id: string, counter = 0): ProjectMeta => ({
  id,
  name: '测试工程',
  createdAt: 1000,
  updatedAt: 1000,
  branchCounter: counter
});

// ---------- 载荷校验 ----------
const sample = p6mSample();
const payload = payloadFromProject(sample);
check('样例载荷通过校验', validatePayload(payload).objects.length === sample.objects.length);
check(
  '载荷完整保留群/晶格/对象 ID/样式',
  payload.group === sample.group &&
    payload.cellWidth === sample.cellWidth &&
    payload.cellHeight === sample.cellHeight &&
    payload.objects.every((object, i) => {
      const source = sample.objects[i]!;
      return (
        object.id === source.id &&
        object.fill === source.fill &&
        object.stroke === source.stroke &&
        object.strokeWidth === source.strokeWidth &&
        object.opacity === source.opacity &&
        JSON.stringify(object.path) === JSON.stringify(source.path)
      );
    })
);

expectRevisionError('拒绝未知群', () => validatePayload({ ...payload, group: 'p17' }), '不支持的墙纸群');
expectRevisionError('拒绝非法晶格尺寸', () => validatePayload({ ...payload, cellWidth: Number.NaN }), 'cellWidth');
expectRevisionError('拒绝缺失对象 ID', () =>
  validatePayload({ ...payload, objects: [{ ...payload.objects[0]!, id: '' }, ...payload.objects.slice(1)] }), 'id');
expectRevisionError('拒绝未知路径段类型', () =>
  validatePayload({
    ...payload,
    objects: [{ ...payload.objects[0]!, path: [{ type: 'X', x: 1, y: 2 }] }, ...payload.objects.slice(1)]
  }), '类型不支持');
expectRevisionError('拒绝路径中的非有限坐标', () =>
  validatePayload({
    ...payload,
    objects: [{ ...payload.objects[0]!, path: [{ type: 'M', x: Number.NaN, y: 0 }] }, ...payload.objects.slice(1)]
  }), '有限数值');
expectRevisionError('拒绝越界不透明度', () =>
  validatePayload({ ...payload, objects: [{ ...payload.objects[0]!, opacity: 1.5 }, ...payload.objects.slice(1)] }), '不透明度');
expectRevisionError('拒绝重复对象 ID', () =>
  validatePayload({ ...payload, objects: [payload.objects[0]!, payload.objects[0]!] }), '重复的对象 ID');

// ---------- 修订记录校验 ----------
const m0 = meta('proj-1');
const plan1 = planCheckpoint({
  projectId: m0.id,
  branch: 'main',
  baseRevisionId: null,
  payload,
  meta: m0,
  label: 'A',
  now: 2000
});
const revA = plan1.revision;
check('检查点 A 是根修订且位于 main', revA.parentId === null && revA.branch === 'main');
check('检查点后工作副本切到新分支', plan1.workingCopy.branch === '分支-1' && plan1.workingCopy.branch !== revA.branch);
check('检查点后工作副本以 A 为基修订', plan1.workingCopy.baseRevisionId === revA.id);

expectRevisionError('拒绝不支持的修订格式', () => validateRevision({ ...revA, format: 2 }), '不支持的修订格式');
expectRevisionError('拒绝缺失分支名', () => validateRevision({ ...revA, branch: '' }), 'branch');
expectRevisionError('拒绝非法父修订字段', () => validateRevision({ ...revA, parentId: 7 }), 'parentId');
expectRevisionError('拒绝损坏的载荷', () => validateRevision({ ...revA, payload: { ...revA.payload, objects: null } }), 'objects');
check('checkRevision 不抛出且报告错误', (() => {
  const result = checkRevision({ ...revA, format: 99 });
  return !result.ok && result.error.includes('不支持的修订格式');
})());

// ---------- 分支语义：A 分出两套修改 ----------
const edited1 = structuredClone(payload);
edited1.objects[0]!.fill = '#ff0000';
const planB1 = planCheckpoint({
  projectId: m0.id,
  branch: plan1.workingCopy.branch,
  baseRevisionId: plan1.workingCopy.baseRevisionId,
  payload: edited1,
  meta: plan1.meta,
  label: 'B1',
  now: 3000
});
check('B1 是 A 的后代且在新分支上', planB1.revision.parentId === revA.id && planB1.revision.branch === '分支-1');

const restoreA = planRestore({ revision: revA, meta: planB1.meta, now: 4000 });
check('恢复 A 生成新分支的工作副本', restoreA.workingCopy.branch === '分支-3' && restoreA.workingCopy.baseRevisionId === revA.id);
check('恢复不篡改原修订', JSON.stringify(revA.payload) === JSON.stringify(payload));

const edited2 = structuredClone(payload);
edited2.objects[0]!.strokeWidth = 9;
const planB2 = planCheckpoint({
  projectId: m0.id,
  branch: restoreA.workingCopy.branch,
  baseRevisionId: restoreA.workingCopy.baseRevisionId,
  payload: edited2,
  meta: restoreA.meta,
  label: 'B2',
  now: 5000
});
check('B2 也是 A 的后代且分支不同于 B1', planB2.revision.parentId === revA.id && planB2.revision.branch === '分支-3');
check('A、B1、B2 分支两两不同', new Set([revA.branch, planB1.revision.branch, planB2.revision.branch]).size === 3);
check('B1 载荷不受 B2 影响', planB1.revision.payload.objects[0]!.fill === '#ff0000' && planB1.revision.payload.objects[0]!.strokeWidth !== 9);

// ---------- 恢复后再编辑形成新后代 ----------
const restoreA2 = planRestore({ revision: revA, meta: planB2.meta, now: 6000 });
const edited3 = structuredClone(revA.payload);
edited3.objects.push({ ...edited3.objects[0]!, id: 'object_new', name: '新对象' });
const planC = planCheckpoint({
  projectId: m0.id,
  branch: restoreA2.workingCopy.branch,
  baseRevisionId: restoreA2.workingCopy.baseRevisionId,
  payload: edited3,
  meta: restoreA2.meta,
  label: 'C',
  now: 7000
});
check('恢复 A 后编辑形成 A 的新后代', planC.revision.parentId === revA.id && planC.revision.branch !== planB1.revision.branch && planC.revision.branch !== planB2.revision.branch);
check('后代保留原对象 ID', planC.revision.payload.objects.slice(0, -1).every((object, i) => object.id === revA.payload.objects[i]!.id));

// ---------- 工程往返 ----------
const roundTrip = projectFromPayload(meta(m0.id), revA.payload);
check(
  '载荷→工程往返保留对象 ID 与路径',
  roundTrip.objects.every((object, i) => object.id === revA.payload.objects[i]!.id) &&
    JSON.stringify(payloadFromProject(roundTrip)) === JSON.stringify(revA.payload)
);
check('脏检测：与基修订一致时不脏', !isDirtyAgainst(roundTrip, revA));
const dirtyProject = structuredClone(roundTrip);
dirtyProject.cellWidth += 10;
check('脏检测：修改晶格后变脏', isDirtyAgainst(dirtyProject, revA));

// ---------- 差异对比 ----------
const before = payloadFromProject(glideSample());
const after = structuredClone(before);
after.group = 'p4';
after.cellHeight = after.cellWidth;
after.objects[0]!.fill = '#123456';
after.objects[0]!.path = [...after.objects[0]!.path, { type: 'L', x: 1, y: 1 } as const];
const removedId = after.objects[1]!.id;
after.objects.splice(1, 1);
after.objects.push({ ...after.objects[0]!, id: 'object_added', name: '新增对象' });
const diff = diffPayloads(before, after);
check('差异：群变化', diff.group?.from === 'pg' && diff.group?.to === 'p4');
check('差异：晶格变化', diff.cell !== null && diff.cell.to[0] === diff.cell.to[1]);
check('差异：修改对象包含填充与路径段数', (() => {
  const modified = diff.objects.find((object) => object.change === 'modified');
  return !!modified && modified.details.some((d) => d.includes('填充')) && modified.details.some((d) => d.includes('路径段数'));
})());
check('差异：删除对象', diff.objects.some((object) => object.change === 'removed' && object.id === removedId));
check('差异：新增对象', diff.objects.some((object) => object.change === 'added' && object.id === 'object_added'));
check('差异：相同载荷为空', diffPayloads(before, structuredClone(before)).empty);

// ---------- 旧版工程迁移 ----------
const legacy = {
  id: 'legacy-1',
  name: '旧工程',
  group: sample.group,
  cellWidth: sample.cellWidth,
  cellHeight: sample.cellHeight,
  objects: structuredClone(sample.objects),
  updatedAt: 900
};
const migration = planLegacyMigration(legacy, 8000);
check('旧工程迁移生成初始修订', migration !== null && migration.revision.parentId === null && migration.revision.branch === 'main');
check('迁移载荷无损', migration !== null && JSON.stringify(migration.revision.payload) === JSON.stringify(payloadFromProject(sample)));
check('迁移后工作副本以初始修订为基且在新分支', migration !== null && migration.workingCopy.baseRevisionId === migration.revision.id && migration.workingCopy.branch === '分支-1');
check('迁移保留工程名称', migration?.meta.name === '旧工程');
check('损坏的旧记录不迁移', planLegacyMigration({ id: 'bad', group: 'nope' }, 8000) === null);
check('新版元数据不会被当作旧记录', planLegacyMigration(meta('x'), 8000) === null);

// ---------- 分支命名 ----------
check('分支名随计数器递增', nextBranchName(meta('p', 0)) === '分支-1' && nextBranchName(meta('p', 4)) === '分支-5');

// ---------- 类型层面的修订不可变性 ----------
const frozen: Revision = planCheckpoint({
  projectId: m0.id,
  branch: 'main',
  baseRevisionId: null,
  payload,
  meta: m0,
  label: 'X',
  now: 100
}).revision;
const copyBefore = JSON.stringify(frozen);
planRestore({ revision: frozen, meta: m0, now: 200 });
diffPayloads(frozen.payload, payload);
check('派生操作不修改原修订对象', JSON.stringify(frozen) === copyBefore);

console.log(failures === 0 ? '全部修订逻辑检查通过' : `${failures} 项检查失败`);
process.exit(failures ? 1 : 0);
