/**
 * Structure-Aware Markdown Chunker
 *
 * Splits a note body on H1/H2/H3 headings and prepends the note title +
 * full heading breadcrumb to every chunk before embedding.  This gives the
 * model rich topic context so "something about blocking ports" can match
 * a chunk titled "Linux Server Setup > Firewall".
 *
 * Rules
 * ─────
 * • Sections > MAX_TOKENS are split further on paragraph boundaries with
 *   OVERLAP_TOKENS of overlap so context is never lost at a boundary.
 * • Chunks < MIN_TOKENS (frontmatter, lone code fences) are skipped.
 * • Code block content is preserved — users often search for snippets.
 * • Clicking a result opens the note at the matched heading (anchor stored
 *   in chunk.headingAnchor).
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TOKENS     = 512; // hard cap per chunk sent to the model
const OVERLAP_TOKENS =  64; // overlap when splitting overlong sections
const MIN_TOKENS     =  20; // skip chunks shorter than this

// Very rough token estimator: 1 token ≈ 4 chars (works well for English prose)
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Chunk {
  /** Full text sent to the embedding model: "<title> > <heading path>: <body>" */
  text: string;
  /** Heading path for display in result cards, e.g. "PostgreSQL > Tuning" */
  headingPath: string;
  /** Anchor for in-note navigation (lowercased, spaces → dashes) */
  headingAnchor: string;
  /** SHA-256 hex hash of `text` — used for hash-based change detection */
  hash: string;
  /** Approximate token count */
  tokens: number;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Chunk a note into embedding-ready segments.
 *
 * @param noteId   Joplin note ID (stored in VectorStore metadata)
 * @param title    Note title — prepended to every chunk
 * @param body     Raw Markdown body of the note
 * @returns        Array of Chunk objects ready for embed()
 */
export async function chunkNote(
  noteId: string,
  title: string,
  body: string,
): Promise<Chunk[]> {
  const sections = splitOnHeadings(body);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const headingPath   = section.headingPath || title;
    const prefix        = `${title} > ${headingPath}: `;
    const fullText      = prefix + section.body.trim();

    if (estimateTokens(section.body) < MIN_TOKENS) continue;

    // Split overlong sections on paragraph boundaries.
    const segments = estimateTokens(fullText) > MAX_TOKENS
      ? splitOnParagraphs(prefix, section.body)
      : [fullText];

    for (const seg of segments) {
      if (estimateTokens(seg) < MIN_TOKENS) continue;
      chunks.push({
        text:          seg,
        headingPath,
        headingAnchor: toAnchor(section.headingText),
        hash:          await sha256(seg),
        tokens:        estimateTokens(seg),
      });
    }
  }

  return chunks;
}

// ── Heading splitter ──────────────────────────────────────────────────────────

interface Section {
  headingText: string;
  headingPath: string;
  body: string;
}

function splitOnHeadings(body: string): Section[] {
  // Match H1 / H2 / H3 headings.
  const HEADING_RE = /^(#{1,3})\s+(.+)$/m;
  const lines      = body.split("\n");
  const sections: Section[] = [];

  // Stack tracks ancestor headings for breadcrumb paths.
  const stack: { level: number; text: string }[] = [];

  let currentBody: string[] = [];
  let currentHeadingText    = "";
  let currentLevel          = 0;

  const flush = () => {
    if (currentBody.length > 0 || sections.length === 0) {
      const path = buildPath(stack, currentHeadingText);
      sections.push({
        headingText: currentHeadingText,
        headingPath: path,
        body: currentBody.join("\n"),
      });
    }
    currentBody = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    if (m) {
      flush();
      const level = m[1].length;
      const text  = m[2].trim();

      // Pop ancestors with same or deeper level off the stack.
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      stack.push({ level, text });

      currentHeadingText = text;
      currentLevel       = level;
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return sections;
}

function buildPath(
  stack: { level: number; text: string }[],
  current: string,
): string {
  const parts = stack.map(s => s.text);
  return parts.length > 0 ? parts.join(" > ") : current;
}

// ── Paragraph splitter (for overlong sections) ────────────────────────────────

function splitOnParagraphs(prefix: string, body: string): string[] {
  const paragraphs = body.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const segments: string[] = [];
  let current: string[] = [];
  let overlapBuffer: string[] = [];

  for (const para of paragraphs) {
    current.push(para);
    const fullSeg = prefix + current.join("\n\n");

    if (estimateTokens(fullSeg) >= MAX_TOKENS) {
      // Flush everything except the overlap buffer.
      if (current.length > 1) {
        const toFlush = current.slice(0, -1);
        segments.push(prefix + toFlush.join("\n\n"));
        // Keep the last OVERLAP_TOKENS worth of paragraphs for the next segment.
        overlapBuffer = buildOverlapBuffer(toFlush, OVERLAP_TOKENS);
        current = [...overlapBuffer, para];
      } else {
        // Single paragraph exceeds MAX_TOKENS — hard-split on sentences.
        segments.push(...splitOnSentences(prefix, para));
        current = [];
        overlapBuffer = [];
      }
    }
  }

  if (current.length > 0) {
    segments.push(prefix + current.join("\n\n"));
  }

  return segments;
}

function buildOverlapBuffer(paragraphs: string[], targetTokens: number): string[] {
  const buf: string[] = [];
  let tokens = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const t = estimateTokens(paragraphs[i]);
    if (tokens + t > targetTokens) break;
    buf.unshift(paragraphs[i]);
    tokens += t;
  }
  return buf;
}

function splitOnSentences(prefix: string, text: string): string[] {
  // Simple sentence boundary: split on ". " or ".\n"
  const sentences = text.split(/(?<=\.)\s+/);
  const segments: string[] = [];
  let current: string[] = [];

  for (const sentence of sentences) {
    current.push(sentence);
    if (estimateTokens(prefix + current.join(" ")) >= MAX_TOKENS) {
      if (current.length > 1) {
        segments.push(prefix + current.slice(0, -1).join(" "));
        current = [sentence];
      } else {
        // Sentence itself is too long — include as-is (model will truncate)
        segments.push(prefix + sentence);
        current = [];
      }
    }
  }
  if (current.length > 0) segments.push(prefix + current.join(" "));
  return segments;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function toAnchor(headingText: string): string {
  return headingText.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data     = encoder.encode(text);
  const hashBuf  = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}