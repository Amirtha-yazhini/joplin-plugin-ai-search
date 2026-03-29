/**
 * Joplin AI Search Plugin — Entry Point
 *
 * Wires together all four layers:
 *   EmbeddingService → VectorStore → SearchCoordinator → SearchPanel
 *
 * Also registers settings, commands, and the three-source incremental sync.
 */

import joplin from "api";
import { MenuItemLocation, SettingItemType } from "api/types";
import { TransformersEmbeddingService } from "./EmbeddingService";
import { chunkNote } from "./chunker";
import { VectorStore } from "./VectorStore";
import { SearchCoordinator } from "./SearchCoordinator";
import { registerIncrementalSync } from "./sync/CursorSyncManager";

// ── Plugin lifecycle ──────────────────────────────────────────────────────────

joplin.plugins.register({
  onStart: async () => {
    await registerSettings();

    const embedder    = new TransformersEmbeddingService();
    const store       = new VectorStore();
    const coordinator = new SearchCoordinator(embedder, store);

    await store.init();

    // Initialise the embedding model in the background — don't block startup.
    embedder.init().then(() => {
      console.log("[AI Search] Embedding model ready");
    }).catch(err => {
      console.error("[AI Search] Embedding model failed to load:", err);
    });

    // ── Search panel ────────────────────────────────────────────────────────
    const panel = await joplin.views.panels.create("ai_search_panel");
    await joplin.views.panels.setHtml(panel, buildSearchPanelHtml());
    await joplin.views.panels.show(panel, false);

    await joplin.views.panels.onMessage(panel, async (msg) => {
      switch (msg.type) {
        case "SEARCH": {
          if (!embedder.isReady) {
            return { type: "SEARCH_ERROR", message: "Model still loading — please wait a moment." };
          }
          try {
            const hits = await coordinator.search(msg.query);
            return { type: "SEARCH_RESULTS", hits };
          } catch (err) {
            return { type: "SEARCH_ERROR", message: String(err) };
          }
        }
        case "OPEN_NOTE": {
          await joplin.commands.execute("openNote", msg.noteId);
          return;
        }
        case "MODEL_STATUS": {
          return { type: "MODEL_STATUS_RESPONSE", ready: embedder.isReady };
        }
      }
    });

    // ── Commands ────────────────────────────────────────────────────────────
    await joplin.commands.register({
      name:    "aiSearch.openPanel",
      label:   "AI Search",
      iconName: "fas fa-search",
      execute: async () => {
        const visible = await joplin.views.panels.visible(panel);
        await joplin.views.panels.show(panel, !visible);
      },
    });

    await joplin.views.menus.create("aiSearchMenu", "AI Search", [
      { commandName: "aiSearch.openPanel" },
      { commandName: "aiSearch.rebuildIndex" },
    ], MenuItemLocation.Tools);

    await joplin.commands.register({
      name:    "aiSearch.rebuildIndex",
      label:   "AI Search: Rebuild Index",
      execute: async () => {
        await store.clear();
        await buildFullIndex(embedder, store);
      },
    });

    // ── Incremental sync (three sources) ───────────────────────────────────
    await registerIncrementalSync(
      async (noteId) => {
        try {
          const note = await joplin.data.get(["notes", noteId], {
            fields: ["id", "title", "body"],
          });
          const chunks  = await chunkNote(noteId, note.title, note.body);
          const vectors = await Promise.all(chunks.map(c => embedder.embed(c.text)));
          await store.put(noteId, chunks, vectors);
        } catch (err) {
          console.error("[AI Search] index error for note", noteId, err);
        }
      },
      async (noteId) => {
        await store.remove(noteId);
      },
    );

    // ── Build full index on first run ───────────────────────────────────────
    if (store.noteCount === 0) {
      console.log("[AI Search] First run — building full index in background");
      buildFullIndex(embedder, store).catch(err => {
        console.error("[AI Search] Full index build failed:", err);
      });
    }
  },
});

// ── Full index build ──────────────────────────────────────────────────────────

/**
 * Batch-and-yield: process 10 notes, then yield to the event loop.
 * Partial progress persists to disk after each batch.
 * Safe to call multiple times — hash-based change detection is a no-op
 * for notes that haven't changed.
 */
async function buildFullIndex(
  embedder: TransformersEmbeddingService,
  store:    VectorStore,
): Promise<void> {
  // Wait for model to be ready before starting.
  if (!embedder.isReady) {
    await new Promise<void>(resolve => {
      const poll = setInterval(() => {
        if (embedder.isReady) { clearInterval(poll); resolve(); }
      }, 500);
    });
  }

  let page     = 1;
  let hasMore  = true;
  const BATCH  = 10;

  while (hasMore) {
    const response = await joplin.data.get(["notes"], {
      fields: ["id", "title", "body"],
      limit:  BATCH,
      page,
    });

    const notes: Array<{ id: string; title: string; body: string }> =
      response.items ?? [];
    hasMore = response.has_more;
    page++;

    for (const note of notes) {
      try {
        const chunks  = await chunkNote(note.id, note.title, note.body);
        const vectors = await Promise.all(chunks.map(c => embedder.embed(c.text)));
        await store.put(note.id, chunks, vectors);
      } catch (err) {
        console.error("[AI Search] chunk/embed error for note", note.id, err);
      }
    }

    // Yield to event loop between batches to keep Joplin responsive.
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  console.log(`[AI Search] Index complete — ${store.noteCount} notes, ${store.chunkCount} chunks`);
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function registerSettings(): Promise<void> {
  await joplin.settings.registerSection("aiSearch", {
    label:    "AI Search",
    iconName: "fas fa-search",
  });

  await joplin.settings.registerSettings({
    "aiSearch.hybridMode": {
      value:       true,
      type:        SettingItemType.Bool,
      section:     "aiSearch",
      public:      true,
      label:       "Hybrid mode (semantic + keyword)",
      description: "Combine neural embeddings with Joplin's built-in search for best results.",
    },
    "aiSearch.topK": {
      value:       10,
      type:        SettingItemType.Int,
      section:     "aiSearch",
      public:      true,
      label:       "Results per search",
      description: "Number of results shown in the search panel (5–20).",
    },
    // Internal: Events API cursor position (not shown in UI).
    "events_api_cursor": {
      value:   0,
      type:    SettingItemType.Int,
      section: "aiSearch",
      public:  false,
      label:   "Events API cursor (internal)",
    },
  });
}

// ── Search panel HTML ─────────────────────────────────────────────────────────

function buildSearchPanelHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root {
    --bg:      var(--joplin-background-color, #fff);
    --text:    var(--joplin-color, #333);
    --border:  var(--joplin-divider-color, #ddd);
    --accent:  var(--joplin-color-accent, #1a73e8);
    --sub:     var(--joplin-color2, #666);
    --card-bg: var(--joplin-background-color3, #f5f5f5);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 12px; }

  #search-input {
    width: 100%; padding: 8px 12px; border: 1px solid var(--border);
    border-radius: 6px; font-size: 14px; background: var(--bg); color: var(--text);
    outline: none;
  }
  #search-input:focus { border-color: var(--accent); }

  #status { font-size: 12px; color: var(--sub); margin-top: 6px; min-height: 18px; }

  #results { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }

  .result-card {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 12px; cursor: pointer; transition: border-color .15s;
  }
  .result-card:hover { border-color: var(--accent); }

  .card-title { font-weight: 600; font-size: 14px; color: var(--text); }
  .card-breadcrumb { font-size: 11px; color: var(--sub); margin-top: 2px; }
  .card-snippet { font-size: 12px; color: var(--sub); margin-top: 5px; line-height: 1.5;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  .card-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
  .card-score { font-size: 11px; color: var(--sub); }
  .badge { font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 600; }
  .badge-Semantic { background: #e8f0fe; color: #1a73e8; }
  .badge-Keyword  { background: #e6f4ea; color: #137333; }
  .badge-Hybrid   { background: #fce8e6; color: #c5221f; }
</style>
</head>
<body>
<input id="search-input" type="text" placeholder="Search notes…" autocomplete="off" />
<div id="status">Loading model…</div>
<div id="results"></div>

<script>
  const input   = document.getElementById('search-input');
  const status  = document.getElementById('status');
  const results = document.getElementById('results');
  let   debounce;

  // Check model status on load.
  webviewApi.postMessage({ type: 'MODEL_STATUS' }).then(r => {
    status.textContent = r.ready ? '' : 'Loading model…';
  });

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; status.textContent = ''; return; }
    status.textContent = 'Searching…';
    debounce = setTimeout(() => runSearch(q), 300);
  });

  async function runSearch(q) {
    const r = await webviewApi.postMessage({ type: 'SEARCH', query: q });
    if (r.type === 'SEARCH_ERROR') {
      status.textContent = r.message;
      results.innerHTML  = '';
      return;
    }
    status.textContent = r.hits.length === 0 ? 'No results.' : \`\${r.hits.length} results\`;
    results.innerHTML  = r.hits.map(renderCard).join('');

    // Attach click handlers.
    document.querySelectorAll('.result-card').forEach(card => {
      card.addEventListener('click', () => {
        webviewApi.postMessage({ type: 'OPEN_NOTE', noteId: card.dataset.noteId });
      });
    });
  }

  function renderCard(hit) {
    const score  = (hit.rrfScore * 100).toFixed(1);
    const crumb  = [hit.notebookPath, hit.headingPath].filter(Boolean).join(' › ');
    return \`<div class="result-card" data-note-id="\${hit.noteId}">
      <div class="card-title">\${esc(hit.title)}</div>
      \${crumb ? \`<div class="card-breadcrumb">\${esc(crumb)}</div>\` : ''}
      <div class="card-snippet">\${esc(hit.snippet)}</div>
      <div class="card-footer">
        <span class="card-score">Score \${score}</span>
        <span class="badge badge-\${hit.matchSignal}">\${hit.matchSignal}</span>
      </div>
    </div>\`;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
}