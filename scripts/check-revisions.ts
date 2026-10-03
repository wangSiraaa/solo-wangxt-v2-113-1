import {
  MAIN_BRANCH,
  REVISION_FORMAT,
  RevisionError,
  branchTips,
  childrenOf,
  createRevision,
  diffPayloads,
  freshBranchName,
  isEmptyDiff,
  isLegacyProjectRecord,
  isStaleSave,
  migrateLegacyProject,
  payloadFromProject,
  projectFromPayload,
  validatePayload,
  validateRevision,
  validateWorkingCopy
} from '../src/lib/revisions.ts';
import type { Project, Revision, WorkingCopy } from '../src/types.ts';
import { p6mSample } from '../src/lib/samples.ts';

let failures = 0;

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function expectRevisionError(name: string, run: () => void, pattern: RegExp) {
  try {
    run();
    failures += 1;
    console.error(`FAIL ${name} — 未抛出 RevisionError`);
  } catch (error) {
    const good = error instanceof RevisionError && pattern.test(error.message);
    check(name, good, error instanceof Error ? error.message : String(error));
  }
}

/** In-memory stand-in for the IndexedDB layer + controller semantics. */
class Workspace {
  revisions = new Map<string, Revision>();
  workingCopy: WorkingCopy;
  branchNames = new Set<string>([MAIN_BRANCH]);

  constructor(readonly project: Project) {
    this.workingCopy = {
      projectId: project.id,
      baseRevisionId: null,
      branch: MAIN_BRANCH,
      generation: 0,
      payload: payloadFromProject(project),
      updatedAt: Date.now()
    };
  }

  checkpoint(label: string, now: number): Revision {
    const revision = createRevision({
      projectId: this.project.id,
      parentId: this.workingCopy.baseRevisionId,
      branch: this.workingCopy.branch,
      label,
      payload: this.workingCopy.payload,
      now
    });
    if (this.revisions.has(revision.id)) throw new Error('修订 id 冲突，禁止覆盖');
    this.revisions.set(revision.id, revision);
    this.branchNames.add(revision.branch);
    // Checkpointing seals the branch: further edits continue on a new branch.
    this.workingCopy = {
      ...this.workingCopy,
      baseRevisionId: revision.id,
      branch: freshBranchName(this.branchNames),
      generation: this.workingCopy.generation + 1
    };
    this.branchNames.add(this.workingCopy.branch);
    return revision;
  }

  restore(id: string, now: number): Project {
    const revision = validateRevision(this.revisions.get(id));
    this.workingCopy = {
      projectId: this.project.id,
      baseRevisionId: revision.id,
      branch: freshBranchName(this.branchNames),
      generation: this.workingCopy.generation + 1,
      payload: structuredClone(revision.payload),
      updatedAt: now
    };
    this.branchNames.add(this.workingCopy.branch);
    return projectFromPayload(this.project.id, revision.payload);
  }

  edit(mutate: (project: Project) => void) {
    const project = projectFromPayload(this.project.id, this.workingCopy.payload);
    mutate(project);
    this.workingCopy = { ...this.workingCopy, payload: payloadFromProject(project) };
  }
}

/* ① Two divergent modification sets forked from checkpoint A ------------- */

const sample = p6mSample();
const ws = new Workspace(sample);
const A = ws.checkpoint('检查点 A', 1000);

ws.edit((project) => {
  project.objects[0]!.fill = '#ff0000';
  project.objects[0]!.path = project.objects[0]!.path.map((seg) =>
    'x' in seg ? { ...seg, x: (seg.x as number) + 5 } : seg
  );
});
const B = ws.checkpoint('分支一：红化+平移', 2000);

const restoredA = ws.restore(A.id, 3000);
check('恢复 A 后画布对象 ID 与 A 一致', restoredA.objects.map((o) => o.id).join() ===
  (A.payload.objects.map((o) => o.id).join()));
ws.edit((project) => {
  project.objects[1]!.stroke = '#00ff00';
  project.objects[1]!.opacity = 0.5;
});
const C = ws.checkpoint('分支二：改描边与透明度', 4000);

check('B 的父修订是 A', B.parentId === A.id);
check('C 的父修订是 A', C.parentId === A.id);
check('B 与 C 位于不同分支', B.branch !== C.branch, `${B.branch} vs ${C.branch}`);
check('检查点后继续编辑落在新分支', B.branch !== A.branch && C.branch !== A.branch);
check('A 不可变：仍含原始填充色', A.payload.objects[0]!.fill === sample.objects[0]!.fill);
check('B 的修改不影响 C', C.payload.objects[0]!.fill === sample.objects[0]!.fill);
check('C 的修改不影响 B', B.payload.objects[1]!.stroke === sample.objects[1]!.stroke);
check('A 有两个子修订（分支点）', childrenOf([...ws.revisions.values()], A.id).length === 2);
check('三个分支名互不冲突', new Set([A.branch, B.branch, C.branch]).size === 3);

/* ② Restoring A again forms a new descendant; IDs and history kept ------- */

const before = ws.revisions.get(B.id);
ws.restore(A.id, 5000);
ws.edit((project) => {
  project.objects[2]!.strokeWidth = 9;
});
const D = ws.checkpoint('恢复 A 后的新尝试', 6000);

check('恢复 A 后编辑形成 A 的新后代', D.parentId === A.id);
check('D 在新分支上，不复用旧分支名', ![A.branch, B.branch, C.branch].includes(D.branch));
check('原分支 B 的修订未被篡改', ws.revisions.get(B.id) === before);
check('D 保留 A 的对象 ID', D.payload.objects.map((o) => o.id).join() ===
  A.payload.objects.map((o) => o.id).join());
check('分支末端计算正确', branchTips([...ws.revisions.values()]).get(B.branch)?.id === B.id);

/* ③ Payload round-trip keeps everything the canvas/export needs ---------- */

const roundTrip = projectFromPayload(sample.id, payloadFromProject(sample));
check(
  '载荷往返无损（群/晶格/对象/样式/ID）',
  JSON.stringify({ ...roundTrip, updatedAt: 0 }) === JSON.stringify({ ...sample, updatedAt: 0 })
);
const wc = validateWorkingCopy(ws.workingCopy);
check('工作副本校验通过且携带世代', wc.generation === ws.workingCopy.generation);

/* ④ Corrupt or unsupported revisions fail explicitly --------------------- */

expectRevisionError(
  '不支持的格式版本明确失败',
  () => validateRevision({ ...A, format: REVISION_FORMAT + 1 }),
  /不支持的修订格式版本/
);
expectRevisionError('缺对象数组明确失败', () => {
  const broken = structuredClone(A) as unknown as { payload: { objects: unknown } };
  broken.payload.objects = undefined;
  validateRevision(broken);
}, /缺少对象数组/);
expectRevisionError('非法群名明确失败', () => {
  const broken = structuredClone(A) as unknown as { payload: { group: unknown } };
  broken.payload.group = 'p17';
  validateRevision(broken);
}, /未知墙纸群/);
expectRevisionError('路径段缺字段明确失败', () => {
  const broken = structuredClone(A);
  delete (broken.payload.objects[0]!.path[0] as { x?: number }).x;
  validateRevision(broken);
}, /缺少数值字段/);
expectRevisionError('重复对象 ID 明确失败', () => {
  const broken = structuredClone(A);
  broken.payload.objects.push(structuredClone(broken.payload.objects[0]!));
  validateRevision(broken);
}, /对象 id 重复/);
expectRevisionError('空载荷明确失败', () => validatePayload(null), /缺少载荷/);
check('失败不改动既有修订', ws.revisions.get(A.id) === A && ws.revisions.size === 4);

/* ⑤ Legacy v1 migration is lossless and openable ------------------------- */

const legacy = {
  id: 'project_legacy',
  name: '旧版工程',
  group: 'pmg' as const,
  cellWidth: 210,
  cellHeight: 160,
  objects: sample.objects,
  updatedAt: 123456
};
check('识别旧版记录', isLegacyProjectRecord(legacy));
check('不误判 v2 元数据', !isLegacyProjectRecord({ id: 'x', schemaVersion: 2, objects: [] }));
const migrated = migrateLegacyProject(legacy, 999);
check('迁移生成主分支根修订', migrated.revision.parentId === null && migrated.revision.branch === MAIN_BRANCH);
check('迁移修订可打开（通过校验）', validateRevision(migrated.revision).id === migrated.revision.id);
check(
  '迁移载荷与旧记录逐字节一致',
  JSON.stringify(migrated.revision.payload) ===
    JSON.stringify({
      name: legacy.name,
      group: legacy.group,
      cellWidth: legacy.cellWidth,
      cellHeight: legacy.cellHeight,
      objects: legacy.objects
    })
);
check('迁移工作副本基于初始修订', migrated.workingCopy.baseRevisionId === migrated.revision.id);
check('迁移元数据指向初始修订', migrated.meta.headRevisionId === migrated.revision.id);
const reopened = projectFromPayload(legacy.id, migrated.workingCopy.payload);
check('迁移工程重新打开后对象 ID 不变', reopened.objects.map((o) => o.id).join() ===
  legacy.objects.map((o) => o.id).join());

/* ⑥ Autosave generation guard -------------------------------------------- */

const scheduled = { projectId: 'p1', generation: 3 };
check('同工程同世代不算过期', !isStaleSave(scheduled, { projectId: 'p1', generation: 3 }));
check('切换修订后旧保存过期', isStaleSave(scheduled, { projectId: 'p1', generation: 4 }));
check('加载其他工程后旧保存过期', isStaleSave(scheduled, { projectId: 'p2', generation: 3 }));

/* ⑦ Diff ------------------------------------------------------------------ */

const diff = diffPayloads(A.payload, B.payload);
check('diff 检出样式修改', diff.objects.some((o) => o.kind === 'modified' && o.styleChanges.includes('填充')));
check('diff 检出路径修改', diff.objects.some((o) => o.kind === 'modified' && o.pathChanged));
check('diff 未误报未改对象', diff.objects.length === 1);
const diffAC = diffPayloads(A.payload, C.payload);
check('diff 检出不透明度与描边', diffAC.objects.some(
  (o) => o.styleChanges.includes('描边') && o.styleChanges.includes('不透明度')
));
const selfDiff = diffPayloads(A.payload, A.payload);
check('自比较为空 diff', isEmptyDiff(selfDiff));
const groupDiff = diffPayloads(A.payload, { ...A.payload, group: 'p4', cellWidth: 300 });
check('diff 检出群切换', groupDiff.groupChanged?.to === 'p4');
check('diff 检出晶格变化', groupDiff.cellChanged?.to[0] === 300);
const addedDiff = diffPayloads(A.payload, {
  ...A.payload,
  objects: [...A.payload.objects, { ...A.payload.objects[0]!, id: 'object_new', name: '新对象' }]
});
check('diff 检出新增对象', addedDiff.objects.some((o) => o.kind === 'added' && o.id === 'object_new'));
const removedDiff = diffPayloads(A.payload, { ...A.payload, objects: A.payload.objects.slice(1) });
check('diff 检出删除对象', removedDiff.objects.some((o) => o.kind === 'removed'));

/* ------------------------------------------------------------------------- */

if (failures > 0) {
  console.error(`\n${failures} 项检查失败`);
  process.exit(1);
}
console.log('\n全部修订/分支检查点逻辑检查通过');
