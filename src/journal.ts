import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface JournalEntry {
  ts: string;
  event: 'proposed' | 'committed' | 'rolled_back' | 'expired' | 'rejected_statement' | 'error';
  id?: string;
  actor?: string;
  detail: Record<string, unknown>;
}

/** Append-only JSONL log of everything the agent proposed and everything a human decided. */
export class Journal {
  constructor(private readonly path: string | null) {}

  async append(entry: Omit<JournalEntry, 'ts'>): Promise<void> {
    if (!this.path) return;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      await appendFile(this.path, line + '\n', { mode: 0o600 });
    } catch (err) {
      // The journal is best-effort; never let logging break a transaction decision.
      process.stderr.write(`[pg-airlock] journal write failed: ${(err as Error).message}\n`);
    }
  }

  async tail(n = 50): Promise<JournalEntry[]> {
    if (!this.path) return [];
    try {
      const text = await readFile(this.path, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => JSON.parse(l) as JournalEntry);
    } catch {
      return [];
    }
  }
}
