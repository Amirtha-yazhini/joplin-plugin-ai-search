# Joplin AI Search Plugin — GSoC 2026 PoC

> **Status: Proof of Concept** — Built to validate technical risks before the GSoC 2026 proposal deadline. Every architectural claim in the [proposal](https://summerofcode.withgoogle.com/) is backed by real code in this repo.

A Joplin plugin that adds **semantic / hybrid search** to your notes using local neural embeddings — no cloud API required, no data leaves your machine.

## What This Solves

Joplin's built-in FTS4 search fails on four real scenarios:

| Query type | FTS4 result | This plugin |
|---|---|---|
| `restart postgres` | ❌ misses "PostgreSQL service management" | ✅ finds it |
| `how to deploy a container` | ❌ misses "Docker setup guide" | ✅ finds it |
| Key sentence buried in 2,000-word note | ❌ diluted by term frequency | ✅ chunk-level match |
| `that linux note about blocking ports` | ❌ unsearchable | ✅ matches firewall/iptables semantically |

## Architecture

```
EmbeddingService  →  VectorStore  →  SearchCoordinator  →  SearchPanel
(Transformers.js)    (pure JS         (RRF hybrid            (React UI /
 in webview)          cosine sim)      ranking)               webview)
```

Joplin core is untouched. Only official plugin APIs are used: `joplin.views.panels`, `joplin.data`, `joplin.settings`, `joplin.workspace`.

## Key Technical Validations (PoC Findings)

### ✅ Embedding runtime: Transformers.js in panel webview
Native modules (`onnxruntime-node`, `hnswlib-node`) cannot load inside Joplin's webpack plugin sandbox. Solution: bundle model weights directly into the plugin and run Transformers.js in the panel's Electron webview, which has full filesystem access. Validated on Windows — fully offline, no native deps, no CSP issues.

### ✅ Model: all-MiniLM-L6-v2
384 dimensions, 22MB quantized, 256 token context. Small enough to bundle, fast enough for interactive search on CPU. Embed time ~80ms per chunk on Intel Core i5.

### ✅ Incremental sync: three-source architecture
`onNoteChange()` only fires for the currently selected note. Production sync uses:
1. `onNoteChange()` — fast path (~100ms) for the current note
2. Events API cursor — catches ALL changes after sync or restart (see `src/sync/`)
3. 5-minute polling fallback — safety net for any edge case

### ✅ Structure-aware chunking
Notes split on Markdown H1/H2/H3 headings. Note title + full heading path prepended to each chunk before embedding, giving the model topic context. Sections > 512 tokens split further on paragraph boundaries with 64-token overlap.

### ✅ Hybrid ranking: RRF fusion
Reciprocal Rank Fusion (k=60) merges semantic results with Joplin's FTS4 via Data API. Rank-based — no score normalisation needed across incompatible FTS4 and cosine similarity scales.

## Source Layout

```
src/
  index.ts              # Plugin entry point, command registration
  embedding/
    EmbeddingService.ts # Transformers.js wrapper, embed(text) interface
    chunker.ts          # Markdown heading-aware chunker
  store/
    VectorStore.ts      # Pure JS cosine similarity, JSON persistence
  search/
    SearchCoordinator.ts # Query classifier + RRF fusion
    QueryClassifier.ts  # Routes to semantic / keyword / hybrid engine
  sync/
    CursorSyncManager.ts # Events API cursor incremental sync
  ui/
    SearchPanel.tsx     # React search panel (result cards, breadcrumbs)
    panel.html          # Webview host for Transformers.js + React
```

## Running the PoC

```bash
npm install
npm run build
# Load the plugin in Joplin: Tools → Options → Plugins → Install from file → select dist/*.jpl
```

Requires Joplin Desktop ≥ 2.14. Tested on Windows 11, Ubuntu 22.04.

## Branches

| Branch | Purpose |
|---|---|
| `main` | Stable PoC — core embedding + search working |
| `events-cursor` | Events API cursor incremental sync implementation |
| `rrf-hybrid` | Hybrid ranking with Joplin FTS4 integration |

## Performance (measured on Intel Core i5, 8GB RAM)

| Collection | Index time | Query latency (P50) | Storage |
|---|---|---|---|
| 100 notes | ~20s | <400ms | ~0.6MB |
| 500 notes | ~90s | <600ms | ~3MB |
| 1,000 notes | ~3min | <600ms | ~6MB |

## GSoC 2026 Context

This PoC was built to validate the proposal *"AI-Supported Search for Notes"* for [Joplin](https://joplinapp.org/) in GSoC 2026. The production plugin will add:
- Evaluation report: Recall@5 ≥ 0.80, MRR ≥ 0.70 against a 500-note test corpus
- Full settings panel with swappable embedding backends
- MCP tool schema definitions (`search_notes`, `query_embeddings`)
- Contributor's Guide for adding new vector backends

**Proposal author:** Amirtha Yazhini M • amirthayazhini.m@gmail.com  
**PR in Joplin core:** [#14865](https://github.com/laurent22/joplin/pull/14865)