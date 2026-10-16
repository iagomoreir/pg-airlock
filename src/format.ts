import type { Row, TableDiff } from './diff.js';
import type { Proposal } from './types.js';

function show(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v.length > 60 ? JSON.stringify(v.slice(0, 57) + '...') : JSON.stringify(v);
  return String(typeof v === 'object' ? JSON.stringify(v) : v);
}

function rowLine(row: Row): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}=${show(v)}`)
    .join(' ');
}

function formatTable(d: TableDiff): string[] {
  const lines: string[] = [];
  const state = !d.existedBefore ? ' (new table)' : !d.existsAfter ? ' (table dropped)' : '';
  lines.push(
    `  ${d.table}${state}: ${d.inserted} inserted, ${d.updated} updated, ${d.deleted} deleted  [rows ${d.rowCountBefore} -> ${d.rowCountAfter}]`,
  );
  for (const c of d.changes) {
    if (c.op === 'insert' && c.after) lines.push(`    + ${rowLine(c.after)}`);
    else if (c.op === 'delete' && c.before) lines.push(`    - ${rowLine(c.before)}`);
    else if (c.op === 'update' && c.before && c.after) {
      const keyCols = d.keyColumns.length > 0 ? d.keyColumns : [];
      const key = keyCols.map((k) => `${k}=${show(c.after![k])}`).join(' ');
      const changes = (c.changedColumns ?? []).map((col) => `${col}: ${show(c.before![col])} -> ${show(c.after![col])}`);
      lines.push(`    ~ ${key ? key + '  ' : ''}${changes.join('; ')}`);
    }
  }
  if (d.changesTruncated) lines.push('    ... more changes not shown');
  return lines;
}

export function formatProposal(p: Proposal): string {
  const out: string[] = [];
  const only = p.diff.length === 1 ? p.diff[0] : undefined;
  const changed = only ? only.inserted + only.updated + only.deleted : 0;
  const unchanged =
    only?.rowLevel && p.verb !== 'insert' && p.rowsAffected > changed
      ? ` (${p.rowsAffected - changed} matched but already had these values)`
      : '';
  out.push(
    `${p.id}  [${p.status.toUpperCase()}]  risk: ${p.risk.toUpperCase()}  rows affected: ${p.rowsAffected}${unchanged}`,
  );
  out.push(`created ${p.createdAt}${p.status === 'pending' ? `, auto-rollback at ${p.expiresAt}` : ''}`);
  if (p.resolvedAt) out.push(`${p.resolution} by ${p.resolvedBy} at ${p.resolvedAt}${p.reason ? ` (${p.reason})` : ''}`);
  out.push('');
  out.push('SQL:');
  out.push(
    p.sql
      .trim()
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  );
  if (p.diff.length > 0) {
    out.push('');
    out.push('Changes:');
    for (const d of p.diff) out.push(...formatTable(d));
  }
  if (p.warnings.length > 0) {
    out.push('');
    for (const w of p.warnings) out.push(`! ${w}`);
  }
  return out.join('\n');
}
