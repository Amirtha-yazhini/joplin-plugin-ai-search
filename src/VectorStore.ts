import * as fs from 'fs';
import * as path from 'path';

interface NoteVector {
	noteId: string;
	title: string;
	updatedTime: number;
	vector: number[];
}

export class VectorStore {
	private items: NoteVector[] = [];
	private dataPath: string;

	public constructor(storageDir: string) {
		this.dataPath = path.join(storageDir, 'ai_search_vectors.json');
	}

	public async initialize(): Promise<void> {
		if (fs.existsSync(this.dataPath)) {
			console.info('AI Search: Loading existing vectors...');
			const raw = fs.readFileSync(this.dataPath, 'utf8');
			this.items = JSON.parse(raw);
			console.info(`AI Search: Loaded ${this.items.length} vectors`);
		} else {
			console.info('AI Search: Starting with empty vector store');
			this.items = [];
		}
	}

	public async upsert(
		noteId: string,
		vector: number[],
		metadata: { noteId: string; title: string; updatedTime: number },
	): Promise<void> {
		// Remove existing entry for this note
		this.items = this.items.filter(item => item.noteId !== noteId);
		this.items.push({ ...metadata, vector });
		this.persist();
	}

	public async delete(noteId: string): Promise<void> {
		this.items = this.items.filter(item => item.noteId !== noteId);
		this.persist();
	}

	public async search(
		queryVector: number[],
		topK = 5,
	): Promise<Array<{ noteId: string; title: string; score: number }>> {
		if (this.items.length === 0) return [];

		const scored = this.items.map(item => ({
			noteId: item.noteId,
			title: item.title,
			score: this.cosineSimilarity(queryVector, item.vector),
		}));

		return scored
			.sort((a, b) => b.score - a.score)
			.slice(0, topK);
	}

	public getNoteCount(): number {
		return this.items.length;
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		let dot = 0;
		let normA = 0;
		let normB = 0;
		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}
		if (normA === 0 || normB === 0) return 0;
		return dot / (Math.sqrt(normA) * Math.sqrt(normB));
	}

	private persist(): void {
		fs.writeFileSync(this.dataPath, JSON.stringify(this.items), 'utf8');
	}
}