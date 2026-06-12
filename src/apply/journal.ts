// journal.ts — append-only audit log for archive/restore operations (DESIGN.md §8.2)
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JournalEntry } from '../types.js';

const JOURNAL_FILE = 'journal.jsonl';

/** Append a single JournalEntry line to ~/.curator/journal.jsonl */
export async function appendJournal(curatorHome: string, entry: JournalEntry): Promise<void> {
  await mkdir(curatorHome, { recursive: true });
  const journalPath = join(curatorHome, JOURNAL_FILE);
  await appendFile(journalPath, JSON.stringify(entry) + '\n', 'utf8');
}
