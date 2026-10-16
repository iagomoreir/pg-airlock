/**
 * Minimal SQL front-end: normalizes a statement (strips comments, blanks string
 * literals) and classifies it as read / write / ddl / blocked.
 *
 * This is NOT a full SQL parser. It is deliberately conservative: anything it
 * cannot confidently classify as a plain read is either routed through human
 * approval (write/ddl) or refused (blocked). Reads additionally run inside a
 * READ ONLY transaction, so Postgres itself is the second line of defence.
 */

export type StatementKind = 'read' | 'write' | 'ddl' | 'blocked';

export interface Classification {
  kind: StatementKind;
  /** First keyword, lower-case (select, update, drop, ...). */
  verb: string;
  /** Tables the statement is expected to touch, as written by the caller. */
  tables: string[];
  hasWhere: boolean;
  /** drop/truncate/grant/revoke, or update/delete without WHERE. */
  destructive: boolean;
  /** Why the statement was blocked (kind === 'blocked'). */
  reason?: string;
}

/**
 * Removes comments and blanks string literals / dollar-quoted bodies, keeping
 * quoted identifiers intact. Mirrors PostgreSQL lexing closely enough that a
 * literal cannot hide a second statement from the classifier.
 */
export function normalize(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const d = sql[i + 1];

    if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += ' ';
      continue;
    }

    if (c === "'") {
      // E'...' strings treat backslash as an escape character.
      const prev = sql[i - 1];
      const prev2 = sql[i - 2];
      const isEscapeString = prev !== undefined && /[eE]/.test(prev) && !(prev2 !== undefined && /[\w$]/.test(prev2));
      i++;
      while (i < n) {
        if (isEscapeString && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += "''";
        continue;
      }
    }

    out += c;
    i++;
  }
  return out;
}

const ID = `(?:"(?:[^"]|"")+"|[A-Za-z_][\\w$]*)`;
const NAME = `${ID}(?:\\s*\\.\\s*${ID})?`;
const NAME_LIST = `${NAME}(?:\\s*,\\s*${NAME})*`;

const TABLE_PATTERNS: RegExp[] = [
  new RegExp(`\\binsert\\s+into\\s+(${NAME})`, 'gi'),
  new RegExp(`\\bupdate\\s+(?:only\\s+)?(?!set\\b)(${NAME})`, 'gi'),
  new RegExp(`\\bdelete\\s+from\\s+(?:only\\s+)?(${NAME})`, 'gi'),
  new RegExp(`\\bmerge\\s+into\\s+(?:only\\s+)?(${NAME})`, 'gi'),
  new RegExp(`\\btruncate\\s+(?:table\\s+)?(?:only\\s+)?(${NAME_LIST})`, 'gi'),
  new RegExp(`\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?(${NAME_LIST})`, 'gi'),
  new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${NAME})`, 'gi'),
  new RegExp(
    `\\bcreate\\s+(?:unlogged\\s+|temp(?:orary)?\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(${NAME})`,
    'gi',
  ),
];

const NAME_ONE = new RegExp(NAME, 'g');

export function extractTables(normalized: string): string[] {
  const seen = new Map<string, string>();
  for (const re of TABLE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized)) !== null) {
      const group = m[1] ?? '';
      const names = group.match(NAME_ONE) ?? [];
      for (const raw of names) {
        const name = raw.replace(/\s+/g, '');
        const key = name.toLowerCase();
        if (!seen.has(key)) seen.set(key, name);
      }
    }
  }
  return [...seen.values()];
}

/** Functions that read the server's disk, kill sessions or otherwise escape the data model. */
const DENIED_FUNCTIONS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_ls_\w+|pg_stat_file|lo_import|lo_export|lo_from_bytea|dblink\w*|set_config|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_advisory_(?:xact_)?lock\w*)\b/i;

const READ_VERBS = new Set(['select', 'values', 'table', 'show']);
const WRITE_VERBS = new Set(['insert', 'update', 'delete', 'merge']);
const DDL_VERBS = new Set(['create', 'alter', 'drop', 'truncate', 'comment', 'grant', 'revoke']);

function blocked(reason: string, verb = ''): Classification {
  return { kind: 'blocked', verb, tables: [], hasWhere: false, destructive: false, reason };
}

export function classify(sql: string): Classification {
  const norm = normalize(sql).trim();
  if (!norm) return blocked('empty statement');

  const noIdent = norm.replace(/"(?:[^"]|"")*"/g, '""');
  const body = noIdent.replace(/[;\s]+$/, '');
  if (body.includes(';')) {
    return blocked('multiple statements are not allowed; send exactly one statement per call');
  }

  const verb = (/^[\s(]*([A-Za-z]+)/.exec(body)?.[1] ?? '').toLowerCase();
  if (!verb) return blocked('could not determine statement type');

  if (DENIED_FUNCTIONS.test(body)) {
    return blocked('statement calls a function that is not allowed through this proxy', verb);
  }

  const hasWhere = /\bwhere\b/i.test(body);

  if (READ_VERBS.has(verb)) {
    if (verb === 'select' && /\binto\b/i.test(body)) {
      return blocked('SELECT ... INTO is not allowed; use CREATE TABLE AS through db_execute', verb);
    }
    return { kind: 'read', verb, tables: [], hasWhere, destructive: false };
  }

  if (verb === 'explain') {
    if (/\banalyze\b/i.test(body)) {
      return blocked('EXPLAIN ANALYZE executes the statement; send the statement itself', verb);
    }
    return { kind: 'read', verb, tables: [], hasWhere, destructive: false };
  }

  if (verb === 'with') {
    if (/\b(insert|update|delete|merge)\b/i.test(body)) {
      return {
        kind: 'write',
        verb,
        tables: extractTables(norm),
        hasWhere,
        destructive: false,
      };
    }
    return { kind: 'read', verb, tables: [], hasWhere, destructive: false };
  }

  if (WRITE_VERBS.has(verb)) {
    const destructive = (verb === 'update' || verb === 'delete') && !hasWhere;
    return { kind: 'write', verb, tables: extractTables(norm), hasWhere, destructive };
  }

  if (DDL_VERBS.has(verb)) {
    const destructive = verb === 'drop' || verb === 'truncate' || verb === 'grant' || verb === 'revoke';
    return { kind: 'ddl', verb, tables: extractTables(norm), hasWhere, destructive };
  }

  return blocked(
    `'${verb.toUpperCase()}' is not allowed through this proxy (transaction control, COPY, DO/CALL, SET and similar are reserved)`,
    verb,
  );
}
