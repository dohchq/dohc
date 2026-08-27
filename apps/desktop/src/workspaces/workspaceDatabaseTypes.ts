import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";

export type DatabaseRowOp = "insert" | "update" | "upsert" | "delete";

export interface DatabaseColumnView {
  name: string;
  type: string;
  primaryKey?: boolean;
  nullable?: boolean;
}

export interface DatabaseTableView {
  name: string;
  columns: DatabaseColumnView[];
  rows: Array<Record<string, unknown>>;
  nextOffset: number | null;
}

export interface DatabaseSnapshotView {
  path: string;
  tables: DatabaseTableView[];
}

export interface DatabasePageView {
  path: string;
  table: string;
  offset: number;
  rows: Array<Record<string, unknown>>;
  nextOffset: number | null;
}

export interface DatabaseEdit {
  table: string;
  op: DatabaseRowOp;
  pkColumn: string;
  rowId: string | number;
  payload?: Record<string, unknown>;
}

export interface DatabaseEditResult {
  path: string;
  table: string;
  page: {
    offset: number;
    rows: Array<Record<string, unknown>>;
    nextOffset: number | null;
  };
  version: number;
}

export interface DatabaseOperationInput {
  operationId: string;
  databasePath: string;
  table: string;
  op: DatabaseRowOp;
  rowId: string;
  payload: Record<string, unknown>;
  appliedAt: number;
  author: ChangeAuthor;
}
