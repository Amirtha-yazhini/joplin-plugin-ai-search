/**
 * SearchCoordinator
 *
 * Orchestrates the full search pipeline:
 *   1. Classify the query (keyword / semantic / hybrid)
 *   2. Dispatch to the appropriate engine(s)
 *   3. Merge results with Reciprocal Rank Fusion (RRF, k=60)
 *   4. Return ranked SearchHit[] to the UI
 *
 * RRF formula: score(d) = Σ 1 / (k + rank(d))
 *
 * Why RRF?
 * ────────
 * FTS4 returns BM25-style scores; cosine similarity returns values in [0,1].
 * These scales are incompatible — you can't simply add them.  RRF is rank-based,
 * so it works with any two ranked lists regardless of their scoring scale.
 * It is proven in production search systems (Elasticsearch, Azure AI Search).
 */

import joplin from "api";
import type { IEmbeddingService } from "./EmbeddingService";
import type { VectorStore, SearchResult } from "./VectorStore";
import { classifyQuery } from "./QueryClassifier";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchHit {
  noteId:        string;
  title:         string;
  notebookPath:  string;
  headingPath:   string;
  headingAnchor: string;
  snippet:       string;
  rrfScore:      number;
  matchSignal:   "Semantic" | "Keyword" | "Hybrid";
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RRF_K           = 60;   // standard RRF constant — higher = smoother blend
const TOP_K_SEMANTIC  = 20;   // candidates fetched from vector store
const TOP_K_KEYWORD   = 20;   // candidates fetched from Joplin FTS4
const TOP_K_RESULTS   = 10;   // final results returned to UI
const MIN_RESULTS     = 3;    // if semantic returns fewer, fall back to hybrid

// ── SearchCoordinator ─────────────────────────────────────────────────────────

export class SearchCoordinator {
  constructor(
    private readonly embedder:   IEmbeddingService,
    private readonly store:      VectorStore,
  ) {}

  /**
   * Run a search query and return ranked results.
   *
   * @param query  Raw text from the search input
   * @returns      Up to TOP_K_RESULTS hits, sorted by RRF score descending
   */
  async search(query: string): Promise<SearchHit[]> {
    const { mode } = classifyQuery(query);

    let semanticResults: SearchResult[] = [];
    let keywordNoteIds:  string[]       = [];

    // ── Semantic engine ──────────────────────────────────────────────────────
    if (mode === "semantic" || mode === "hybrid") {
      try {
        const queryVector = await this.embedder.embed(query);
        semanticResults   = this.store.query(queryVector, TOP_K_SEMANTIC);

        // If semantic returns too few results, fall back to hybrid.
        if (semanticResults.length < MIN_RESULTS && mode === "semantic") {
          keywordNoteIds = await this.runKeywordSearch(query);
        }
      } catch (err) {
        console.error("[SearchCoordinator] semantic search failed:", err);
        // Degrade gracefully to keyword-only.
        keywordNoteIds = await this.runKeywordSearch(query);
      }
    }

    // ── Keyword engine (Joplin FTS4 via Data API) ────────────────────────────
    if (mode === "keyword" || mode === "hybrid" || keywordNoteIds.length === 0) {
      keywordNoteIds = await this.runKeywordSearch(query);
    }

    // ── Determine match signal for UI badge ──────────────────────────────────
    const hasKeyword  = keywordNoteIds.length > 0;
    const hasSemantic = semanticResults.length > 0;
    const matchSignal: SearchHit["matchSignal"] =
      hasKeyword && hasSemantic ? "Hybrid"
      : hasSemantic             ? "Semantic"
      :                           "Keyword";

    // ── RRF fusion ───────────────────────────────────────────────────────────
    const merged = rrfMerge(
      semanticResults.map(r => r.noteId),
      keywordNoteIds,
    );

    // ── Hydrate with note metadata ───────────────────────────────────────────
    const hits = await this.hydrateResults(merged, semanticResults, matchSignal);
    return hits.slice(0, TOP_K_RESULTS);
  }

  // ── Keyword search via Joplin Data API ────────────────────────────────────

  private async runKeywordSearch(query: string): Promise<string[]> {
    try {
      const response = await joplin.data.get(["search"], {
        query,
        fields: ["id"],
        limit:  TOP_K_KEYWORD,
      });
      return (response.items ?? []).map((item: { id: string }) => item.id);
    } catch (err) {
      console.error("[SearchCoordinator] keyword search failed:", err);
      return [];
    }
  }

  // ── Hydrate results with titles, snippets, notebook paths ─────────────────

  private async hydrateResults(
    rankedNoteIds: Map<string, number>,
    semanticResults: SearchResult[],
    matchSignal: SearchHit["matchSignal"],
  ): Promise<SearchHit[]> {
    const semanticByNoteId = new Map<string, SearchResult>();
    for (const r of semanticResults) {
      if (!semanticByNoteId.has(r.noteId)) {
        semanticByNoteId.set(r.noteId, r);
      }
    }

    const hits: SearchHit[] = [];

    for (const [noteId, rrfScore] of rankedNoteIds) {
      try {
        const note = await joplin.data.get(["notes", noteId], {
          fields: ["id", "title", "body", "parent_id"],
        });
        const notebookPath  = await this.getNotebookPath(note.parent_id);
        const semantic      = semanticByNoteId.get(noteId);
        const snippet       = extractSnippet(note.body, semantic?.headingPath);

        hits.push({
          noteId,
          title:         note.title,
          notebookPath,
          headingPath:   semantic?.headingPath   ?? "",
          headingAnchor: semantic?.headingAnchor ?? "",
          snippet,
          rrfScore,
          matchSignal,
        });
      } catch {
        // Note may have been deleted since the index was built — skip.
      }
    }

    return hits;
  }

  private notebookCache = new Map<string, string>();

  private async getNotebookPath(folderId: string): Promise<string> {
    if (this.notebookCache.has(folderId)) return this.notebookCache.get(folderId)!;

    try {
      const folder = await joplin.data.get(["folders", folderId], {
        fields: ["id", "title", "parent_id"],
      });
      const parent = folder.parent_id
        ? await this.getNotebookPath(folder.parent_id)
        : "";
      const path = parent ? `${parent} > ${folder.title}` : folder.title;
      this.notebookCache.set(folderId, path);
      return path;
    } catch {
      return "";
    }
  }
}

// ── RRF merge ─────────────────────────────────────────────────────────────────

/**
 * Merge two ranked lists using Reciprocal Rank Fusion.
 *
 * @param semanticIds  Note IDs ranked by cosine similarity (best first)
 * @param keywordIds   Note IDs ranked by FTS4 score (best first)
 * @returns            Map<noteId, rrfScore> sorted descending
 */
function rrfMerge(
  semanticIds: string[],
  keywordIds:  string[],
): Map<string, number> {
  const scores = new Map<string, number>();

  const addList = (ids: string[]) => {
    ids.forEach((id, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  };

  addList(semanticIds);
  addList(keywordIds);

  return new Map([...scores.entries()].sort((a, b) => b[1] - a[1]));
}

// ── Snippet extraction ────────────────────────────────────────────────────────

/**
 * Extract a short display snippet from the note body.
 * If headingPath is given, find the matching section and return its opening text.
 * Falls back to the first non-empty paragraph.
 */
function extractSnippet(body: string, headingPath?: string): string {
  const MAX_SNIPPET = 200;

  if (headingPath) {
    const lastHeading   = headingPath.split(" > ").pop() ?? "";
    const headingEscape = lastHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingRe     = new RegExp(`^#{1,3}\\s+${headingEscape}`, "im");
    const match         = body.match(headingRe);
    if (match && match.index !== undefined) {
      const after = body.slice(match.index + match[0].length).trim();
      const snippet = after.split("\n").find(l => l.trim().length > 10) ?? after;
      return cleanSnippet(snippet, MAX_SNIPPET);
    }
  }

  // Fall back to first non-empty, non-heading paragraph.
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 10 && !trimmed.startsWith("#")) {
      return cleanSnippet(trimmed, MAX_SNIPPET);
    }
  }

  return body.slice(0, MAX_SNIPPET);
}

function cleanSnippet(text: string, maxLen: number): string {
  return text
    .replace(/[*_`#[\]]/g, "")  // strip Markdown formatting
    .slice(0, maxLen)
    .trim()
    + (text.length > maxLen ? "…" : "");
}