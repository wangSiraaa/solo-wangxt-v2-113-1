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

/** Revision payload: the complete document snapshot frozen into a checkpoint. */
export interface RevisionPayload {
  group: GroupId;
  cellWidth: number;
  cellHeight: number;
  objects: PatternObject[];
}

/** Immutable checkpoint. Once written it is never modified or overwritten. */
export interface Revision {
  id: string;
  projectId: string;
  parentId: string | null;
  branch: string;
  label: string;
  createdAt: number;
  format: number;
  payload: RevisionPayload;
}

/** Mutable working copy: exactly one per project, descended from a base revision. */
export interface WorkingCopy {
  projectId: string;
  branch: string;
  baseRevisionId: string | null;
  generation: number;
  payload: RevisionPayload;
  updatedAt: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  branchCounter: number;
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
