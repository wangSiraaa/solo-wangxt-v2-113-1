import type {
  GroupId,
  PathSegment,
  PatternObject,
  Project,
  ProjectMeta,
  Revision,
  RevisionPayload,
  WorkingCopy
} from '../types';
import { uid } from './path';

export const REVISION_FORMAT = 1;
export const INITIAL_BRANCH = 'main';

/** Explicit failure for corrupted or unsupported revision data. */
export class RevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionError';
  }
}

const GROUP_IDS: readonly GroupId[] = [
  'p1',
  'p2',
  'pm',
  'pg',
  'cm',
  'pmm',
  'pmg',
  'cmm',
  'p4',
  'p4m',
  'p4g',
  'p3',
  'p3m1',
  'p31m',
  'p6',
  'p6m'
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RevisionError(`修订载荷字段 ${field} 不是有限数值`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RevisionError(`修订载荷字段 ${field} 缺失或不是字符串`);
  }
  return value;
}

function validateSegment(segment: unknown, index: number): PathSegment {
  if (!isRecord(segment)) throw new RevisionError(`路径段 #${index} 不是对象`);
  const type = segment.type;
  if (type === 'Z') return { type: 'Z' };
  if (type === 'M' || type === 'L') {
    return { type, x: requireFinite(segment.x, `path[${index}].x`), y: requireFinite(segment.y, `path[${index}].y`) };
  }
  if (type === 'Q') {
    return {
      type,
      cx: requireFinite(segment.cx, `path[${index}].cx`),
      cy: requireFinite(segment.cy, `path[${index}].cy`),
      x: requireFinite(segment.x, `path[${index}].x`),
      y: requireFinite(segment.y, `path[${index}].y`)
    };
  }
  if (type === 'C') {
    return {
      type,
      cx1: requireFinite(segment.cx1, `path[${index}].cx1`),
      cy1: requireFinite(segment.cy1, `path[${index}].cy1`),
      cx2: requireFinite(segment.cx2, `path[${index}].cx2`),
      cy2: requireFinite(segment.cy2, `path[${index}].cy2`),
      x: requireFinite(segment.x, `path[${index}].x`),
      y: requireFinite(segment.y, `path[${index}].y`)
    };
  }
  throw new RevisionError(`路径段 #${index} 类型不支持: ${String(type)}`);
}

function validateObject(item: unknown, index: number): PatternObject {
  if (!isRecord(item)) throw new RevisionError(`对象 #${index} 不是对象`);
  const id = requireString(item.id, `objects[${index}].id`);
  const name = requireString(item.name, `objects[${index}].name`);
  if (!Array.isArray(item.path)) throw new RevisionError(`对象 ${id} 的 path 不是数组`);
  const path = item.path.map((segment, segmentIndex) => validateSegment(segment, segmentIndex));
  const fill = requireString(item.fill, `objects[${index}].fill`);
  const stroke = requireString(item.stroke, `objects[${index}].stroke`);
  const strokeWidth = requireFinite(item.strokeWidth, `objects[${index}].strokeWidth`);
  if (strokeWidth < 0) throw new RevisionError(`对象 ${id} 的线宽为负`);
  const opacity = requireFinite(item.opacity, `objects[${index}].opacity`);
  if (opacity < 0 || opacity > 1) throw new RevisionError(`对象 ${id} 的不透明度越界`);
  return { id, name, path, fill, stroke, strokeWidth, opacity };
}

/** Validate an unknown value as a revision payload, returning a normalized deep copy. */
export function validatePayload(value: unknown): RevisionPayload {
  if (!isRecord(value)) throw new RevisionError('修订载荷不是对象');
  const group = value.group;
  if (typeof group !== 'string' || !GROUP_IDS.includes(group as GroupId)) {
    throw new RevisionError(`不支持的墙纸群: ${String(group)}`);
  }
  const cellWidth = requireFinite(value.cellWidth, 'cellWidth');
  const cellHeight = requireFinite(value.cellHeight, 'cellHeight');
  if (cellWidth <= 0 || cellHeight <= 0) throw new RevisionError('晶格尺寸必须为正数');
  if (!Array.isArray(value.objects)) throw new RevisionError('修订载荷缺少 objects 数组');
  const objects = value.objects.map((item, index) => validateObject(item, index));
  const ids = new Set(objects.map((item) => item.id));
  if (ids.size !== objects.length) throw new RevisionError('修订载荷中存在重复的对象 ID');
  return { group: group as GroupId, cellWidth, cellHeight, objects };
}

/** Validate an unknown value as a full immutable revision record. */
export function validateRevision(record: unknown): Revision {
  if (!isRecord(record)) throw new RevisionError('修订记录不是对象');
  if (record.format !== REVISION_FORMAT) {
    throw new RevisionError(`不支持的修订格式: ${String(record.format)}（当前支持 ${REVISION_FORMAT}）`);
  }
  const id = requireString(record.id, 'id');
  const projectId = requireString(record.projectId, 'projectId');
  if (record.parentId !== null && typeof record.parentId !== 'string') {
    throw new RevisionError('父修订字段 parentId 必须是字符串或 null');
  }
  const branch = requireString(record.branch, 'branch');
  const label = typeof record.label === 'string' ? record.label : '';
  const createdAt = requireFinite(record.createdAt, 'createdAt');
  const payload = validatePayload(record.payload);
  return { id, projectId, parentId: record.parentId as string | null, branch, label, createdAt, format: REVISION_FORMAT, payload };
}

/** Validate an unknown value as a working copy record. */
export function validateWorkingCopy(record: unknown): WorkingCopy {
  if (!isRecord(record)) throw new RevisionError('工作副本记录不是对象');
  const projectId = requireString(record.projectId, 'projectId');
  const branch = requireString(record.branch, 'branch');
  if (record.baseRevisionId !== null && typeof record.baseRevisionId !== 'string') {
    throw new RevisionError('工作副本 baseRevisionId 必须是字符串或 null');
  }
  const generation = requireFinite(record.generation, 'generation');
  const updatedAt = requireFinite(record.updatedAt, 'updatedAt');
  const payload = validatePayload(record.payload);
  return { projectId, branch, baseRevisionId: record.baseRevisionId as string | null, generation, payload, updatedAt };
}

export function checkRevision(record: unknown): { ok: true; revision: Revision } | { ok: false; error: string } {
  try {
    return { ok: true, revision: validateRevision(record) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Snapshot the document portion of a project; object IDs, paths and styles are preserved. */
export function payloadFromProject(project: Project): RevisionPayload {
  return structuredClone({
    group: project.group,
    cellWidth: project.cellWidth,
    cellHeight: project.cellHeight,
    objects: project.objects
  });
}

/** Rebuild an editable project from meta + payload; object IDs survive the round trip. */
export function projectFromPayload(meta: ProjectMeta, payload: RevisionPayload): Project {
  return {
    id: meta.id,
    name: meta.name,
    group: payload.group,
    cellWidth: payload.cellWidth,
    cellHeight: payload.cellHeight,
    objects: structuredClone(payload.objects),
    updatedAt: meta.updatedAt
  };
}

export function payloadEquals(a: RevisionPayload, b: RevisionPayload): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** True when the working document differs from the payload frozen at its base revision. */
export function isDirtyAgainst(project: Project, base: Revision | null): boolean {
  if (!base) return true;
  return !payloadEquals(payloadFromProject(project), base.payload);
}

export function nextBranchName(meta: ProjectMeta): string {
  return `分支-${meta.branchCounter + 1}`;
}

export interface CheckpointPlan {
  revision: Revision;
  workingCopy: WorkingCopy;
  meta: ProjectMeta;
}

/**
 * Freeze the working copy into an immutable revision on its current branch, then move
 * the working copy onto a fresh branch so further edits form descendants elsewhere.
 */
export function planCheckpoint(args: {
  projectId: string;
  branch: string;
  baseRevisionId: string | null;
  payload: RevisionPayload;
  meta: ProjectMeta;
  label: string;
  now: number;
}): CheckpointPlan {
  const payload = validatePayload(args.payload);
  const revision: Revision = {
    id: uid('rev'),
    projectId: args.projectId,
    parentId: args.baseRevisionId,
    branch: args.branch,
    label: args.label,
    createdAt: args.now,
    format: REVISION_FORMAT,
    payload: structuredClone(payload)
  };
  const meta: ProjectMeta = { ...args.meta, branchCounter: args.meta.branchCounter + 1, updatedAt: args.now };
  const workingCopy: WorkingCopy = {
    projectId: args.projectId,
    branch: nextBranchName(args.meta),
    baseRevisionId: revision.id,
    generation: 0,
    payload: structuredClone(payload),
    updatedAt: args.now
  };
  return { revision, workingCopy, meta };
}

/**
 * Restore an old checkpoint by descending from it: the working copy adopts the
 * checkpoint payload on a brand-new branch. The old revision is never modified.
 */
export function planRestore(args: { revision: Revision; meta: ProjectMeta; now: number }): CheckpointPlan {
  const revision = validateRevision(args.revision);
  const meta: ProjectMeta = { ...args.meta, branchCounter: args.meta.branchCounter + 1, updatedAt: args.now };
  const workingCopy: WorkingCopy = {
    projectId: revision.projectId,
    branch: nextBranchName(args.meta),
    baseRevisionId: revision.id,
    generation: 0,
    payload: structuredClone(revision.payload),
    updatedAt: args.now
  };
  return { revision, workingCopy, meta };
}

export interface LegacyMigration {
  meta: ProjectMeta;
  revision: Revision;
  workingCopy: WorkingCopy;
}

/**
 * Losslessly migrate a v1 project record (full document in the projects store) into
 * meta + an openable initial revision on `main` + a working copy on a fresh branch.
 * Returns null when the record is not a valid legacy project.
 */
export function planLegacyMigration(record: unknown, now: number): LegacyMigration | null {
  if (!isRecord(record)) return null;
  if (Array.isArray(record.objects) === false && record.group === undefined) return null;
  try {
    const payload = validatePayload({
      group: record.group,
      cellWidth: record.cellWidth,
      cellHeight: record.cellHeight,
      objects: record.objects
    });
    const id = requireString(record.id, 'id');
    const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : '未命名工程';
    const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : now;
    const revision: Revision = {
      id: uid('rev'),
      projectId: id,
      parentId: null,
      branch: INITIAL_BRANCH,
      label: '旧版工程迁移',
      createdAt: updatedAt,
      format: REVISION_FORMAT,
      payload: structuredClone(payload)
    };
    const meta: ProjectMeta = { id, name, createdAt: updatedAt, updatedAt: now, branchCounter: 1 };
    const workingCopy: WorkingCopy = {
      projectId: id,
      branch: `分支-${meta.branchCounter}`,
      baseRevisionId: revision.id,
      generation: 1,
      payload: structuredClone(payload),
      updatedAt: now
    };
    return { meta, revision, workingCopy };
  } catch {
    return null;
  }
}

export interface ObjectDiff {
  id: string;
  name: string;
  change: 'added' | 'removed' | 'modified';
  details: string[];
}

export interface RevisionDiff {
  group: { from: GroupId; to: GroupId } | null;
  cell: { from: [number, number]; to: [number, number] } | null;
  objects: ObjectDiff[];
  empty: boolean;
}

function diffObject(a: PatternObject, b: PatternObject): ObjectDiff | null {
  const details: string[] = [];
  if (a.name !== b.name) details.push(`名称: ${a.name} → ${b.name}`);
  if (a.fill !== b.fill) details.push(`填充: ${a.fill} → ${b.fill}`);
  if (a.stroke !== b.stroke) details.push(`描边: ${a.stroke} → ${b.stroke}`);
  if (a.strokeWidth !== b.strokeWidth) details.push(`线宽: ${a.strokeWidth} → ${b.strokeWidth}`);
  if (a.opacity !== b.opacity) details.push(`不透明度: ${a.opacity} → ${b.opacity}`);
  if (JSON.stringify(a.path) !== JSON.stringify(b.path)) {
    details.push(
      a.path.length === b.path.length
        ? `路径节点已修改（${a.path.length} 段）`
        : `路径段数: ${a.path.length} → ${b.path.length}`
    );
  }
  if (details.length === 0) return null;
  return { id: a.id, name: b.name, change: 'modified', details };
}

/** Structural diff between two revision payloads: group, lattice, and per-object changes. */
export function diffPayloads(a: RevisionPayload, b: RevisionPayload): RevisionDiff {
  const group = a.group === b.group ? null : { from: a.group, to: b.group };
  const cell =
    a.cellWidth === b.cellWidth && a.cellHeight === b.cellHeight
      ? null
      : { from: [a.cellWidth, a.cellHeight] as [number, number], to: [b.cellWidth, b.cellHeight] as [number, number] };
  const objects: ObjectDiff[] = [];
  const bById = new Map(b.objects.map((item) => [item.id, item]));
  for (const item of a.objects) {
    const other = bById.get(item.id);
    if (!other) {
      objects.push({ id: item.id, name: item.name, change: 'removed', details: ['仅存在于旧修订'] });
    } else {
      const diff = diffObject(item, other);
      if (diff) objects.push(diff);
    }
  }
  const aIds = new Set(a.objects.map((item) => item.id));
  for (const item of b.objects) {
    if (!aIds.has(item.id)) {
      objects.push({ id: item.id, name: item.name, change: 'added', details: ['仅存在于新修订'] });
    }
  }
  return { group, cell, objects, empty: !group && !cell && objects.length === 0 };
}
