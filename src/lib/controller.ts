import { get, writable } from 'svelte/store';
import type { Project, ProjectMeta, Revision, WorkingCopy } from '../types';
import * as db from './db';
import {
  MAIN_BRANCH,
  RevisionError,
  branchNames,
  createRevision,
  freshBranchName,
  isLegacyProjectRecord,
  migrateLegacyProject,
  payloadFromProject,
  projectFromPayload,
  validateRevision,
  validateWorkingCopy
} from './revisions';
import { editor, markSaved, restoreProject, setProject } from './stores';

const LAST_PROJECT_KEY = 'wallpaper:last-project-id';

export interface CorruptRevision {
  id: string;
  reason: string;
}

export interface RevisionState {
  /** Project the revision context belongs to; matches editor.project.id. */
  projectId: string;
  /** Revision the working copy is based on (null before first checkpoint). */
  baseRevisionId: string | null;
  /** Branch line the working copy currently extends. */
  branch: string;
  /** Valid revisions of the current project, newest first. */
  revisions: Revision[];
  /** Records that failed validation; shown but never loaded into the canvas. */
  corrupt: CorruptRevision[];
  /** Last explicit failure (corrupt/unsupported revision, load error). */
  error: string | null;
}

const initialContext: RevisionState = {
  projectId: get(editor).project.id,
  baseRevisionId: null,
  branch: '主分支',
  revisions: [],
  corrupt: [],
  error: null
};

export const revisionState = writable<RevisionState>(initialContext);
export const savedProjects = writable<ProjectMeta[]>([]);

function allBranchNames(state: RevisionState, extra?: Revision): Set<string> {
  const names = new Set(branchNames(state.revisions));
  names.add(state.branch);
  if (extra) names.add(extra.branch);
  return names;
}

export function shortRevisionId(id: string | null): string {
  return id ? `#${id.slice(-6)}` : '（根）';
}

/* ------------------------------------------------------------------ */
/* Loading / refreshing                                                */
/* ------------------------------------------------------------------ */

export async function refreshProjectList(): Promise<void> {
  savedProjects.set(await db.listProjectMetas());
}

async function loadRevisions(projectId: string): Promise<{ revisions: Revision[]; corrupt: CorruptRevision[] }> {
  const records = await db.listRevisionRecords(projectId);
  const revisions: Revision[] = [];
  const corrupt: CorruptRevision[] = [];
  for (const record of records) {
    try {
      revisions.push(validateRevision(record));
    } catch (error) {
      const id =
        typeof record === 'object' && record !== null && typeof (record as { id?: unknown }).id === 'string'
          ? ((record as { id: string }).id as string)
          : '(未知)';
      corrupt.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  revisions.sort((a, b) => b.createdAt - a.createdAt);
  return { revisions, corrupt };
}

export async function refreshRevisions(): Promise<void> {
  const state = get(revisionState);
  const { revisions, corrupt } = await loadRevisions(state.projectId);
  revisionState.update((current) =>
    current.projectId === state.projectId ? { ...current, revisions, corrupt } : current
  );
}

/* ------------------------------------------------------------------ */
/* Persistence of the working copy                                     */
/* ------------------------------------------------------------------ */

/** Persist the current canvas as the working copy + project metadata. */
export async function saveWorkingCopyNow(): Promise<void> {
  const state = get(editor);
  const context = get(revisionState);
  const projectId = state.project.id;
  const payload = payloadFromProject(state.project);
  const sameContext = context.projectId === projectId;
  const existing = await db.getProjectRecord(projectId);
  const existingMeta =
    existing && (existing as ProjectMeta).schemaVersion === 2 ? (existing as ProjectMeta) : null;
  const branch = sameContext ? context.branch : (existingMeta?.currentBranch ?? '主分支');
  const baseRevisionId = sameContext ? context.baseRevisionId : (existingMeta?.headRevisionId ?? null);
  const workingCopy: WorkingCopy = {
    projectId,
    baseRevisionId,
    branch,
    generation: state.generation,
    payload,
    updatedAt: Date.now()
  };
  await db.putWorkingCopy(workingCopy);
  await db.putProjectMeta({
    id: projectId,
    name: payload.name,
    updatedAt: workingCopy.updatedAt,
    headRevisionId: baseRevisionId,
    currentBranch: branch,
    schemaVersion: 2
  });
  localStorage.setItem(LAST_PROJECT_KEY, projectId);
  await refreshProjectList();
}

/* ------------------------------------------------------------------ */
/* Context switches                                                    */
/* ------------------------------------------------------------------ */

function enterContext(projectId: string, workingCopy: WorkingCopy, revisions: Revision[], corrupt: CorruptRevision[]) {
  revisionState.set({
    projectId,
    baseRevisionId: workingCopy.baseRevisionId,
    branch: workingCopy.branch,
    revisions,
    corrupt,
    error: null
  });
}

/**
 * Open a project from IndexedDB. Legacy v1 records that somehow survived
 * (e.g. written by an older build at the same DB version) are migrated on
 * demand. Failures are explicit and leave the current canvas untouched.
 */
export async function openProject(id: string): Promise<boolean> {
  try {
    let record = await db.getProjectRecord(id);
    if (!record) throw new RevisionError(`工程 ${id} 不存在`);
    if (isLegacyProjectRecord(record)) {
      const migrated = migrateLegacyProject(record);
      await db.putProjectMeta(migrated.meta);
      await db.putRevision(migrated.revision);
      await db.putWorkingCopy(migrated.workingCopy);
      record = migrated.meta;
    }
    const meta = record as ProjectMeta;
    if (meta.schemaVersion !== 2) throw new RevisionError('不支持的工程记录格式');
    let workingCopy: WorkingCopy;
    const rawWorkingCopy = await db.getWorkingCopy(id);
    if (rawWorkingCopy) {
      workingCopy = validateWorkingCopy(rawWorkingCopy);
    } else if (meta.headRevisionId) {
      // Reconstruct a missing working copy from the head revision.
      const head = validateRevision(await db.getRevisionRecord(meta.headRevisionId));
      workingCopy = {
        projectId: id,
        baseRevisionId: head.id,
        branch: meta.currentBranch,
        generation: 0,
        payload: structuredClone(head.payload),
        updatedAt: Date.now()
      };
    } else {
      throw new RevisionError('工程缺少工作副本且没有可恢复的修订');
    }
    const { revisions, corrupt } = await loadRevisions(id);
    setProject(projectFromPayload(id, workingCopy.payload));
    enterContext(id, workingCopy, revisions, corrupt);
    localStorage.setItem(LAST_PROJECT_KEY, id);
    return true;
  } catch (error) {
    revisionState.update((state) => ({
      ...state,
      error: `打开工程失败：${error instanceof Error ? error.message : String(error)}`
    }));
    return false;
  }
}

/** Start a fresh, not-yet-persisted context (samples / reset). */
export function startNewProject(project: Project): void {
  setProject(project);
  revisionState.set({
    projectId: project.id,
    baseRevisionId: null,
    branch: '主分支',
    revisions: [],
    corrupt: [],
    error: null
  });
}

/** Reopen the project that was open when the page was last closed. */
export async function bootFromStorage(): Promise<boolean> {
  const lastId = localStorage.getItem(LAST_PROJECT_KEY);
  if (!lastId) return false;
  return openProject(lastId);
}

/* ------------------------------------------------------------------ */
/* Checkpoints and restore                                             */
/* ------------------------------------------------------------------ */

/**
 * Seal the current canvas as an immutable revision on the current branch,
 * then move the working copy onto a fresh branch: continued edits form
 * descendants on a new branch line instead of rewriting the sealed one.
 */
export async function createCheckpoint(label: string): Promise<Revision> {
  const state = get(editor);
  const context = get(revisionState);
  const projectId = state.project.id;
  const payload = payloadFromProject(state.project);
  const revision = createRevision({
    projectId,
    parentId: context.projectId === projectId ? context.baseRevisionId : null,
    branch: context.projectId === projectId ? context.branch : '主分支',
    label,
    payload
  });
  await db.putRevision(revision);
  const nextBranch = freshBranchName(allBranchNames(context, revision));
  const workingCopy: WorkingCopy = {
    projectId,
    baseRevisionId: revision.id,
    branch: nextBranch,
    generation: state.generation,
    payload,
    updatedAt: Date.now()
  };
  await db.putWorkingCopy(workingCopy);
  await db.putProjectMeta({
    id: projectId,
    name: payload.name,
    updatedAt: workingCopy.updatedAt,
    headRevisionId: revision.id,
    currentBranch: nextBranch,
    schemaVersion: 2
  });
  revisionState.update((current) => ({
    ...current,
    baseRevisionId: revision.id,
    branch: nextBranch,
    revisions: [revision, ...current.revisions],
    error: null
  }));
  markSaved();
  await refreshProjectList();
  return revision;
}

/**
 * Safe recovery entry: materialize an old checkpoint as a NEW descendant
 * context. The stored revision is never modified; the working copy moves to a
 * fresh branch so further edits form descendants instead of tampering with
 * history. Corrupted or unsupported revisions fail explicitly and leave the
 * canvas and all checkpoints untouched.
 */
export async function restoreRevision(id: string): Promise<boolean> {
  const context = get(revisionState);
  try {
    const revision = validateRevision(await db.getRevisionRecord(id));
    if (revision.projectId !== context.projectId) {
      throw new RevisionError('该修订不属于当前工程，已拒绝恢复');
    }
    const nextBranch = freshBranchName(allBranchNames(context));
    // Only touch the canvas after every validation step has passed.
    restoreProject(projectFromPayload(context.projectId, revision.payload));
    const state = get(editor);
    const workingCopy: WorkingCopy = {
      projectId: context.projectId,
      baseRevisionId: revision.id,
      branch: nextBranch,
      generation: state.generation,
      payload: structuredClone(revision.payload),
      updatedAt: Date.now()
    };
    await db.putWorkingCopy(workingCopy);
    await db.putProjectMeta({
      id: context.projectId,
      name: revision.payload.name,
      updatedAt: workingCopy.updatedAt,
      headRevisionId: revision.id,
      currentBranch: nextBranch,
      schemaVersion: 2
    });
    revisionState.update((current) => ({
      ...current,
      baseRevisionId: revision.id,
      branch: nextBranch,
      error: null
    }));
    return true;
  } catch (error) {
    revisionState.update((current) => ({
      ...current,
      error: `恢复失败：${error instanceof Error ? error.message : String(error)}`
    }));
    return false;
  }
}

export async function removeProject(id: string): Promise<void> {
  await db.deleteProject(id);
  if (localStorage.getItem(LAST_PROJECT_KEY) === id) localStorage.removeItem(LAST_PROJECT_KEY);
  // Deleting the open project must not leave the context pointing at
  // revisions that no longer exist; the canvas keeps its content and future
  // checkpoints start a fresh graph.
  const context = get(revisionState);
  if (context.projectId === id) {
    revisionState.set({
      projectId: id,
      baseRevisionId: null,
      branch: MAIN_BRANCH,
      revisions: [],
      corrupt: [],
      error: null
    });
  }
  await refreshProjectList();
}

export function clearRevisionError(): void {
  revisionState.update((state) => ({ ...state, error: null }));
}
