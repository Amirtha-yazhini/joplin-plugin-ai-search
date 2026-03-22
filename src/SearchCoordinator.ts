import { EmbeddingService } from './EmbeddingService';
import { VectorStore } from './VectorStore';

export interface SearchResult {
	noteId: string;
	title: string;
	score: number;
	source: 'semantic' | 'keyword' | 'hybrid';
}

export class SearchCoordinator {
	private embeddingService: EmbeddingService;
	private vectorStore: VectorStore;

	public constructor(vectorStore: VectorStore) {
		this.embeddingService = EmbeddingService.getInstance();
		this.vectorStore = vectorStore;
	}

	// Decide if query should use semantic, keyword, or both engines
	private classifyQuery(query: string): 'semantic' | 'keyword' | 'hybrid' {
		const trimmed = query.trim();

		// Joplin search syntax tokens → keyword engine only
		const keywordPatterns = [
			/notebook:/i,
			/tag:/i,
			/created:/i,
			/updated:/i,
			/title:/i,
			/body:/i,
			/\bAND\b/,
			/\bOR\b/,
			/\bNOT\b/,
		];

		for (const pattern of keywordPatterns) {
			if (pattern.test(trimmed)) return 'keyword';
		}

		// Short queries (1-2 words) → hybrid
		const wordCount = trimmed.split(/\s+/).length;
		if (wordCount <= 2) return 'hybrid';

		// Longer natural language queries → semantic
		return 'semantic';
	}

	// Reciprocal Rank Fusion - merges two ranked lists into one
	private rrfMerge(
		semanticResults: SearchResult[],
		keywordResults: SearchResult[],
		k = 60,
	): SearchResult[] {
		const scores: Record<string, number> = {};
		const notes: Record<string, SearchResult> = {};

		semanticResults.forEach((r, i) => {
			scores[r.noteId] = (scores[r.noteId] || 0) + 1 / (k + i + 1);
			notes[r.noteId] = { ...r, source: 'hybrid' };
		});

		keywordResults.forEach((r, i) => {
			scores[r.noteId] = (scores[r.noteId] || 0) + 1 / (k + i + 1);
			notes[r.noteId] = notes[r.noteId] || { ...r, source: 'hybrid' };
		});

		return Object.entries(scores)
			.sort(([, a], [, b]) => b - a)
			.map(([noteId]) => ({ ...notes[noteId], score: scores[noteId] }));
	}

	// Main search entry point
	public async search(
		query: string,
		keywordResults: SearchResult[] = [],
		topK = 10,
	): Promise<SearchResult[]> {
		if (!query.trim()) return [];

		const queryType = this.classifyQuery(query);
		console.info(`AI Search: Query classified as "${queryType}"`);

		// Keyword only - return Joplin's existing results
		if (queryType === 'keyword') {
			return keywordResults;
		}

		// Get semantic results
		const queryVector = await this.embeddingService.embed(query);
		const semanticResults = (await this.vectorStore.search(queryVector, topK))
			.map(r => ({ ...r, source: 'semantic' as const }));

		// Semantic only
		if (queryType === 'semantic') {
			return semanticResults;
		}

		// Hybrid - merge both using RRF
		return this.rrfMerge(semanticResults, keywordResults);
	}

	public getQueryType(query: string) {
		return this.classifyQuery(query);
	}
}