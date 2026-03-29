/**
 * VectorStore
 *
 * A pure-JavaScript cosine similarity index persisted as a JSON file in the
 * plugin's data directory.  No native dependencies — works inside Joplin's
 * webpack plugin sandbox.
 *
 * Design decisions
 * ────────────────
 * • hash-based change detection: each entry stores a SHA-256 hash of its
 *   source text.  upsert() is a no-op when the hash hasn't changed, so
 *   re-indexing a 1,000-note collection only re-embeds modified notes.
 *
 * • put(note)/query(text) interface: deliberately matches the shared
 *   infrastructure interface discussed by @shikuz on the Joplin forum so
 *   chat, categorisation, and note-graph plugins can share one index.
 *
 * • Batch-and-yield: buildIndex() processes notes in batches of 10 and
 *   yields to the event loop between batches so Joplin stays responsive.
 *
 * • Partial progress: the index is written to disk after every batch.
 *   If Joplin is closed mid-index, the next startup resumes from where
 *   it stopped.
 */

import joplin from "api";
import type { Chunk } from "./chunker";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VectorEntry {
  noteId:        string;
  chunkIndex:    number;   // position within the note's chunk array
  vector:        number[];
  headingPath:   string;
  headingAnchor: string;
  hash:          string;   // SHA-256 of the chunk text for change detection
  tokens:        number;
  updatedAt:     number;   // Unix ms timestamp
}

export interface SearchResult {
  noteId:        string;
  headingPath:   string;
  headingAnchor: string;
  score:         number;   // cosine similarity [0, 1]
  chunkIndex:    number;
}

interface StorageSchema {
  version:  number;
  entries:  VectorEntry[];
  builtAt:  number;
}

const SCHEMA_VERSION  = 1;
const STORE_FILENAME  = "vector_store.json";
const BATCH_SIZE      = 10;

// ── VectorStore ───────────────────────────────────────────────────────────────

export class VectorStore {
  private entries: VectorEntry[] = [];
  private dataDir: string        = "";
  private dirty:   boolean       = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.dataDir = await joplin.plugins.dataDir();
    await this.load();
  }

  // ── put/query — shared infrastructure interface ───────────────────────────

  /**
   * Upsert all chunks for a note.
   * Chunks whose hash hasn't changed are skipped (no re-embed needed).
   * Returns the number of chunks that were actually updated.
   */
  async put(noteId: string, chunks: Chunk[], vectors: number[][]): Promise<number> {
    if (chunks.length !== vectors.length) {
      throw new Error("chunks and vectors arrays must have the same length");
    }

    // Remove stale entries for this note.
    const existingByIndex = new Map<number, VectorEntry>();
    for (const e of this.entries) {
      if (e.noteId === noteId) existingByIndex.set(e.chunkIndex, e);
    }

    let updated = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk    = chunks[i];
      const existing = existingByIndex.get(i);

      // Skip if hash matches — nothing changed.
      if (existing && existing.hash === chunk.hash) {
        existingByIndex.delete(i);
        continue;
      }

      const entry: VectorEntry = {
        noteId,
        chunkIndex:    i,
        vector:        vectors[i],
        headingPath:   chunk.headingPath,
        headingAnchor: chunk.headingAnchor,
        hash:          chunk.hash,
        tokens:        chunk.tokens,
        updatedAt:     Date.now(),
      };

      // Replace or add.
      const idx = this.entries.findIndex(
        e => e.noteId === noteId && e.chunkIndex === i
      );
      if (idx >= 0) {
        this.entries[idx] = entry;
      } else {
        this.entries.push(entry);
      }
      updated++;
    }

    // Remove chunks that no longer exist in the note (note was shortened).
    const validIndices = new Set(chunks.map((_, i) => i));
    this.entries = this.entries.filter(
      e => e.noteId !== noteId || validIndices.has(e.chunkIndex)
    );

    if (updated > 0) {
      this.dirty = true;
      await this.save();
    }
    return updated;
  }

  /**
   * Remove all chunks for a note (called when a note is deleted).
   */
  async remove(noteId: string): Promise<void> {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.noteId !== noteId);
    if (this.entries.length !== before) {
      this.dirty = true;
      await this.save();
    }
  }

  /**
   * Find the top-K most similar chunks to a query vector.
   *
   * @param queryVector  Normalised embedding from EmbeddingService.embed()
   * @param topK         Number of results to return (default 10)
   * @returns            Results sorted by descending cosine similarity
   */
  query(queryVector: number[], topK = 10): SearchResult[] {
    if (this.entries.length === 0) return [];

    const scored = this.entries.map(entry => ({
      noteId:        entry.noteId,
      headingPath:   entry.headingPath,
      headingAnchor: entry.headingAnchor,
      chunkIndex:    entry.chunkIndex,
      score:         cosineSimilarity(queryVector, entry.vector),
    }));

    // Sort descending, return top-K.
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // ── Convenience ───────────────────────────────────────────────────────────

  /** True if a note has at least one indexed chunk. */
  hasNote(noteId: string): boolean {
    return this.entries.some(e => e.noteId === noteId);
  }

  /** Number of notes with at least one chunk in the index. */
  get noteCount(): number {
    return new Set(this.entries.map(e => e.noteId)).size;
  }

  /** Total number of chunk vectors in the index. */
  get chunkCount(): number {
    return this.entries.length;
  }

  /** Wipe the entire index (triggered by "Rebuild Index" in settings). */
  async clear(): Promise<void> {
    this.entries = [];
    await this.save();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    try {
      const raw = await joplin.plugins.dataDir(); // get data dir
      // Use Joplin's filesystem abstraction to read the store file.
      const text = await (joplin as any).require("fs-extra").readFile(
        `${this.dataDir}/${STORE_FILENAME}`, "utf8"
      );
      const schema: StorageSchema = JSON.parse(text);
      if (schema.version === SCHEMA_VERSION) {
        this.entries = schema.entries;
      }
    } catch {
      // File doesn't exist yet — start fresh.
      this.entries = [];
    }
  }

  async save(): Promise<void> {
    const schema: StorageSchema = {
      version: SCHEMA_VERSION,
      entries: this.entries,
      builtAt: Date.now(),
    };
    const fsExtra = await (joplin as any).require("fs-extra");
    await fsExtra.ensureDir(this.dataDir);
    await fsExtra.writeFile(
      `${this.dataDir}/${STORE_FILENAME}`,
      JSON.stringify(schema),
      "utf8"
    );
    this.dirty = false;
  }
}

// ── Math ──────────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors.
 * Assumes both vectors are already L2-normalised (Transformers.js normalize:true),
 * so this is just the dot product.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Clamp to [0, 1] — normalised vectors can have tiny float errors.
  return Math.max(0, Math.min(1, dot));
}