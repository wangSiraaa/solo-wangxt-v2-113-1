import type { ProjectMeta, Revision, WorkingCopy } from '../types';
import { isLegacyProjectRecord, migrateLegacyProject } from './revisions';

const DB_NAME = 'wallpaper-symmetry-editor';
const DB_VERSION = 2;
const PROJECTS = 'projects';
const REVISIONS = 'revisions';
const WORKING_COPIES = 'workingCopies';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) return;
      const oldVersion = event.oldVersion;
      if (oldVersion < 1 && !db.objectStoreNames.contains(PROJECTS)) {
        db.createObjectStore(PROJECTS, { keyPath: 'id' });
      }
      if (oldVersion < 2) {
        const revisionStore = db.objectStoreNames.contains(REVISIONS)
          ? tx.objectStore(REVISIONS)
          : db.createObjectStore(REVISIONS, { keyPath: 'id' });
        if (!revisionStore.indexNames.contains('projectId')) {
          revisionStore.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains(WORKING_COPIES)) {
          db.createObjectStore(WORKING_COPIES, { keyPath: 'projectId' });
        }
        // Losslessly migrate every legacy v1 project into an openable initial
        // revision + working copy + v2 metadata record.
        const projectStore = tx.objectStore(PROJECTS);
        projectStore.getAll().onsuccess = (load) => {
          const legacyRecords = (load.target as IDBRequest<unknown[]>).result ?? [];
          for (const record of legacyRecords) {
            if (!isLegacyProjectRecord(record)) continue;
            try {
              const { meta, revision, workingCopy } = migrateLegacyProject(record);
              projectStore.put(meta);
              revisionStore.put(revision);
              tx.objectStore(WORKING_COPIES).put(workingCopy);
            } catch (error) {
              // A record that cannot be migrated is left untouched so nothing
              // is silently lost; it simply will not open until fixed.
              console.error('迁移旧版工程失败，已保留原记录', record?.id, error);
            }
          }
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'));
  });
}

async function withStore<T>(store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(store, mode);
    return await requestToPromise(run(tx.objectStore(store)));
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* Project metadata (v2 records)                                       */
/* ------------------------------------------------------------------ */

/** Raw project-store record; may be a v2 meta or an unmigrated legacy project. */
export async function getProjectRecord(id: string): Promise<unknown> {
  return withStore(PROJECTS, 'readonly', (store) => store.get(id));
}

export async function listProjectMetas(): Promise<ProjectMeta[]> {
  const records = await withStore(PROJECTS, 'readonly', (store) => store.getAll());
  return records
    .filter((record): record is ProjectMeta => Boolean(record) && (record as ProjectMeta).schemaVersion === 2)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putProjectMeta(meta: ProjectMeta): Promise<void> {
  await withStore(PROJECTS, 'readwrite', (store) => store.put(meta));
}

/* ------------------------------------------------------------------ */
/* Immutable revisions                                                 */
/* ------------------------------------------------------------------ */

/** Add a new immutable revision. Uses `add` so an existing id can never be overwritten. */
export async function putRevision(revision: Revision): Promise<void> {
  await withStore(REVISIONS, 'readwrite', (store) => store.add(revision));
}

/** Raw record by id; callers validate before use. */
export async function getRevisionRecord(id: string): Promise<unknown> {
  return withStore(REVISIONS, 'readonly', (store) => store.get(id));
}

/** Raw records of one project; callers validate before use. */
export async function listRevisionRecords(projectId: string): Promise<unknown[]> {
  return withStore(REVISIONS, 'readonly', (store) => store.index('projectId').getAll(projectId));
}

/* ------------------------------------------------------------------ */
/* Working copies                                                      */
/* ------------------------------------------------------------------ */

export async function getWorkingCopy(projectId: string): Promise<unknown> {
  return withStore(WORKING_COPIES, 'readonly', (store) => store.get(projectId));
}

export async function putWorkingCopy(workingCopy: WorkingCopy): Promise<void> {
  await withStore(WORKING_COPIES, 'readwrite', (store) => store.put(workingCopy));
}

/* ------------------------------------------------------------------ */
/* Cascade delete                                                      */
/* ------------------------------------------------------------------ */

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([PROJECTS, REVISIONS, WORKING_COPIES], 'readwrite');
    tx.objectStore(PROJECTS).delete(id);
    tx.objectStore(WORKING_COPIES).delete(id);
    const index = tx.objectStore(REVISIONS).index('projectId');
    const request = index.getAllKeys(id);
    await requestToPromise(request);
    for (const key of request.result) {
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
