import { IDBFactory } from 'fake-indexeddb';

(globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();

const { get, } = await import('svelte/store');
const stores = await import('../src/lib/stores.ts');
const { editor, updateProject, undo, redo } = stores;
const workspaceModule = await import('../src/lib/workspace.ts');
const {
  workspace,
  initWorkspace,
  startNewProject,
  openProject,
  createCheckpoint,
  restoreRevision,
  saveNow,
  scheduleSave
} = workspaceModule;
const { getRevision, getWorkingCopy, listRevisions, saveRevision } = await import('../src/lib/db.ts');
const { payloadFromProject } = await import('../src/lib/revisions.ts');
const { glideSample } = await import('../src/lib/samples.ts');
const { uid } = await import('../src/lib/path.ts');

let failures = 0;
function check(name: string, condition: boolean) {
  if (condition) console.log(`✓ ${name}`);
  else {
    failures += 1;
    console.error(`✗ ${name}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ws = () => get(workspace);
const doc = () => get(editor).project;
const docJson = () => JSON.stringify(payloadFromProject(doc()));

function editFirstObject(mutate: (object: { fill: string; strokeWidth: number; path: unknown[] }) => void) {
  updateProject((project) => ({
    ...project,
    objects: project.objects.map((object, index) => {
      if (index !== 0) return object;
      const next = structuredClone(object);
      mutate(next);
      return next;
    })
  }));
}

// ---------- 初始化：空库 → 自动创建工程 P1 ----------
await initWorkspace();
const p1 = ws().projectId as string;
check('初始化后打开默认工程', ws().ready && typeof p1 === 'string' && ws().branch === 'main');

// ---------- 切换工程前冲刷旧上下文 ----------
editFirstObject((object) => {
  object.fill = '#0f0f0f';
});
scheduleSave(); // 旧计时器挂起中
const p2project = glideSample();
await startNewProject(p2project); // 切换前应先冲刷 P1
const p2 = p2project.id;
await sleep(800);
const p1Working = await getWorkingCopy(p1);
check('切换工程后旧计时器不会写回新上下文', ws().projectId === p2 && JSON.stringify((await getWorkingCopy(p2))?.payload.objects) !== JSON.stringify(p1Working?.payload.objects));
check('P1 的编辑已冲刷到 P1 自己的工作副本', p1Working?.payload.objects[0]?.fill === '#0f0f0f');

await openProject(p1);
check('重新打开 P1 恢复其工作副本', doc().objects[0]?.fill === '#0f0f0f' && ws().projectId === p1);

// ---------- 验收①：检查点 A 分出两套路径与样式修改 ----------
editFirstObject((object) => {
  object.fill = '#aaaaaa';
});
await createCheckpoint('A');
const revisions1 = await listRevisions(p1);
const revA = revisions1.find((revision) => revision.label === 'A');
check('检查点 A 是 main 分支的根修订', !!revA && revA.parentId === null && revA.branch === 'main');
check('创建检查点后工作副本切到新分支', ws().branch === '分支-1' && ws().baseRevisionId === revA!.id);

editFirstObject((object) => {
  object.fill = '#111111';
  object.strokeWidth = 7;
  object.path = [...object.path.slice(0, 1), { type: 'L', x: 5, y: 5 }, { type: 'Z' }];
});
await createCheckpoint('B1');
const revB1 = (await listRevisions(p1)).find((revision) => revision.label === 'B1');
check('B1 是 A 在新分支上的后代', !!revB1 && revB1.parentId === revA!.id && revB1.branch === '分支-1');

// 恢复 A → 撤销/重做语义保留（验收②的前半）
const preRestoreJson = docJson();
const okRestore = await restoreRevision(revA!.id);
check('恢复 A 成功', okRestore && docJson() === JSON.stringify(revA!.payload));
check('恢复后工作副本在另一个新分支上', ws().branch === '分支-3' && ws().baseRevisionId === revA!.id);
undo();
check('恢复可被撤销（回到恢复前内容）', docJson() === preRestoreJson);
redo();
check('重做回到恢复后的 A 内容', docJson() === JSON.stringify(revA!.payload));

// 恢复 A 后编辑 → 新后代（验收②）
editFirstObject((object) => {
  object.fill = '#222222';
  object.path = [...object.path.slice(0, 1), { type: 'L', x: 99, y: 99 }, { type: 'Z' }];
});
await createCheckpoint('B2');
const revB2 = (await listRevisions(p1)).find((revision) => revision.label === 'B2');
check('B2 是 A 的另一个后代分支', !!revB2 && revB2.parentId === revA!.id && revB2.branch === '分支-3');

const rereadA = (await getRevision(revA!.id))!;
check('A 未被篡改（不可变）', JSON.stringify(rereadA) === JSON.stringify(revA));
check('A、B1、B2 载荷互不影响', (() => {
  const fills = [rereadA, revB1!, revB2!].map((revision) => revision.payload.objects[0]!.fill);
  return fills[0] === '#aaaaaa' && fills[1] === '#111111' && fills[2] === '#222222' &&
    new Set([rereadA.branch, revB1!.branch, revB2!.branch]).size === 3;
})());
check('三个修订的对象 ID 集合一致', (() => {
  const ids = (revision: typeof rereadA) => revision.payload.objects.map((object) => object.id).sort().join(',');
  return ids(rereadA) === ids(revB1!) && ids(revB1!) === ids(revB2!);
})());

// 切换分支互不影响
await restoreRevision(revB1!.id);
check('切到 B1 后画布是 B1 内容', doc().objects[0]?.fill === '#111111');
await restoreRevision(revA!.id);
check('切回 A 后画布是 A 内容', doc().objects[0]?.fill === '#aaaaaa' && doc().objects[0]?.strokeWidth !== 7);

// ---------- 防抖世代：恢复后旧计时器不得写回 ----------
editFirstObject((object) => {
  object.fill = '#deadbe'; // 未固化的修改
});
scheduleSave();
await restoreRevision(revB1!.id); // 立即切换修订，使上一个计时器过期
await sleep(800);
const workingAfterRestore = await getWorkingCopy(p1);
check('切换修订后旧计时器的迟到内容被丢弃', JSON.stringify(workingAfterRestore?.payload) === JSON.stringify(revB1!.payload));
check('画布与当前修订一致', docJson() === JSON.stringify(revB1!.payload));

// ---------- 验收④：损坏/不支持的修订明确失败 ----------
const corruptId = uid('rev');
await saveRevision({
  id: corruptId,
  projectId: p1,
  parentId: null,
  branch: 'main',
  label: '来自未来的修订',
  createdAt: Date.now(),
  format: 99,
  payload: structuredClone(revA!.payload)
});
const beforeFail = docJson();
const revisionCountBefore = (await listRevisions(p1)).length;
const failed = await restoreRevision(corruptId);
check('不支持的修订格式恢复失败', !failed && (ws().error ?? '').includes('不支持的修订格式'));
check('失败后画布未被替换', docJson() === beforeFail);
check('失败后既有检查点不受影响', (await listRevisions(p1)).length === revisionCountBefore && JSON.stringify(await getRevision(revA!.id)) === JSON.stringify(revA));

const foreignFail = await restoreRevision(revB1!.id.replace(/.$/, 'x'));
check('不存在的修订恢复失败且不触碰画布', !foreignFail && docJson() === beforeFail && typeof ws().error === 'string');

// ---------- 验收③：刷新重开后状态一致 ----------
await saveNow();
const branchBeforeReload = ws().branch;
const baseBeforeReload = ws().baseRevisionId;
const docBeforeReload = docJson();
await initWorkspace(); // 模拟刷新：从 IndexedDB 重建上下文
check('重开后仍是同一工程同一分支', ws().projectId === p1 && ws().branch === branchBeforeReload);
check('重开后基修订（父子关系）一致', ws().baseRevisionId === baseBeforeReload);
check('重开后画布内容等于自动保存的工作副本', docJson() === docBeforeReload && docJson() === JSON.stringify((await getWorkingCopy(p1))?.payload));
const chain = await listRevisions(p1);
check('重开后修订父子关系完整', (() => {
  const byId = new Map(chain.map((revision) => [revision.id, revision]));
  const b1 = byId.get(revB1!.id);
  const b2 = byId.get(revB2!.id);
  return chain.length >= 4 && b1?.parentId === revA!.id && b2?.parentId === revA!.id && byId.get(revA!.id)?.parentId === null;
})());

editFirstObject((object) => {
  object.strokeWidth = 3.5;
});
await saveNow();
check('重开后自动保存仍写入当前工作副本世代', (await getWorkingCopy(p1))?.payload.objects[0]?.strokeWidth === 3.5);

console.log(failures === 0 ? '全部工作区端到端检查通过' : `${failures} 项检查失败`);
process.exit(failures ? 1 : 0);
