import { IDBFactory } from 'fake-indexeddb';
import { p6mSample } from '../src/lib/samples.ts';
import type { ProjectMeta, Revision, WorkingCopy } from '../src/types.ts';

// Fresh factory per process run; db.ts opens by fixed name/version.
(globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();

const {
  deleteProjectCascade,
  getProjectMeta,
  getRevision,
  getWorkingCopy,
  listProjects,
  listRevisions,
  saveProjectMeta,
  saveRevision,
  saveWorkingCopy
} = await import('../src/lib/db.ts');
const { validateRevision, validateWorkingCopy } = await import('../src/lib/revisions.ts');

let failures = 0;
function check(name: string, condition: boolean) {
  if (condition) console.log(`✓ ${name}`);
  else {
    failures += 1;
    console.error(`✗ ${name}`);
  }
}

const DB_NAME = 'wallpaper-symmetry-editor';

/** Seed a v1 database exactly like the old build did: one `projects` store of full documents. */
function seedV1(records: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readwrite');
      for (const record of records) tx.objectStore('projects').put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error('seed failed'));
    };
    request.onerror = () => reject(request.error ?? new Error('seed open failed'));
  });
}

const sample = p6mSample();
const legacyProject = {
  id: 'legacy-project-1',
  name: '旧版工程',
  group: sample.group,
  cellWidth: sample.cellWidth,
  cellHeight: sample.cellHeight,
  objects: structuredClone(sample.objects),
  updatedAt: 12345
};
const corruptLegacy = { id: 'legacy-corrupt', name: '损坏记录', group: 'not-a-group', objects: 42 };

await seedV1([legacyProject, corruptLegacy]);

// ---------- 迁移 ----------
const metas = await listProjects();
check('迁移后工程列表只含有效元数据', metas.length === 1 && metas[0]!.id === 'legacy-project-1');
check('迁移保留工程名称', metas[0]!.name === '旧版工程');

const revisions = await listRevisions('legacy-project-1');
check('迁移生成一个初始修订', revisions.length === 1);
const initial = revisions[0]!;
check('初始修订是 main 分支的根', initial.parentId === null && initial.branch === 'main');
check('初始修订通过格式校验', (() => {
  try {
    validateRevision(initial);
    return true;
  } catch {
    return false;
  }
})());
check(
  '迁移载荷无损（群/晶格/全部对象 ID/路径/样式）',
  initial.payload.group === legacyProject.group &&
    initial.payload.cellWidth === legacyProject.cellWidth &&
    initial.payload.cellHeight === legacyProject.cellHeight &&
    JSON.stringify(initial.payload.objects) === JSON.stringify(legacyProject.objects)
);

const working = await getWorkingCopy('legacy-project-1');
check('迁移生成可打开的工作副本', working !== undefined && working.baseRevisionId === initial.id);
check('工作副本在新分支上且载荷等于初始修订', working !== undefined && working.branch === '分支-1' && JSON.stringify(working.payload) === JSON.stringify(initial.payload));
check('工作副本通过校验', (() => {
  try {
    validateWorkingCopy(working);
    return true;
  } catch {
    return false;
  }
})());

// ---------- 修订不可变 ----------
let immutableRejected = false;
try {
  await saveRevision({ ...initial, label: '篡改' });
} catch {
  immutableRejected = true;
}
check('相同 ID 的修订写入被拒绝（不可变）', immutableRejected);
const after = await getRevision(initial.id);
check('原修订内容未被篡改', after?.label === initial.label && JSON.stringify(after.payload) === JSON.stringify(initial.payload));

// ---------- 工作副本与元数据读写 ----------
const updatedWorking: WorkingCopy = { ...working!, generation: 7, updatedAt: 99999 };
await saveWorkingCopy(updatedWorking);
const reread = await getWorkingCopy('legacy-project-1');
check('工作副本更新后可读回（世代 7）', reread?.generation === 7 && reread.updatedAt === 99999);

const meta = (await getProjectMeta('legacy-project-1')) as ProjectMeta;
await saveProjectMeta({ ...meta, name: '改名后的工程', branchCounter: 3 });
check('元数据改名与分支计数器持久化', (await getProjectMeta('legacy-project-1'))?.name === '改名后的工程' && (await getProjectMeta('legacy-project-1'))?.branchCounter === 3);

// ---------- 第二个工程的修订链 ----------
const meta2: ProjectMeta = { id: 'p2', name: '第二工程', createdAt: 1, updatedAt: 2, branchCounter: 0 };
await saveProjectMeta(meta2);
const rev1: Revision = {
  id: 'p2-rev-1',
  projectId: 'p2',
  parentId: null,
  branch: 'main',
  label: '根',
  createdAt: 10,
  format: 1,
  payload: structuredClone(initial.payload)
};
const rev2: Revision = { ...rev1, id: 'p2-rev-2', parentId: 'p2-rev-1', branch: '分支-1', createdAt: 20 };
await saveRevision(rev1);
await saveRevision(rev2);
const chain = await listRevisions('p2');
check('修订按创建时间排序且父子关系保留', chain.length === 2 && chain[0]!.id === 'p2-rev-1' && chain[1]!.parentId === 'p2-rev-1');

// ---------- 级联删除 ----------
await deleteProjectCascade('p2');
check('级联删除清空元数据/修订/工作副本', (await getProjectMeta('p2')) === undefined && (await listRevisions('p2')).length === 0 && (await getWorkingCopy('p2')) === undefined);
check('级联删除不影响其他工程', (await getProjectMeta('legacy-project-1')) !== undefined && (await listRevisions('legacy-project-1')).length === 1);

console.log(failures === 0 ? '全部 IndexedDB 迁移/持久化检查通过' : `${failures} 项检查失败`);
process.exit(failures ? 1 : 0);
