/**
 * EmbeddingService
 *
 * Wraps all-MiniLM-L6-v2 (via Transformers.js running in the panel webview)
 * behind a single `embed(text): Promise<number[]>` contract so the rest of
 * the plugin never has to know which backend is active.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  Why the panel webview?                             │
 * │  Native modules (onnxruntime-node, hnswlib-node)    │
 * │  cannot load inside Joplin's webpack plugin sandbox.│
 * │  The panel's Electron webview has full FS access,   │
 * │  so we load Transformers.js there instead.          │
 * │  Validated on Windows 11 during PoC development.    │
 * └─────────────────────────────────────────────────────┘
 */

import joplin from "api";

// ── Public contract ───────────────────────────────────────────────────────────

/** The only contract between EmbeddingService and the rest of the system. */
export interface IEmbeddingService {
  /** Returns a normalised embedding vector for the given text. */
  embed(text: string): Promise<number[]>;
  /** Dimensions of the output vector (384 for all-MiniLM-L6-v2). */
  readonly dimensions: number;
  /** True once the model has finished loading. */
  readonly isReady: boolean;
  /** Load / warm up the model. Must be called once before embed(). */
  init(): Promise<void>;
}

// ── Message protocol (main ↔ webview) ────────────────────────────────────────

interface EmbedRequest  { type: "EMBED_REQUEST";  id: string; text: string }
interface EmbedResponse { type: "EMBED_RESPONSE"; id: string; vector: number[] }
interface ReadyMessage  { type: "MODEL_READY" }
interface ErrorMessage  { type: "EMBED_ERROR";    id: string; message: string }

type PanelMessage = EmbedRequest | EmbedResponse | ReadyMessage | ErrorMessage;

// ── Implementation ────────────────────────────────────────────────────────────

export class TransformersEmbeddingService implements IEmbeddingService {
  readonly dimensions = 384; // all-MiniLM-L6-v2 output size

  private _isReady = false;
  get isReady() { return this._isReady; }

  /** Pending embed requests keyed by a random ID. */
  private pending = new Map<string, {
    resolve: (v: number[]) => void;
    reject:  (e: Error)    => void;
  }>();

  private panelId: string | null = null;
  private readyResolve: (() => void) | null = null;

  

  async init(): Promise<void> {
    if (this._isReady) return;

    // Create the panel that hosts Transformers.js.
    this.panelId = await joplin.views.panels.create("embedding_panel");
    await joplin.views.panels.setHtml(this.panelId, await this.buildPanelHtml());
    await joplin.views.panels.show(this.panelId, false); // hidden worker panel

    // Wait for the webview to signal MODEL_READY.
    await new Promise<void>((resolve) => {
      this.readyResolve = resolve;
      joplin.views.panels.onMessage(this.panelId!, (msg: PanelMessage) => {
        this.handleMessage(msg);
      });
    });
  }

  async embed(text: string): Promise<number[]> {
    if (!this._isReady) throw new Error("EmbeddingService not ready — call init() first");
    if (!this.panelId)  throw new Error("Panel not initialised");

    const id = Math.random().toString(36).slice(2);

    return new Promise<number[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: EmbedRequest = { type: "EMBED_REQUEST", id, text };
      joplin.views.panels.postMessage(this.panelId!, request);
    });
  }

  private handleMessage(msg: PanelMessage): void {
    switch (msg.type) {
      case "MODEL_READY":
        this._isReady = true;
        this.readyResolve?.();
        break;

      case "EMBED_RESPONSE": {
        const cb = this.pending.get(msg.id);
        if (cb) { cb.resolve(msg.vector); this.pending.delete(msg.id); }
        break;
      }

      case "EMBED_ERROR": {
        const cb = this.pending.get(msg.id);
        if (cb) { cb.reject(new Error(msg.message)); this.pending.delete(msg.id); }
        break;
      }
    }
  }

  /**
   * Build the panel HTML that bootstraps Transformers.js.
   * Model weights (model_quantized.onnx, tokenizer.json, config.json — 23MB)
   * are bundled inside the plugin package and served via the plugin's data dir.
   */
  private async buildPanelHtml(): Promise<string> {
    const dataDir = joplin.plugins.dataDir();
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<script type="module">
  // Transformers.js is bundled locally — no CDN, works fully offline.
  import { pipeline, env } from './transformers.min.js';

  // Point to the bundled model weights instead of HuggingFace Hub.
  env.localModelPath = '${dataDir}/models/';
  env.allowRemoteModels = false;

  let extractor;

  async function loadModel() {
    try {
      extractor = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        { quantized: true }
      );
      webviewApi.postMessage({ type: 'MODEL_READY' });
    } catch (err) {
      console.error('[EmbeddingService] model load failed:', err);
    }
  }

  webviewApi.onMessage(async (msg) => {
    if (msg.type !== 'EMBED_REQUEST') return;
    try {
      const output = await extractor(msg.text, { pooling: 'mean', normalize: true });
      webviewApi.postMessage({
        type: 'EMBED_RESPONSE',
        id: msg.id,
        vector: Array.from(output.data),
      });
    } catch (err) {
      webviewApi.postMessage({ type: 'EMBED_ERROR', id: msg.id, message: String(err) });
    }
  });

  loadModel();
</script>
</body>
</html>`;
  }
}