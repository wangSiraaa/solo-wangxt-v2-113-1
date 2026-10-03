import type {
  GroupId,
  ObjectDiff,
  PatternObject,
  Project,
  ProjectMeta,
  Revision,
  RevisionDiff,
  RevisionPayload,
  WorkingCopy
} from '../types';
import { GROUP_SPECS } from './groups';
import { uid } from './path';

/** Current on-disk revision payload format. Anything else fails explicitly. */
export const REVISION_FORMAT = 1;

export const MAIN_BRANCH = '主分支';

/** Error raised for corrupted revisions or unsupported revision formats. */
export class RevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionError';
  }
}

/* ------------------------------------------------------------------ */
/* Payload <-> Project                                                 */
/* ------------------------------------------------------------------ */

export function payloadFromProject(project: Project): RevisionPayload {
  return structuredClone({
    name: project.name,
    group: project.group,
    cellWidth: project.cellWidth,
    cellHeight: project.cellHeight,
    objects: project.objects
  });
}

export function projectFromPayload(projectId: string, payload: RevisionPayload): Project {
  return {
    id: projectId,
    name: payload.name,
    group: payload.group,
    cellWidth: payload.cellWidth,
    cellHeight: payload.cellHeight,
    objects: structuredClone(payload.objects),
    updatedAt: Date.now()
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fail(reason: string): never {
  throw new RevisionError(`修订记录损坏：${reason}`);
}

function validatePath(path: unknown, objectId: string): void {
  if (!Array.isArray(path)) fail(`对象 ${objectId} 缺少路径数组`);
  for (const segment of path) {
    if (!isRecord(segment) || typeof segment.type !== 'string') {
      fail(`对象 ${objectId} 含非法路径段`);
    }
    const numbers: Record<string, unknown> = segment;
    const need = (fields: string[]) => {
      for (const field of fields) {
        if (!isFiniteNumber(numbers[field])) {
          fail(`对象 ${objectId} 的路径段 ${segment.type} 缺少数值字段 ${field}`);
        }
      }
    };
    if (segment.type === 'M' || segment.type === 'L') need(['x', 'y']);
    else if (segment.type === 'Q') need(['cx', 'cy', 'x', 'y']);
    else if (segment.type === 'C') need(['cx1', 'cy1', 'cx2', 'cy2', 'x', 'y']);
    else if (segment.type !== 'Z') fail(`对象 ${objectId} 含未知路径段类型 ${String(segment.type)}`);
  }
}

function validateObject(value: unknown): PatternObject {
  if (!isRecord(value)) fail('对象条目不是记录');
  if (typeof value.id !== 'string' || value.id.length === 0) fail('对象缺少 id');
  if (typeof value.name !== 'string') fail(`对象 ${value.id} 缺少名称`);
  validatePath(value.path, value.id);
  if (typeof value.fill !== 'string') fail(`对象 ${value.id} 缺少填充样式`);
  if (typeof value.stroke !== 'string') fail(`对象 ${value.id} 缺少描边样式`);
  if (!isFiniteNumber(value.strokeWidth) || value.strokeWidth < 0) {
    fail(`对象 ${value.id} 线宽非法`);
  }
  if (!isFiniteNumber(value.opacity) || value.opacity < 0 || value.opacity > 1) {
    fail(`对象 ${value.id} 不透明度非法`);
  }
  return value as unknown as PatternObject;
}

export function validatePayload(value: unknown): RevisionPayload {
  if (!isRecord(value)) fail('缺少载荷');
  if (typeof value.name !== 'string') fail('缺少工程名称');
  if (typeof value.group !== 'string' || !(value.group in GROUP_SPECS)) {
    fail(`未知墙纸群 ${String(value.group)}`);
  }
  if (!isFiniteNumber(value.cellWidth) || value.cellWidth <= 0) fail('晶格宽度非法');
  if (!isFiniteNumber(value.cellHeight) || value.cellHeight <= 0) fail('晶格高度非法');
  if (!Array.isArray(value.objects)) fail('缺少对象数组');
  const ids = new Set<string>();
  for (const item of value.objects) {
    const object = validateObject(item);
    if (ids.has(object.id)) fail(`对象 id 重复：${object.id}`);
    ids.add(object.id);
  }
  return value as unknown as RevisionPayload;
}

/**
 * Validate a raw record as an immutable revision. Corrupted records and
 * unsupported format versions raise RevisionError; callers must treat that as
 * an explicit failure and leave the canvas and existing checkpoints untouched.
 */
export function validateRevision(value: unknown): Revision {
  if (!isRecord(value)) fail('记录不是对象');
  if (typeof value.id !== 'string' || value.id.length === 0) fail('缺少修订 id');
  if (typeof value.projectId !== 'string' || value.projectId.length === 0) {
    fail(`修订 ${value.id} 缺少所属工程`);
  }
  if (value.parentId !== null && typeof value.parentId !== 'string') {
    fail(`修订 ${value.id} 的父修订字段非法`);
  }
  if (typeof value.branch !== 'string' || value.branch.length === 0) {
    fail(`修订 ${value.id} 缺少分支名称`);
  }
  if (!isFiniteNumber(value.createdAt)) fail(`修订 ${value.id} 缺少创建时间`);
  if (!isFiniteNumber(value.format)) {
    fail(`修订 ${value.id} 缺少格式版本`);
  }
  if (value.format !== REVISION_FORMAT) {
    throw new RevisionError(
      `不支持的修订格式版本：${String(value.format)}（当前支持 ${REVISION_FORMAT}），修订 ${value.id} 无法打开`
    );
  }
  const payload = validatePayload(value.payload);
  return {
    id: value.id,
    projectId: value.projectId,
    parentId: value.parentId,
    branch: value.branch,
    label: typeof value.label === 'string' && value.label.length > 0 ? value.label : '未命名检查点',
    createdAt: value.createdAt,
    format: value.format,
    payload
  };
}

/** Validate a stored working copy; corrupt copies fail explicitly like revisions. */
export function validateWorkingCopy(value: unknown): WorkingCopy {
  if (!isRecord(value)) fail('工作副本不是记录');
  if (typeof value.projectId !== 'string' || value.projectId.length === 0) {
    fail('工作副本缺少所属工程');
  }
  if (value.baseRevisionId !== null && typeof value.baseRevisionId !== 'string') {
    fail('工作副本的基修订字段非法');
  }
  if (typeof value.branch !== 'string' || value.branch.length === 0) fail('工作副本缺少分支名称');
  const payload = validatePayload(value.payload);
  return {
    projectId: value.projectId,
    baseRevisionId: value.baseRevisionId,
    branch: value.branch,
    generation: isFiniteNumber(value.generation) ? value.generation : 0,
    payload,
    updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : 0
  };
}

/* ------------------------------------------------------------------ */
/* Checkpoint graph                                                    */
/* ------------------------------------------------------------------ */

export function createRevision(input: {
  projectId: string;
  parentId: string | null;
  branch: string;
  label: string;
  payload: RevisionPayload;
  now?: number;
  id?: string;
}): Revision {
  return {
    id: input.id ?? uid('rev'),
    projectId: input.projectId,
    parentId: input.parentId,
    branch: input.branch,
    label: input.label.trim() || '未命名检查点',
    createdAt: input.now ?? Date.now(),
    format: REVISION_FORMAT,
    payload: structuredClone(input.payload)
  };
}

/**
 * Pick a fresh branch name that does not collide with any existing line.
 * Checkpointing seals the current branch; further edits and restores always
 * continue on a new branch so descendants never rewrite an existing line.
 */
export function freshBranchName(existing: Iterable<string>): string {
  const names = new Set(existing);
  if (!names.has(MAIN_BRANCH)) return MAIN_BRANCH;
  let index = 2;
  while (names.has(`分支-${index}`)) index += 1;
  return `分支-${index}`;
}

export function childrenOf(revisions: Revision[], id: string): Revision[] {
  return revisions.filter((revision) => revision.parentId === id);
}

export function branchNames(revisions: Revision[]): string[] {
  return [...new Set(revisions.map((revision) => revision.branch))];
}

/** Latest revision per branch, useful for branch lists and switchers. */
export function branchTips(revisions: Revision[]): Map<string, Revision> {
  const tips = new Map<string, Revision>();
  for (const revision of revisions) {
    const tip = tips.get(revision.branch);
    if (!tip || revision.createdAt >= tip.createdAt) tips.set(revision.branch, revision);
  }
  return tips;
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

const STYLE_KEYS: Array<{ key: keyof PatternObject & ('fill' | 'stroke' | 'strokeWidth' | 'opacity'); label: string }> = [
  { key: 'fill', label: '填充' },
  { key: 'stroke', label: '描边' },
  { key: 'strokeWidth', label: '线宽' },
  { key: 'opacity', label: '不透明度' }
];

function samePath(a: PatternObject, b: PatternObject): boolean {
  return JSON.stringify(a.path) === JSON.stringify(b.path);
}

/** Object/group diff between two revision payloads (order-insensitive for objects). */
export function diffPayloads(from: RevisionPayload, to: RevisionPayload): RevisionDiff {
  const diff: RevisionDiff = {
    groupChanged: from.group === to.group ? null : { from: from.group, to: to.group },
    cellChanged:
      from.cellWidth === to.cellWidth && from.cellHeight === to.cellHeight
        ? null
        : { from: [from.cellWidth, from.cellHeight], to: [to.cellWidth, to.cellHeight] },
    nameChanged: from.name === to.name ? null : { from: from.name, to: to.name },
    objects: []
  };
  const before = new Map(from.objects.map((object) => [object.id, object]));
  const after = new Map(to.objects.map((object) => [object.id, object]));
  for (const object of to.objects) {
    const previous = before.get(object.id);
    if (!previous) {
      diff.objects.push({ id: object.id, name: object.name, kind: 'added', pathChanged: true, styleChanges: [] });
      continue;
    }
    const styleChanges = STYLE_KEYS.filter(({ key }) => previous[key] !== object[key]).map(
      ({ label }) => label
    );
    if (previous.name !== object.name) styleChanges.unshift('名称');
    const pathChanged = !samePath(previous, object);
    if (pathChanged || styleChanges.length > 0) {
      diff.objects.push({ id: object.id, name: object.name, kind: 'modified', pathChanged, styleChanges });
    }
  }
  for (const object of from.objects) {
    if (!after.has(object.id)) {
      diff.objects.push({ id: object.id, name: object.name, kind: 'removed', pathChanged: true, styleChanges: [] });
    }
  }
  return diff;
}

export function isEmptyDiff(diff: RevisionDiff): boolean {
  return !diff.groupChanged && !diff.cellChanged && !diff.nameChanged && diff.objects.length === 0;
}

/* ------------------------------------------------------------------ */
/* Autosave generation guard                                           */
/* ------------------------------------------------------------------ */

export interface SaveContext {
  projectId: string;
  generation: number;
}

/**
 * A scheduled autosave is stale once the editor has moved to another project
 * or another revision context (both bump the working-copy generation). Stale
 * timers must be dropped so late content never lands in the new context.
 */
export function isStaleSave(scheduled: SaveContext, current: SaveContext): boolean {
  return scheduled.projectId !== current.projectId || scheduled.generation !== current.generation;
}

/* ------------------------------------------------------------------ */
/* Legacy (schema v1) migration                                        */
/* ------------------------------------------------------------------ */

export interface LegacyProjectRecord {
  id: string;
  name: string;
  group: GroupId;
  cellWidth: number;
  cellHeight: number;
  objects: PatternObject[];
  updatedAt: number;
}

export interface MigratedProject {
  meta: ProjectMeta;
  revision: Revision;
  workingCopy: WorkingCopy;
}

/**
 * Losslessly turn a v1 project record into an openable initial revision plus
 * its working copy and v2 metadata. The payload keeps group, lattice size,
 * every path, style and object id verbatim.
 */
export function migrateLegacyProject(record: LegacyProjectRecord, now = Date.now()): MigratedProject {
  const payload = validatePayload({
    name: record.name,
    group: record.group,
    cellWidth: record.cellWidth,
    cellHeight: record.cellHeight,
    objects: record.objects
  });
  const revision = createRevision({
    projectId: record.id,
    parentId: null,
    branch: MAIN_BRANCH,
    label: '迁移的初始修订',
    payload,
    now
  });
  const meta: ProjectMeta = {
    id: record.id,
    name: payload.name,
    updatedAt: record.updatedAt ?? now,
    headRevisionId: revision.id,
    currentBranch: MAIN_BRANCH,
    schemaVersion: 2
  };
  const workingCopy: WorkingCopy = {
    projectId: record.id,
    baseRevisionId: revision.id,
    branch: MAIN_BRANCH,
    generation: 0,
    payload: structuredClone(payload),
    updatedAt: record.updatedAt ?? now
  };
  return { meta, revision, workingCopy };
}

/** Type guard: v1 records carry objects directly and have no schemaVersion. */
export function isLegacyProjectRecord(value: unknown): value is LegacyProjectRecord {
  return isRecord(value) && !('schemaVersion' in value) && Array.isArray(value.objects);
}
