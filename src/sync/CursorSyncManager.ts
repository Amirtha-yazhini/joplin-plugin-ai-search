/**
 * Joplin Events API Cursor — Incremental Sync Proof of Concept
 *
 * This module demonstrates reliable change tracking using Joplin's
 * Events API cursor so that no note update is ever missed, even across
 * sync sessions, app restarts, or background modifications.
 *
 * Repository: github.com/Amirtha-yazhini/joplin-plugin-ai-search
 * Part of GSoC 2026 proposal: AI-Supported Search for Notes
 */

import joplin from "api";

// ─── Types ───────────────────────────────────────────────────────────────────

interface NoteChange {
  id: string;        // Note ID
  type: number;      // 1 = Created, 2 = Updated, 3 = Deleted
  item_type: number; // 1 = Note (we filter on this)
  created_time: number;
}

interface EventPage {
  items: NoteChange[];
  has_more: boolean;
  cursor: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CURSOR_SETTING_KEY   = "events_cursor";
const POLL_INTERVAL_MS     = 5 * 60 * 1000; // 5 minutes
const ITEM_TYPE_NOTE       = 1;
const EVENT_TYPE_DELETED   = 3;

// ─── CursorSyncManager ───────────────────────────────────────────────────────

/**
 * Tracks all note changes across the entire Joplin database using the
 * Events API cursor. Unlike onNoteChange(), which only fires for the
 * currently selected note, this captures every create/update/delete
 * regardless of which note is active or where the change originated
 * (local edit, sync from another device, Joplin server, etc.).
 *
 * How the cursor works:
 *   - Joplin maintains a monotonically increasing event log.
 *   - Each call to /events?cursor=N returns all events AFTER N, plus
 *     the next cursor value to use on the following call.
 *   - Persisting the cursor means we resume exactly where we left off
 *     after an app restart — zero missed events, zero duplicate work.
 */
export class CursorSyncManager {
  private cursor: number = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onNotesChanged: (changed: string[], deleted: string[]) => Promise<void>;

  constructor(
    onNotesChanged: (changed: string[], deleted: string[]) => Promise<void>
  ) {
    this.onNotesChanged = onNotesChanged;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Restore the last cursor from persistent settings so we never
    // re-scan the entire database on restart.
    const saved = await joplin.settings.value(CURSOR_SETTING_KEY);
    this.cursor = typeof saved === "number" && saved > 0 ? saved : 0;

    // If this is the very first run, bootstrap the cursor to "now" so
    // we don't re-index the entire note history as "new changes."
    if (this.cursor === 0) {
      this.cursor = await this.fetchLatestCursor();
      await this.persistCursor(this.cursor);
    }

    // Run once immediately to catch any changes since last session.
    await this.poll();

    // Then poll on a timer as the 3rd-layer fallback (onNoteChange +
    // Events API cursor cover 99% of cases; polling is the safety net).
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Core polling logic ────────────────────────────────────────────────────

  /**
   * Fetches all events since the last stored cursor and calls
   * onNotesChanged with the categorised note IDs.
   *
   * Handles pagination: Joplin returns `has_more: true` when there are
   * more events to fetch. We drain all pages before persisting the new
   * cursor to ensure atomicity — if the app crashes mid-drain, we restart
   * from the last safe cursor.
   */
  async poll(): Promise<void> {
    const changed: Set<string> = new Set();
    const deleted: Set<string> = new Set();

    let currentCursor = this.cursor;
    let hasMore = true;

    try {
      while (hasMore) {
        const page = await this.fetchEventPage(currentCursor);

        for (const event of page.items) {
          // We only care about notes (item_type === 1).
          if (event.item_type !== ITEM_TYPE_NOTE) continue;

          if (event.type === EVENT_TYPE_DELETED) {
            deleted.add(event.id);
            changed.delete(event.id); // deleted wins over changed
          } else {
            if (!deleted.has(event.id)) {
              changed.add(event.id);
            }
          }
        }

        currentCursor = page.cursor;
        hasMore = page.has_more;
      }

      // Only persist the new cursor AFTER we've drained all pages.
      // If the callback throws, we do NOT advance the cursor so the
      // next poll will retry the same events.
      if (changed.size > 0 || deleted.size > 0) {
        await this.onNotesChanged(
          Array.from(changed),
          Array.from(deleted)
        );
      }

      // Persist after the callback succeeds.
      this.cursor = currentCursor;
      await this.persistCursor(this.cursor);

    } catch (err) {
      // Log but do not crash. The next poll will retry from the last
      // successfully persisted cursor.
      console.error("[CursorSyncManager] poll error:", err);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async fetchEventPage(cursor: number): Promise<EventPage> {
    const result = await joplin.data.get(["events"], {
      cursor,
      fields: ["id", "type", "item_type", "created_time"],
    });
    return result as EventPage;
  }

  /**
   * Bootstrap: fetch the latest cursor without processing events,
   * so first-run behaviour starts from "now."
   */
  private async fetchLatestCursor(): Promise<number> {
    let cursor = 0;
    let hasMore = true;

    // Fast-forward through all pages to get the tail cursor.
    while (hasMore) {
      const page = await this.fetchEventPage(cursor);
      cursor = page.cursor;
      hasMore = page.has_more;
    }

    return cursor;
  }

  private async persistCursor(cursor: number): Promise<void> {
    await joplin.settings.setValue(CURSOR_SETTING_KEY, cursor);
  }
}

// ─── Integration with the three-source sync architecture ─────────────────────
//
//  Source 1: onNoteChange() — fires immediately (~100ms) for the current note.
//  Source 2: CursorSyncManager — catches ALL changes after sync, restarts, etc.
//  Source 3: 5-minute polling fallback — built into CursorSyncManager above.
//
//  Together these three sources guarantee the index stays current regardless
//  of how notes are modified or which device they originate from.
//
// ─────────────────────────────────────────────────────────────────────────────

export async function registerIncrementalSync(
  indexNote: (noteId: string) => Promise<void>,
  removeNote: (noteId: string) => Promise<void>
): Promise<void> {

  // Source 1: fast path for the currently selected note.
  await joplin.workspace.onNoteChange(async ({ id }) => {
    try {
      await indexNote(id);
    } catch (err) {
      console.error("[onNoteChange] index error:", err);
    }
  });

  // Sources 2 + 3: cursor-based sync for everything else.
  const manager = new CursorSyncManager(async (changed, deleted) => {
    for (const id of deleted) {
      await removeNote(id);
    }
    for (const id of changed) {
      await indexNote(id);
    }
  });

  await manager.start();
}
