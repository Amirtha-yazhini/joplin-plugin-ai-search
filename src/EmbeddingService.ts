import { pipeline } from '@xenova/transformers';

export class EmbeddingService {
	private static instance: EmbeddingService;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
    private embedder: any = null;
	private modelName = 'Xenova/all-MiniLM-L6-v2';

	// Singleton - only one instance loads the model
	public static getInstance(): EmbeddingService {
		if (!EmbeddingService.instance) {
			EmbeddingService.instance = new EmbeddingService();
		}
		return EmbeddingService.instance;
	}

	// Load the model (downloads once, cached locally after)
	public async initialize(): Promise<void> {
		if (this.embedder) return;
		console.info('AI Search: Loading embedding model...');
		this.embedder = await pipeline('feature-extraction', this.modelName);
		console.info('AI Search: Model loaded successfully');
	}

	// Convert text into a vector of 384 numbers
	public async embed(text: string): Promise<number[]> {
		if (!this.embedder) await this.initialize();

		// Truncate to 512 tokens to stay within model limits
		const truncated = text.slice(0, 2000);

		const output = await this.embedder(truncated, {
			pooling: 'mean',
			normalize: true,
		});

		return Array.from(output.data as Float32Array);
	}

	// Embed multiple notes in batches
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
}