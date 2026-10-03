import { get, writable } from 'svelte/store';
import type { Project, ProjectMeta, Revision, WorkingCopy } from '../types';
import { adoptProject, editor, markSaved, setProject } from './stores';
import {
  deleteProjectCascade,
  getProjectMeta,
  getRevision,
  getWorkingCopy,
  listProjects,
  listRevisions,
  saveProjectMeta,
  saveRevision,
  saveWorkingCopy
} from './db';
import {
  INITIAL_BRANCH,
  RevisionError,
  nextBranchName,
  payloadFromProject,
  planCheckpoint,
  planRestore,
  projectFromPayload,
  validateRevision,
  validateWorkingCopy
} from './revisions';
import { defaultProject } from './samples';

export interface WorkspaceState {
  ready: boolean;
  projectId: string | null;
  branch: string;
  baseRevisionId: string | null;
  generation: number;
  revisions: Revision[];
  error: string | null;
}

export const workspace = writable<WorkspaceState>({
  ready: false,
  projectId: null,
  branch: INITIAL_BRANCH,
  baseRevisionId: null,
  generation: 0,
  revisions: [],
  error: null
});

/**
 * Monotonic working-copy generation. Every context switch (open project, new
 * project, checkpoint, restore, delete-current) bumps it, which immediately
 * invalidates every debounce ticket captured earlier.
 */
let generation = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastProjectRef: Project | null = null;
let subscribed = false;

interface SaveTicket {
  projectId: string;
  generation: number;
}

/**
 * All workspace writes go through this queue. A stale debounced save re-checks
 * its ticket inside the serialized section, so a late timer can never write
 * back into a context that has already been switched.
 */
let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function currentTicket(): SaveTicket {
  return { projectId: get(workspace).projectId ?? '', generation };
}

function isCurrent(ticket: SaveTicket): boolean {
  const state = get(workspace);
  return state.projectId !== null && ticket.projectId === state.projectId && ticket.generation === generation;
}

function contextSwitch(): number {
  generation += 1;
  return generation;
}

function setError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  workspace.update((state) => ({ ...state, error: message }));
}

export function clearWorkspaceError() {
  workspace.update((state) => ({ ...state, error: null }));
}

async function flushSave(ticket: SaveTicket): Promise<void> {
  if (!isCurrent(ticket)) return;
  const project = get(editor).project;
  const payload = payloadFromProject(project);
  const name = project.name;
  const now = Date.now();
  try {
    await enqueueWrite(async () => {
      if (!isCurrent(ticket)) return;
      const state = get(workspace);
      await saveWorkingCopy({
        projectId: ticket.projectId,
        branch: state.branch,
        baseRevisionId: state.baseRevisionId,
        generation: ticket.generation,
        payload,
        updatedAt: now
      });
      const meta = await getProjectMeta(ticket.projectId);
      if (meta) await saveProjectMeta({ ...meta, name, updatedAt: now });
    });
  } catch (error) {
    setError(error);
    return;
  }
  if (isCurrent(ticket)) markSaved();
}

export function scheduleSave() {
  const state = get(workspace);
  if (!state.ready || !state.projectId) return;
  if (saveTimer) clearTimeout(saveTimer);
  const ticket = currentTicket();
  saveTimer = setTimeout(() => {
    void flushSave(ticket);
  }, 700);
}

export async function saveNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const state = get(workspace);
  if (!state.ready || !state.projectId) return;
  await flushSave(currentTicket());
}

function ensureAutosaveSubscription() {
  if (subscribed) return;
  subscribed = true;
  // Only document changes schedule a save: selection/tool/saved-flag updates
  // keep the same project reference and must not retrigger the debounce.
  editor.subscribe((state) => {
    if (state.project !== lastProjectRef) {
      lastProjectRef = state.project;
      scheduleSave();
    }
  });
}

async function rebuildWorkingCopy(meta: ProjectMeta): Promise<{ workingCopy: WorkingCopy; meta: ProjectMeta } | null> {
  const records = await listRevisions(meta.id);
  const valid: Revision[] = [];
  for (const record of records) {
    try {
      valid.push(validateRevision(record));
    } catch {
      // Skip corrupted revisions when rebuilding; they still fail loudly on restore.
    }
  }
  valid.sort((a, b) => a.createdAt - b.createdAt);
  const head = valid[valid.length - 1];
  if (!head) return null;
  const now = Date.now();
  return {
    workingCopy: {
      projectId: meta.id,
      branch: nextBranchName(meta),
      baseRevisionId: head.id,
      generation: 0,
      payload: structuredClone(head.payload),
      updatedAt: now
    },
    meta: { ...meta, branchCounter: meta.branchCounter + 1, updatedAt: now }
  };
}

export async function openProject(projectId: string): Promise<void> {
  // Flush the outgoing context first: its late content lands in the OLD project,
  // never in the one being opened.
  await saveNow();
  clearWorkspaceError();
  const meta = await getProjectMeta(projectId);
  if (!meta) {
    setError(`工程 ${projectId} 不存在或元数据已损坏；当前画布未被改动`);
    return;
  }
  let working: WorkingCopy | null = null;
  let effectiveMeta = meta;
  try {
    const record = await getWorkingCopy(projectId);
    working = record ? validateWorkingCopy(record) : null;
  } catch {
    working = null;
  }
  if (!working) {
    const rebuilt = await rebuildWorkingCopy(meta);
    if (!rebuilt) {
      setError('工程工作副本缺失或已损坏，且没有可用修订可以恢复；当前画布未被改动');
      return;
    }
    working = rebuilt.workingCopy;
    effectiveMeta = rebuilt.meta;
    try {
      await enqueueWrite(async () => {
        await saveWorkingCopy(working as WorkingCopy);
        await saveProjectMeta(effectiveMeta);
      });
    } catch (error) {
      setError(error);
      return;
    }
  }
  const gen = contextSwitch();
  workspace.set({
    ready: true,
    projectId: meta.id,
    branch: working.branch,
    baseRevisionId: working.baseRevisionId,
    generation: gen,
    revisions: await listRevisions(projectId),
    error: null
  });
  setProject(projectFromPayload(effectiveMeta, working.payload));
  markSaved();
}

export async function startNewProject(project: Project): Promise<void> {
  await saveNow();
  clearWorkspaceError();
  const now = Date.now();
  const meta: ProjectMeta = {
    id: project.id,
    name: project.name,
    createdAt: now,
    updatedAt: now,
    branchCounter: 0
  };
  const payload = payloadFromProject(project);
  const gen = contextSwitch();
  const working: WorkingCopy = {
    projectId: meta.id,
    branch: INITIAL_BRANCH,
    baseRevisionId: null,
    generation: gen,
    payload,
    updatedAt: now
  };
  try {
    await enqueueWrite(async () => {
      await saveProjectMeta(meta);
      await saveWorkingCopy(working);
    });
  } catch (error) {
    setError(error);
    return;
  }
  workspace.set({
    ready: true,
    projectId: meta.id,
    branch: INITIAL_BRANCH,
    baseRevisionId: null,
    generation: gen,
    revisions: [],
    error: null
  });
  setProject(projectFromPayload(meta, payload));
  markSaved();
}

export async function initWorkspace(): Promise<void> {
  ensureAutosaveSubscription();
  try {
    const metas = await listProjects();
    const first = metas[0];
    if (first) {
      await openProject(first.id);
    } else {
      await startNewProject(defaultProject());
    }
  } catch (error) {
    setError(error);
  } finally {
    workspace.update((state) => ({ ...state, ready: true }));
  }
}

/** Freeze the working copy as an immutable revision; further edits continue on a new branch. */
export async function createCheckpoint(label?: string): Promise<void> {
  const state = get(workspace);
  if (!state.projectId) return;
  clearWorkspaceError();
  const meta = await getProjectMeta(state.projectId);
  if (!meta) {
    setError('工程元数据缺失，无法创建检查点');
    return;
  }
  const now = Date.now();
  const trimmed = label?.trim();
  const plan = planCheckpoint({
    projectId: state.projectId,
    branch: state.branch,
    baseRevisionId: state.baseRevisionId,
    payload: payloadFromProject(get(editor).project),
    meta,
    label: trimmed ? trimmed : `检查点 ${state.revisions.length + 1}`,
    now
  });
  const gen = contextSwitch();
  const working: WorkingCopy = { ...plan.workingCopy, generation: gen };
  try {
    await enqueueWrite(async () => {
      await saveRevision(plan.revision);
      await saveProjectMeta(plan.meta);
      await saveWorkingCopy(working);
    });
  } catch (error) {
    setError(error);
    return;
  }
  workspace.update((s) => ({
    ...s,
    branch: working.branch,
    baseRevisionId: plan.revision.id,
    generation: gen,
    revisions: [...s.revisions, plan.revision]
  }));
  markSaved();
}

/**
 * Restore an old checkpoint as a new descendant on a fresh branch. Validation
 * happens before any write, so corrupted or unsupported revisions fail
 * explicitly without touching the canvas or existing checkpoints.
 */
export async function restoreRevision(revisionId: string): Promise<boolean> {
  const state = get(workspace);
  if (!state.projectId) return false;
  clearWorkspaceError();
  let revision: Revision;
  try {
    const record = await getRevision(revisionId);
    if (!record) throw new RevisionError(`修订 ${revisionId} 不存在`);
    revision = validateRevision(record);
    if (revision.projectId !== state.projectId) {
      throw new RevisionError('该修订不属于当前工程，已拒绝恢复');
    }
  } catch (error) {
    setError(error);
    return false;
  }
  const meta = await getProjectMeta(state.projectId);
  if (!meta) {
    setError('工程元数据缺失，无法恢复');
    return false;
  }
  const plan = planRestore({ revision, meta, now: Date.now() });
  const gen = contextSwitch();
  const working: WorkingCopy = { ...plan.workingCopy, generation: gen };
  try {
    await enqueueWrite(async () => {
      await saveProjectMeta(plan.meta);
      await saveWorkingCopy(working);
    });
  } catch (error) {
    setError(error);
    return false;
  }
  workspace.update((s) => ({ ...s, branch: working.branch, baseRevisionId: revision.id, generation: gen }));
  adoptProject(projectFromPayload(plan.meta, revision.payload));
  markSaved();
  return true;
}

export async function removeProject(projectId: string): Promise<void> {
  clearWorkspaceError();
  try {
    await deleteProjectCascade(projectId);
  } catch (error) {
    setError(error);
    return;
  }
  if (get(workspace).projectId === projectId) {
    // The open project was deleted: switch context so pending debounced saves
    // carrying the deleted id are invalidated, then rebind to another project.
    contextSwitch();
    workspace.update((s) => ({ ...s, projectId: null, revisions: [] }));
    await initWorkspace();
  }
}
