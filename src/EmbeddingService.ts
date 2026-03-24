// TF-IDF based embedding service
// Pure JavaScript - no native dependencies
// Future: replace with local neural embeddings (all-MiniLM-L6-v2)

export class EmbeddingService {
	private static instance: EmbeddingService;
	private vocabulary: Map<string, number> = new Map();
	private vocabSize = 512;

	public static getInstance(): EmbeddingService {
		if (!EmbeddingService.instance) {
			EmbeddingService.instance = new EmbeddingService();
		}
		return EmbeddingService.instance;
	}

	public async initialize(): Promise<void> {
		console.info('AI Search: TF-IDF embedding service ready');
	}

	// Convert text to a fixed-size TF-IDF vector
	public async embed(text: string): Promise<number[]> {
		const tokens = this.tokenize(text);
		const vector = new Array(this.vocabSize).fill(0);

		// Assign vocabulary indices
		for (const token of tokens) {
			if (!this.vocabulary.has(token)) {
				if (this.vocabulary.size < this.vocabSize) {
					this.vocabulary.set(token, this.vocabulary.size);
				}
			}
		}

		// Compute TF (term frequency)
		const tf: Map<string, number> = new Map();
		for (const token of tokens) {
			tf.set(token, (tf.get(token) || 0) + 1);
		}

		// Fill vector
		for (const [token, count] of tf.entries()) {
			const idx = this.vocabulary.get(token);
			if (idx !== undefined) {
				vector[idx] = count / tokens.length;
			}
		}

		// L2 normalize
		return this.normalize(vector);
	}

	public async embedBatch(
		texts: string[],
		onProgress?: (current: number, total: number) => void,
	): Promise<number[][]> {
		const results: number[][] = [];
		for (let i = 0; i < texts.length; i++) {
			results.push(await this.embed(texts[i]));
			if (onProgress) onProgress(i + 1, texts.length);
		}
		return results;
	}

	private tokenize(text: string): string[] {
		return text
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ')
			.split(/\s+/)
			.filter(t => t.length > 2);
	}

	private normalize(vector: number[]): number[] {
		const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
		if (norm === 0) return vector;
		return vector.map(v => v / norm);
	}
}