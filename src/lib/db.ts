import type { ProjectMeta, Revision, WorkingCopy } from '../types';
import { planLegacyMigration } from './revisions';

const DB_NAME = 'wallpaper-symmetry-editor';
const DB_VERSION = 2;
const PROJECTS = 'projects';
const REVISIONS = 'revisions';
const WORKING = 'workingCopies';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) return;
      if (!db.objectStoreNames.contains(PROJECTS)) {
        db.createObjectStore(PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(REVISIONS)) {
        const store = db.createObjectStore(REVISIONS, { keyPath: 'id' });
        store.createIndex('byProject', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains(WORKING)) {
        db.createObjectStore(WORKING, { keyPath: 'projectId' });
      }
      if (event.oldVersion >= 1 && event.oldVersion < 2) {
        migrateLegacyProjects(tx);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'));
  });
}

/**
 * v1 stored full project documents in `projects`. Rewrite each valid one as
 * meta + initial revision + working copy inside the upgrade transaction, so
 * existing projects stay openable. Invalid records are left untouched.
 */
function migrateLegacyProjects(tx: IDBTransaction) {
  const projects = tx.objectStore(PROJECTS);
  const revisions = tx.objectStore(REVISIONS);
  const working = tx.objectStore(WORKING);
  const now = Date.now();
  const cursorRequest = projects.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const plan = planLegacyMigration(cursor.value, now);
    if (plan) {
      cursor.update(plan.meta);
      revisions.add(plan.revision);
      working.add(plan.workingCopy);
    }
    cursor.continue();
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'));
  });
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(storeName, mode);
    return await requestToPromise(run(tx.objectStore(storeName)));
  } finally {
    db.close();
  }
}

function isProjectMeta(record: unknown): record is ProjectMeta {
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof (record as ProjectMeta).id === 'string' &&
    typeof (record as ProjectMeta).name === 'string' &&
    typeof (record as ProjectMeta).branchCounter === 'number'
  );
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const records = await withStore(PROJECTS, 'readonly', (store) => store.getAll());
  return records.filter(isProjectMeta).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProjectMeta(id: string): Promise<ProjectMeta | undefined> {
  const record = await withStore(PROJECTS, 'readonly', (store) => store.get(id));
  return isProjectMeta(record) ? record : undefined;
}

export async function saveProjectMeta(meta: ProjectMeta): Promise<void> {
  await withStore(PROJECTS, 'readwrite', (store) => store.put(meta));
}

/** Immutable write: revisions are added once and never overwritten. */
export async function saveRevision(revision: Revision): Promise<void> {
  try {
    await withStore(REVISIONS, 'readwrite', (store) => store.add(revision));
  } catch (error) {
    throw new Error(`修订 ${revision.id} 已存在，不可变修订不能被覆盖`, { cause: error });
  }
}

export async function getRevision(id: string): Promise<Revision | undefined> {
  return withStore(REVISIONS, 'readonly', (store) => store.get(id));
}

export async function listRevisions(projectId: string): Promise<Revision[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(REVISIONS, 'readonly');
    const index = tx.objectStore(REVISIONS).index('byProject');
    const records = await requestToPromise(index.getAll(projectId));
    return records.sort((a, b) => a.createdAt - b.createdAt);
  } finally {
    db.close();
  }
}

export async function getWorkingCopy(projectId: string): Promise<WorkingCopy | undefined> {
  return withStore(WORKING, 'readonly', (store) => store.get(projectId));
}

export async function saveWorkingCopy(workingCopy: WorkingCopy): Promise<void> {
  await withStore(WORKING, 'readwrite', (store) => store.put(workingCopy));
}

export async function deleteProjectCascade(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([PROJECTS, REVISIONS, WORKING], 'readwrite');
    tx.objectStore(PROJECTS).delete(id);
    tx.objectStore(WORKING).delete(id);
    const index = tx.objectStore(REVISIONS).index('byProject');
    const keys = await requestToPromise(index.getAllKeys(id));
    for (const key of keys) {
      tx.objectStore(REVISIONS).delete(key);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('删除工程失败'));
      tx.onabort = () => reject(tx.error ?? new Error('删除工程被中止'));
    });
  } finally {
    db.close();
  }
}
