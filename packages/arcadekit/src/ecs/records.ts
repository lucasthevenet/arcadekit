/**
 * What a world keeps beside its tables: where an entity that is not placed
 * stands, the instance of a singleton, and what a transaction saved.
 *
 * No Effect dependency.
 */
import type { ComponentDef } from "./component";
import type { Columns, SparseSet, Table } from "./table";

/** Where the record of an entity whose spawn is not applied yet points. */
export const NOT_PLACED = -1;
/** In a `Saved`, the row value that means "every row". */
export const WHOLE = -1;

/** The single instance of a singleton that a world holds. */
export interface Single {
  readonly def: ComponentDef;
  /** One row. */
  readonly columns: Columns;
  /**
   * Its value in a world that hasn't written it, once the world has been given
   * it: what `restore` puts back when the snapshot doesn't hold it.
   */
  initial: Readonly<Record<string, unknown>> | undefined;
  /**
   * False until it is first written. Until then it holds its initial value and
   * behaves as if absent: it isn't saved, and isn't in the hash.
   */
  written: boolean;
  /** What `World.singleton` returns: reads and writes go to `columns`. */
  readonly value: object;
  /** The world's version when it was last written, and its cached hash. */
  version: number;
  hash: number;
  hashedAt: number;
}

/** What a transaction saved before a write: one row, or whole columns. */
export interface Saved {
  readonly cols: Columns;
  /** Whose columns they are: a rollback notes that it wrote them. */
  readonly owner: Table | SparseSet | Single;
  readonly def: ComponentDef;
  /** `WHOLE`, or the one row that was saved. */
  readonly row: number;
  /** How many rows `copies` holds when it holds whole columns. */
  readonly count: number;
  /**
   * For each field, a copy of the column's first `count` rows (the array may be
   * longer, since it is reused), or the single row's value.
   */
  readonly copies: unknown[];
}
