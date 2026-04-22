/**
 * Durable streaming log per notes file — the "LLM-ish" source the chat demo
 * consumes.
 *
 * Why a log and not the raw file-read:
 *
 *   - The source isn't actually resumable (real LLM APIs aren't either). So
 *     we read once, append to an in-memory chunk array, and every Flight
 *     reader pulls from that array. Resume = continue from cursor.
 *   - Disconnects (a `<ResumeTail>` reload, a full page reload, a browser
 *     navigation) don't cancel the source producer. It keeps appending.
 *   - On resume the flat-prefix render dumps chunks 0..cursor synchronously
 *     and the fresh `<Piece>` chain picks up from `cursor`.
 *
 * The "tokens" are paragraphs of the file, with a small simulated delay per
 * chunk so the recursion actually has something to stream and the bounded-
 * depth compaction seam is observable.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CHUNK_DELAY_MS = 100;
const CHUNK_CHAR_SIZE = 100;
const NOTES_DIR = resolve(process.cwd(), "notes");

interface MessageLog {
  chunks: string[];
  done: boolean;
  error: Error | null;
  waiters: Set<() => void>;
}

const logs = new Map<string, MessageLog>();

function ensureLog(fileId: string): MessageLog {
  let log = logs.get(fileId);
  if (log) return log;
  log = { chunks: [], done: false, error: null, waiters: new Set() };
  logs.set(fileId, log);
  void runProducer(fileId, log);
  return log;
}

async function runProducer(fileId: string, log: MessageLog): Promise<void> {
  try {
    const text = await readFile(resolve(NOTES_DIR, `${fileId}.md`), "utf8");
    // Hard-slice into fixed-length chunks so the stream feels like
    // token-by-token reveal rather than paragraph drops. A word-boundary
    // splitter would look nicer but variable chunk sizes make compaction
    // timing unpredictable; fixed-size keeps the seam easy to reason about.
    for (let i = 0; i < text.length; i += CHUNK_CHAR_SIZE) {
      await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
      log.chunks.push(text.slice(i, i + CHUNK_CHAR_SIZE));
      wakeAll(log);
    }
  } catch (e) {
    log.error = e instanceof Error ? e : new Error(String(e));
  } finally {
    log.done = true;
    wakeAll(log);
  }
}

function wakeAll(log: MessageLog): void {
  const waiters = [...log.waiters];
  log.waiters.clear();
  for (const w of waiters) w();
}

export interface LogRead {
  /** The chunk text, or empty string when `done`. */
  text: string;
  /** True when no more chunks will ever be produced for this cursor. */
  done: boolean;
}

/**
 * Await the chunk at `cursor`. Resolves when the producer has appended at
 * least `cursor + 1` chunks, OR the producer has finished with fewer chunks
 * (in which case `done: true`).
 */
export async function readLog(
  fileId: string,
  cursor: number,
): Promise<LogRead> {
  const log = ensureLog(fileId);
  while (true) {
    if (log.error) throw log.error;
    if (cursor < log.chunks.length) {
      return { text: log.chunks[cursor], done: false };
    }
    if (log.done) return { text: "", done: true };
    await new Promise<void>((resolve) => log.waiters.add(resolve));
  }
}

/**
 * Return the chunks already produced in range [0, cursor). Used for the flat
 * prefix render after a compaction reload. Never blocks — if fewer than
 * `cursor` chunks are available (reload landed before producer caught up),
 * the returned array is shorter, and the `<Piece>` chain starting at the
 * actual length will fill the rest.
 */
export function readLogPrefix(fileId: string, cursor: number): string[] {
  const log = ensureLog(fileId);
  return log.chunks.slice(0, Math.max(0, cursor));
}

/** Test-only: wipe every log (used by dev cache-clear + test isolation). */
export function _clearLogs(): void {
  logs.clear();
}
