/**
 * CursorSyncManager
 *
 * Tracks all note changes across the entire Joplin database using the
 * Events API cursor.  Unlike onNoteChange(), which only fires for the
 * currently selected note, this captures every create/update/delete
 * regardless of which note is active or where the change originated
 * (local edit, sync from another device, Joplin server, etc.).
 *
 * How the cursor works
 * ────────────────────
 * Joplin maintains a monotonically increasing event log.
 * Each call to GET /events?cursor=N returns all events AFTER N plus the
 * next cursor to use.  Persisting the cursor means we resume exactly where
 * we left off after a restart — zero missed events, zero duplicate work.
 *
 * Atomicity guarantee
 * ───────────────────
 * All pages are drained BEFORE the new cursor is persisted.  If the app
 * crashes mid-drain, the next startup retries from the last safe cursor.
 *
 * Three-source architecture
 * ─────────────────────────
 * Source 1: onNoteChange()   — fast path (~100ms), current note only
 * Source 2: CursorSyncManager — ALL changes, survives restart/sync
 * Source 3: 5-min poll        — safety net (built into this class)
 */

import joplin from "api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NoteEvent {
  id:           string;
  type:         number;  // 1=Created, 2=Updated, 3=Deleted
  item_type:    number;  // 1=Note — we filter on this
  item_id:      string;
  created_time: number;
}

interface EventPage {
  items:    NoteEvent[];
  has_more: boolean;
  cursor:   number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CURSOR_SETTING_KEY = "events_api_cursor";
const POLL_INTERVAL_MS   = 5 * 60 * 1000; // 5 minutes
const ITEM_TYPE_NOTE     = 1;
const EVENT_DELETED      = 3;

// ── CursorSyncManager ─────────────────────────────────────────────────────────

export class CursorSyncManager {
  private cursor: number = 0;
  private timer:  ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onChanged: (noteIds: string[]) => Promise<void>,
    private readonly onDeleted: (noteIds: string[]) => Promise<void>,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Restore last cursor — resume exactly where we left off.
    const saved = await joplin.settings.value(CURSOR_SETTING_KEY) as number | null;
    this.cursor  = (typeof saved === "number" && saved > 0) ? saved : 0;

    // First run: bootstrap cursor to "now" so we don't replay all history.
    if (this.cursor === 0) {
      this.cursor = await this.fastForwardCursor();
      await this.persistCursor(this.cursor);
    }

    // Catch anything that changed since last session.
    await this.poll();

    // Start the 5-minute polling fallback (Source 3).
    this.timer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ── Core poll ─────────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    const changed = new Set<string>();
    const deleted = new Set<string>();
    let   currentCursor = this.cursor;

    try {
      let hasMore = true;

      // Drain ALL pages before advancing the stored cursor (atomicity).
      while (hasMore) {
        const page = await this.fetchPage(currentCursor);

        for (const event of page.items) {
          if (event.item_type !== ITEM_TYPE_NOTE) continue;

          if (event.type === EVENT_DELETED) {
            deleted.add(event.item_id);
            changed.delete(event.item_id); // deleted wins
          } else {
            if (!deleted.has(event.item_id)) changed.add(event.item_id);
          }
        }

        currentCursor = page.cursor;
        hasMore       = page.has_more;
      }

      // Call handlers BEFORE persisting — if they throw, we retry next poll.
      if (deleted.size > 0) await this.onDeleted(Array.from(deleted));
      if (changed.size > 0) await this.onChanged(Array.from(changed));

      // Only advance cursor after successful processing.
      this.cursor = currentCursor;
      await this.persistCursor(this.cursor);

    } catch (err) {
      // Log but don't crash — next poll retries from last safe cursor.
      console.error("[CursorSyncManager] poll error:", err);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async fetchPage(cursor: number): Promise<EventPage> {
    return await joplin.data.get(["events"], {
      cursor,
      fields: ["id", "type", "item_type", "item_id", "created_time"],
    }) as EventPage;
  }

  /**
   * Fast-forward through all existing events to get the latest cursor
   * without processing them.  Used only on first-ever startup.
   */
  private async fastForwardCursor(): Promise<number> {
    let cursor  = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await this.fetchPage(cursor);
      cursor     = page.cursor;
      hasMore    = page.has_more;
    }
    return cursor;
  }

  private async persistCursor(cursor: number): Promise<void> {
    await joplin.settings.setValue(CURSOR_SETTING_KEY, cursor);
  }
}

// ── registerIncrementalSync — wires all three sources together ────────────────

/**
 * Register the full three-source incremental sync architecture.
 *
 * Source 1: onNoteChange() — fast path for the currently selected note.
 * Source 2 + 3: CursorSyncManager — all other changes + polling fallback.
 *
 * @param indexNote   Called when a note should be re-embedded
 * @param removeNote  Called when a note should be removed from the index
 */
export async function registerIncrementalSync(
  indexNote:  (noteId: string) => Promise<void>,
  removeNote: (noteId: string) => Promise<void>,
): Promise<CursorSyncManager> {

  // Source 1: immediate update for the note the user is currently editing.
  await joplin.workspace.onNoteChange(async ({ id }: { id: string }) => {
    try {
      await indexNote(id);
    } catch (err) {
      console.error("[IncrementalSync] onNoteChange error:", err);
    }
  });

  // Sources 2 + 3: catch everything else.
  const manager = new CursorSyncManager(
    async (noteIds) => {
      for (const id of noteIds) await indexNote(id);
    },
    async (noteIds) => {
      for (const id of noteIds) await removeNote(id);
    },
  );

  await manager.start();
  return manager;
}