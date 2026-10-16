import type { Row, TableDiff } from './diff.js';

export type Risk = 'low' | 'medium' | 'high';
export type Status = 'pending' | 'committed' | 'rolled_back';
export type Resolution = 'approved' | 'rejected' | 'expired' | 'error';

export interface Proposal {
  id: string;
  sql: string;
  params?: unknown[];
  kind: 'write' | 'ddl';
  verb: string;
  status: Status;
  resolution?: Resolution;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
  rowsAffected: number;
  /** Rows returned by RETURNING, capped. */
  returning: Row[];
  tables: string[];
  diff: TableDiff[];
  risk: Risk;
  warnings: string[];
}

export interface QueryResult {
  rows: Row[];
  rowCount: number;
  truncated: boolean;
  /** Set when the result reflects a change that is still awaiting approval. */
  pendingChangeId?: string;
}

export class AirlockError extends Error {
  constructor(
    public readonly code:
      | 'blocked'
      | 'not_a_write'
      | 'not_a_read'
      | 'pending_exists'
      | 'not_found'
      | 'already_resolved'
      | 'sql_error'
      | 'commit_failed',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AirlockError';
  }
}
