export type Row = Record<string, unknown>;

export interface Snapshot {
  count: number;
  /** null when the table was too large to snapshot row by row. */
  rows: Row[] | null;
}

export interface RowChange {
  op: 'insert' | 'update' | 'delete';
  key: string;
  before?: Row;
  after?: Row;
  changedColumns?: string[];
}

export interface TableDiff {
  table: string;
  keyColumns: string[];
  existedBefore: boolean;
  existsAfter: boolean;
  rowCountBefore: number;
  rowCountAfter: number;
  inserted: number;
  updated: number;
  deleted: number;
  /** false when only counts are available. */
  rowLevel: boolean;
  changes: RowChange[];
  changesTruncated: boolean;
}

/** Round-trips a value through JSON so rows are plain, comparable and serializable. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as T;
}

function keyOf(row: Row, keyColumns: string[]): string {
  if (keyColumns.length === 0) return JSON.stringify(row);
  return JSON.stringify(keyColumns.map((c) => row[c]));
}

function changedColumns(before: Row, after: Row): string[] {
  const cols = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const c of cols) {
    if (JSON.stringify(before[c]) !== JSON.stringify(after[c])) changed.push(c);
  }
  return changed;
}

export function diffTables(
  table: string,
  keyColumns: string[],
  before: Snapshot | null,
  after: Snapshot | null,
  maxChanges = 100,
): TableDiff {
  const existedBefore = before !== null;
  const existsAfter = after !== null;
  const rowCountBefore = before?.count ?? 0;
  const rowCountAfter = after?.count ?? 0;

  const base = { table, keyColumns, existedBefore, existsAfter, rowCountBefore, rowCountAfter };

  const rowsBefore = before ? before.rows : [];
  const rowsAfter = after ? after.rows : [];

  if (rowsBefore === null || rowsAfter === null) {
    const delta = rowCountAfter - rowCountBefore;
    return {
      ...base,
      inserted: Math.max(delta, 0),
      updated: 0,
      deleted: Math.max(-delta, 0),
      rowLevel: false,
      changes: [],
      changesTruncated: false,
    };
  }

  const beforeMap = new Map<string, Row>();
  for (const r of rowsBefore) beforeMap.set(keyOf(r, keyColumns), r);
  const afterMap = new Map<string, Row>();
  for (const r of rowsAfter) afterMap.set(keyOf(r, keyColumns), r);

  const all: RowChange[] = [];
  let inserted = 0;
  let updated = 0;
  let deleted = 0;

  for (const [key, b] of beforeMap) {
    const a = afterMap.get(key);
    if (!a) {
      deleted++;
      all.push({ op: 'delete', key, before: b });
    } else {
      const cols = changedColumns(b, a);
      if (cols.length > 0) {
        updated++;
        all.push({ op: 'update', key, before: b, after: a, changedColumns: cols });
      }
    }
  }
  for (const [key, a] of afterMap) {
    if (!beforeMap.has(key)) {
      inserted++;
      all.push({ op: 'insert', key, after: a });
    }
  }

  return {
    ...base,
    inserted,
    updated,
    deleted,
    rowLevel: true,
    changes: all.slice(0, maxChanges),
    changesTruncated: all.length > maxChanges,
  };
}
