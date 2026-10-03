export type Point = [number, number];

export type PathSegment =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; cx: number; cy: number; x: number; y: number }
  | { type: 'C'; cx1: number; cy1: number; cx2: number; cy2: number; x: number; y: number }
  | { type: 'Z' };

export type GroupId =
  | 'p1'
  | 'p2'
  | 'pm'
  | 'pg'
  | 'cm'
  | 'pmm'
  | 'pmg'
  | 'cmm'
  | 'p4'
  | 'p4m'
  | 'p4g'
  | 'p3'
  | 'p3m1'
  | 'p31m'
  | 'p6'
  | 'p6m';

export interface StyleSpec {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

export interface PatternObject extends StyleSpec {
  id: string;
  name: string;
  path: PathSegment[];
}

export interface Project {
  id: string;
  name: string;
  group: GroupId;
  cellWidth: number;
  cellHeight: number;
  objects: PatternObject[];
  updatedAt: number;
}

/**
 * Immutable snapshot content of a revision. Must carry everything the canvas,
 * instance locating and PNG export need: group, lattice size, all paths,
 * styles and object IDs.
 */
export interface RevisionPayload {
  name: string;
  group: GroupId;
  cellWidth: number;
  cellHeight: number;
  objects: PatternObject[];
}

/** An immutable checkpoint. Once written it is never modified or overwritten. */
export interface Revision {
  id: string;
  projectId: string;
  /** Parent revision id; null for the root revision of a project. */
  parentId: string | null;
  /** Branch line this revision belongs to. */
  branch: string;
  label: string;
  createdAt: number;
  /** Payload format version; unsupported versions must fail explicitly. */
  format: number;
  payload: RevisionPayload;
}

/** The mutable working copy of a project, stored separately from revisions. */
export interface WorkingCopy {
  projectId: string;
  /** Revision the working copy is currently based on (null before first checkpoint). */
  baseRevisionId: string | null;
  branch: string;
  /** Generation captured when the context was entered; autosave carries it. */
  generation: number;
  payload: RevisionPayload;
  updatedAt: number;
}

/** v2 project record: metadata only; content lives in revisions/working copy. */
export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  headRevisionId: string | null;
  currentBranch: string;
  schemaVersion: 2;
}

export interface ObjectDiff {
  id: string;
  name: string;
  kind: 'added' | 'removed' | 'modified';
  pathChanged: boolean;
  styleChanges: string[];
}

export interface RevisionDiff {
  groupChanged: { from: GroupId; to: GroupId } | null;
  cellChanged: { from: [number, number]; to: [number, number] } | null;
  nameChanged: { from: string; to: string } | null;
  objects: ObjectDiff[];
}

export type Tool = 'select' | 'node' | 'pen' | 'rectangle' | 'ellipse';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface RenderOptions {
  showDomain: boolean;
  showGrid: boolean;
  showSymmetry: boolean;
  showHandles: boolean;
}
