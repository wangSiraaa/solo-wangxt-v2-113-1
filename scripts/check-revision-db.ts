/**
 * Integration test for the IndexedDB v2 layer + revision controller, running
 * against fake-indexeddb in node. Covers: v1→v2 lossless migration, checkpoint
 * branching, safe restore, autosave generation guard, persistence across
 * reopen, and explicit failure on corrupted/unsupported revisions.
 */
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

(globalThis as Record<string, unknown>).indexedDB = indexedDB;
(globalThis as Record<string, unknown>).IDBKeyRange = IDBKeyRange;
const localStorageData = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => localStorageData.get(key) ?? null,
  setItem: (key: string, value: string) => void localStorageData.set(key, String(value)),
  removeItem: (key: string) => void localStorageData.delete(key)
};

const { editor, undo, updateProject } = await import('../src/lib/stores.ts');
const db = await import('../src/lib/db.ts');
const controller = await import('../src/lib/controller.ts');
const { glideSample, p6mSample } = await import('../src/lib/samples.ts');
const { get } = await import('svelte/store');
const { validateRevision } = await import('../src/lib/revisions.ts');

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const DB_NAME = 'wallpaper-symmetry-editor';

/* Seed a legacy v1 database with one old-format project record. ------------ */
const legacy = p6mSample();
await new Promise<void>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('projects', { keyPath: 'id' });
  };
  request.onsuccess = () => {
    const database = request.result;
    const tx = database.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(legacy);
    tx.oncomplete = () => {
      database.close();
      resolve();
    };
  };
  request.onerror = () => reject(request.error);
});

/* ③ Migration: legacy project opens as an initial revision. --------------- */
const metas = await db.listProjectMetas();
check('迁移后工程出现在 v2 列表', metas.some((meta) => meta.id === legacy.id));
const migratedMeta = metas.find((meta) => meta.id === legacy.id);
check('迁移元数据指向初始修订', typeof migratedMeta?.headRevisionId === 'string');

const opened = await controller.openProject(legacy.id);
check('旧版工程可打开', opened);
const afterOpen = get(editor);
check('打开后群一致', afterOpen.project.group === legacy.group);
check('打开后晶格一致', afterOpen.project.cellWidth === legacy.cellWidth &&
  afterOpen.project.cellHeight === legacy.cellHeight);
check('打开后对象 ID 全部保留', afterOpen.project.objects.map((o) => o.id).join() ===
  legacy.objects.map((o) => o.id).join());
check('打开后路径与样式逐字节一致', JSON.stringify(afterOpen.project.objects) ===
  JSON.stringify(legacy.objects));
let context = get(controller.revisionState);
check('初始修订为主分支根修订', context.revisions.length === 1 &&
  context.revisions[0]!.parentId === null && context.revisions[0]!.branch === '主分支');
check('工作副本基于初始修订', context.baseRevisionId === context.revisions[0]!.id);

/* ① Checkpoint A, then two divergent branches. ---------------------------- */
const generationBefore = get(editor).generation;
await controller.createCheckpoint('检查点 A');
context = get(controller.revisionState);
const A = context.revisions.find((revision) => revision.label === '检查点 A')!;
check('A 落在主分支', A.branch === '主分支');
check('检查点后工作副本切到新分支', context.branch === '分支-2');
check('检查点不改变画布内容', JSON.stringify(get(editor).project.objects) === JSON.stringify(legacy.objects));

updateProject((project) => ({
  ...project,
  objects: project.objects.map((object, index) =>
    index === 0 ? { ...object, fill: '#aa0000' } : object
  )
}));
await controller.createCheckpoint('分支一');
context = get(controller.revisionState);
const B = context.revisions.find((revision) => revision.label === '分支一')!;
check('B 的父修订是 A', B.parentId === A.id);
check('B 在新分支上', B.branch === '分支-2');

/* ② Restore A, edit, checkpoint: new descendant on a fresh branch. -------- */
const restored = await controller.restoreRevision(A.id);
check('安全恢复 A 成功', restored);
check('恢复后画布回到 A 的样式', get(editor).project.objects[0]!.fill === legacy.objects[0]!.fill);
check('恢复后对象 ID 与 A 一致', get(editor).project.objects.map((o) => o.id).join() ===
  A.payload.objects.map((o) => o.id).join());
check('恢复可撤销（撤销/重做语义保留）', get(editor).canUndo);
undo();
check('撤销恢复后回到分支一内容', get(editor).project.objects[0]!.fill === '#aa0000');
const redoable = get(editor).canRedo;
check('撤销后可重做', redoable);
await controller.restoreRevision(A.id);

updateProject((project) => ({
  ...project,
  objects: project.objects.map((object, index) =>
    index === 1 ? { ...object, stroke: '#00aa00', opacity: 0.5 } : object
  )
}));
await controller.createCheckpoint('分支二');
context = get(controller.revisionState);
const C = context.revisions.find((revision) => revision.label === '分支二')!;
check('C 的父修订是 A（恢复后形成新后代）', C.parentId === A.id);
check('C 在又一个新分支上', !['主分支', B.branch].includes(C.branch), C.branch);
const bRecord = validateRevision(await db.getRevisionRecord(B.id));
check('B 在库中未被篡改', bRecord.payload.objects[0]!.fill === '#aa0000' &&
  bRecord.payload.objects[1]!.stroke === legacy.objects[1]!.stroke);
const aRecord = validateRevision(await db.getRevisionRecord(A.id));
check('A 在库中未被篡改', JSON.stringify(aRecord.payload.objects) === JSON.stringify(legacy.objects));

/* Immutability: duplicate id must be rejected. ----------------------------- */
let overwriteRejected = false;
try {
  await db.putRevision({ ...A, label: '篡改' });
} catch {
  overwriteRejected = true;
}
check('相同 id 的修订写入被拒绝（不可变）', overwriteRejected);
check('被拒后原修订内容不变', (validateRevision(await db.getRevisionRecord(A.id))).label === '检查点 A');

/* ③ Autosave generation guard + persistence across reopen. ---------------- */
await controller.saveWorkingCopyNow();
const savedCopy = await db.getWorkingCopy(legacy.id);
check('工作副本已携带世代保存', (savedCopy as { generation: number }).generation === get(editor).generation);
check('工作副本分支与上下文一致', (savedCopy as { branch: string }).branch === get(controller.revisionState).branch);

// Simulate a page reload: reopen the project from disk and compare context.
await controller.openProject(legacy.id);
context = get(controller.revisionState);
check('重开后当前分支一致', context.branch === (savedCopy as { branch: string }).branch);
check('重开后基点修订一致', context.baseRevisionId === C.id);
check('重开后修订总数一致（A/B/C + 迁移根）', context.revisions.length === 4);
check('重开后父子关系保留', context.revisions.find((r) => r.id === B.id)?.parentId === A.id &&
  context.revisions.find((r) => r.id === C.id)?.parentId === A.id);
check('重开后画布内容等于工作副本', JSON.stringify(get(editor).project.objects) ===
  JSON.stringify((savedCopy as { payload: { objects: unknown } }).payload.objects));
check('打开工程会提升世代（旧防抖计时器失效）', get(editor).generation > generationBefore);

/* ④ Corrupted / unsupported revisions fail explicitly. -------------------- */
const canvasBefore = JSON.stringify(get(editor).project);
const corruptId = 'rev_corrupt';
await db.putRevision({ ...A, id: corruptId, payload: { ...A.payload, objects: undefined } });
const unsupportedId = 'rev_future';
await db.putRevision({ ...A, id: unsupportedId, format: 99 });
await controller.refreshRevisions();
context = get(controller.revisionState);
check('损坏修订被列入损坏清单', context.corrupt.some((item) => item.id === corruptId));
check('不支持格式被列入损坏清单', context.corrupt.some((item) => item.id === unsupportedId));
check('损坏记录不影响有效修订加载', context.revisions.length === 4);

const okCorrupt = await controller.restoreRevision(corruptId);
check('恢复损坏修订明确失败', !okCorrupt);
check('错误信息说明损坏', /损坏/.test(get(controller.revisionState).error ?? ''));
const okFuture = await controller.restoreRevision(unsupportedId);
check('恢复不支持格式明确失败', !okFuture);
check('错误信息说明格式版本', /不支持的修订格式版本/.test(get(controller.revisionState).error ?? ''));
check('失败后画布未被替换', JSON.stringify(get(editor).project) === canvasBefore);
check('失败后既有检查点仍在', get(controller.revisionState).revisions.length === 4);
const foreignId = 'rev_foreign';
await db.putRevision({ ...A, id: foreignId, projectId: 'project_other' });
check('跨工程修订被拒绝恢复', !(await controller.restoreRevision(foreignId)));

/* Switching projects invalidates stale saves. ------------------------------ */
const other = glideSample();
await db.putProjectMeta({
  id: other.id,
  name: other.name,
  updatedAt: Date.now(),
  headRevisionId: null,
  currentBranch: '主分支',
  schemaVersion: 2
});
await db.putWorkingCopy({
  projectId: other.id,
  baseRevisionId: null,
  branch: '主分支',
  generation: 0,
  payload: {
    name: other.name,
    group: other.group,
    cellWidth: other.cellWidth,
    cellHeight: other.cellHeight,
    objects: other.objects
  },
  updatedAt: Date.now()
});
const staleContext = { projectId: legacy.id, generation: get(editor).generation };
await controller.openProject(other.id);
const { isStaleSave } = await import('../src/lib/revisions.ts');
check(
  '加载其他工程后旧计时器被判过期',
  isStaleSave(staleContext, { projectId: other.id, generation: get(editor).generation })
);
check('切换后画布是新工程', get(editor).project.id === other.id);

/* Cascade delete. ----------------------------------------------------------- */
await controller.removeProject(other.id);
check('删除后工程元数据消失', (await db.getProjectRecord(other.id)) === undefined);
check('删除后工作副本消失', (await db.getWorkingCopy(other.id)) === undefined);

if (failures > 0) {
  console.error(`\n${failures} 项集成检查失败`);
  process.exit(1);
}
console.log('\n全部 IndexedDB 集成检查通过');
