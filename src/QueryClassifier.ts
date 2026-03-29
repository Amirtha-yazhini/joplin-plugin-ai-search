/**
 * QueryClassifier
 *
 * Decides which search engine(s) to invoke for a given query string.
 *
 * Routing table
 * ─────────────
 * • Joplin syntax tokens (notebook:, tag:, created:, AND/OR/NOT) → keyword only
 *   These are operator-based queries the user constructed deliberately; sending
 *   them to the semantic engine would produce nonsensical results.
 *
 * • 1–2 word queries → hybrid
 *   Short queries benefit from both engines: FTS4 handles exact matches while
 *   semantic catches near-synonyms.
 *
 * • Longer natural-language queries → semantic first, then hybrid
 *   The sweet spot for neural embeddings.
 *
 * This is a pure function module — no state, no side effects.
 */

export type SearchMode = "keyword" | "semantic" | "hybrid";

// ── Joplin search syntax tokens ───────────────────────────────────────────────

const KEYWORD_OPERATORS = [
  /\bnotebook:/i,
  /\btag:/i,
  /\bcreated:/i,
  /\bupdated:/i,
  /\btype:/i,
  /\blatitude:/i,
  /\blongitude:/i,
  /\bsource:/i,
  /\bany:/i,
  /\b(AND|OR|NOT)\b/,
  /-\w+/,        // negation: -word
  /"\w[^"]+"/,   // phrase search: "exact phrase"
];

// ── Classifier ────────────────────────────────────────────────────────────────

export interface ClassifierResult {
  mode:        SearchMode;
  reason:      string;
  queryTokens: number;
}

/**
 * Classify a search query into a routing mode.
 *
 * @param query  Raw text from the search input
 * @returns      { mode, reason, queryTokens }
 */
export function classifyQuery(query: string): ClassifierResult {
  const trimmed = query.trim();

  // 1. Detect Joplin search syntax → keyword engine only.
  for (const pattern of KEYWORD_OPERATORS) {
    if (pattern.test(trimmed)) {
      return {
        mode:        "keyword",
        reason:      `Joplin search operator detected (${pattern.source})`,
        queryTokens: estimateTokens(trimmed),
      };
    }
  }

  const tokens = estimateTokens(trimmed);

  // 2. Very short queries (1–2 words) → hybrid.
  if (tokens <= 2) {
    return {
      mode:        "hybrid",
      reason:      "Short query — hybrid covers both exact and semantic matches",
      queryTokens: tokens,
    };
  }

  // 3. Medium / long natural-language queries → semantic engine primary.
  //    Hybrid fallback is applied by SearchCoordinator when semantic returns
  //    fewer than MIN_RESULTS candidates.
  return {
    mode:        "semantic",
    reason:      "Natural language query — semantic engine primary",
    queryTokens: tokens,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Word count (not subword tokens — good enough for routing decisions). */
function estimateTokens(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}