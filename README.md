# Joplin AI Search Plugin

> **GSoC 2026 Proof of Concept** — AI-powered semantic search for Joplin notes using local neural embeddings.

This plugin adds natural-language search to [Joplin](https://joplinapp.org/), allowing you to find notes by describing what you remember rather than recalling exact keywords.

---

## The Problem

Joplin's existing search is keyword-based. It works when you remember the exact words in a note — but fails when your memory is vague:

- *"the note about a meeting with a German company, 2019 or 2020"*
- *"the list of tasks I wrote for the website redesign"*
- *"something about poetry and the moon"*

None of these queries work with keyword search. This plugin solves that.

---

## How It Works

The plugin converts every note into a 384-dimensional vector using **all-MiniLM-L6-v2**, a lightweight sentence embedding model that runs entirely on your machine. When you search, your query is embedded the same way and the most semantically similar notes are returned — even if they share no keywords with your query.
```
"meeting with German company 2019"
        ↓ all-MiniLM-L6-v2 (local, private)
[0.21, -0.09, 0.44, ...]  ← 384-dim vector
        ↓ cosine similarity search
Top matching notes returned
```

**Everything runs locally. No data ever leaves your device.**

---

## Features

- **Natural language search** — describe what you're looking for in plain English
- **Hybrid ranking** — combines semantic similarity with Joplin's existing keyword search using Reciprocal Rank Fusion
- **Smart query routing** — automatically detects whether your query needs semantic, keyword, or hybrid search
- **Incremental indexing** — notes are re-indexed automatically when created or modified
- **Fully offline** — model weights are bundled with the plugin, no internet required after installation
- **Settings panel** — toggle hybrid mode, manage the index

---

## Architecture
```
src/
  index.ts            ← Plugin entry point, Joplin API integration
  EmbeddingService.ts ← Model loading, text chunking, vector generation
  VectorStore.ts      ← Cosine similarity index, disk persistence
  SearchCoordinator.ts← Query classification, RRF hybrid ranking
  searchPanel.ts      ← Panel UI event handling
  vendor/
    model/            ← Bundled all-MiniLM-L6-v2 model weights
      model_quantized.onnx
      tokenizer.json
      config.json
```

**Key technical decisions:**

- **Pure JavaScript vector store** — native modules (hnswlib-node, onnxruntime-node) cannot be loaded inside Joplin's plugin webpack sandbox. The vector store uses pure JS cosine similarity, making it cross-platform with no native dependencies.
- **Panel webview for inference** — Transformers.js runs in the panel's Electron webview context, bypassing the plugin sandbox constraint entirely.
- **Swappable embedding interface** — `embed(text): Promise<number[]>` is the only contract, so the backend can be replaced with a shared infrastructure layer in the future.

---

## Installation (Development)
```bash
git clone https://github.com/Amirtha-yazhini/joplin-plugin-ai-search.git
cd joplin-plugin-ai-search
npm install
npm run dist
```

Then in Joplin: **Tools → Options → Plugins → gear icon → Install from file** → select `publish/com.amirtha.joplin.ai-search.jpl`

---

## Usage

1. After installing, the **AI Search** panel appears on the right side of Joplin
2. Click **"Index All Notes"** — the plugin embeds all your notes (takes 1–2 minutes for large collections)
3. Type a natural language query in the search box
4. Results appear ranked by semantic relevance with a relevance score

---

## GSoC 2026 Context

This is a proof-of-concept built as part of my [GSoC 2026 application](https://discourse.joplinapp.org/t/gsoc-2026-proposal-draft-idea-1-ai-supported-search-for-notes-amirtha-yazhini-m/49348) for [Idea 1: AI-Supported Search for Notes](https://github.com/joplin/gsoc/blob/main/ideas/2026.md#1-ai-supported-search-for-notes).

The production implementation proposed for GSoC would add:
- Reranking for improved precision
- BM25 + vector hybrid scoring
- Query decomposition for complex queries
- A swappable interface compatible with the proposed shared embedding infrastructure
- Full test suite (unit, integration, regression)
- User and developer documentation

**Related Joplin contribution:** [PR #14865](https://github.com/laurent22/joplin/pull/14865) — Mobile: Fixes #14835: Upgrade react-native-popup-menu to remove deprecated SafeAreaView warning

---

## License

MIT