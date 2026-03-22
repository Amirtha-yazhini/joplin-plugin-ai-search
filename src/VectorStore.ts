import * as path from 'path';
import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hnswlib = require('hnswlib-node');

interface NoteMetadata {
	noteId: string;
	title: string;
	updatedTime: number;
}

interface VectorStoreData {
	metadata: Record<number, NoteMetadata>;
	nextId: number;
	noteIdToVectorId: Record<string, number>;
}

export class VectorStore {
	private index: any = null;
	private metadata: Record<number, NoteMetadata> = {};
	private nextId = 0;
	private noteIdToVectorId: Record<string, number> = {};
	private readonly dimensions = 384;
	private readonly maxElements = 10000;
	private indexPath: string;
	private dataPath: string;

	public constructor(storageDir: string) {
		this.indexPath = path.join(storageDir, 'ai_search.index');
		this.dataPath = path.join(storageDir, 'ai_search.json');
	}

	// Initialize or load existing index from disk
	public async initialize(): Promise<void> {
		this.index = new hnswlib.HierarchicalNSW('cosine', this.dimensions);

		if (fs.existsSync(this.indexPath) && fs.existsSync(this.dataPath)) {
			console.info('AI Search: Loading existing index from disk...');
			await this.index.readIndex(this.indexPath, this.maxElements);
			const raw = fs.readFileSync(this.dataPath, 'utf8');
			const data: VectorStoreData = JSON.parse(raw);
			this.metadata = data.metadata;
			this.nextId = data.nextId;
			this.noteIdToVectorId = data.noteIdToVectorId;
			console.info(`AI Search: Loaded ${this.nextId} note vectors`);
		} else {
			console.info('AI Search: Creating new index...');
			this.index.initIndex(this.maxElements);
		}
	}

	// Add or update a note's vector
	public async upsert(
		noteId: string,
		vector: number[],
		metadata: NoteMetadata,
	): Promise<void> {
		// If note already exists, reuse its vector ID
		let vectorId = this.noteIdToVectorId[noteId];
		if (vectorId === undefined) {
			vectorId = this.nextId++;
			this.noteIdToVectorId[noteId] = vectorId;
		}

		this.index.addPoint(vector, vectorId);
		this.metadata[vectorId] = metadata;
		await this.persist();
	}

	// Remove a note from the index
	public async delete(noteId: string): Promise<void> {
		const vectorId = this.noteIdToVectorId[noteId];
		if (vectorId === undefined) return;

		this.index.markDelete(vectorId);
		delete this.metadata[vectorId];
		delete this.noteIdToVectorId[noteId];
		await this.persist();
	}

	// Search for similar notes
	public async search(
		queryVector: number[],
		topK = 5,
	): Promise<Array<{ noteId: string; title: string; score: number }>> {
		if (this.nextId === 0) return [];

		const k = Math.min(topK, this.nextId);
		const result = this.index.searchKnn(queryVector, k);

		return result.neighbors
			.map((vectorId: number, i: number) => ({
				noteId: this.metadata[vectorId]?.noteId,
				title: this.metadata[vectorId]?.title,
				score: 1 - result.distances[i], // cosine similarity
			}))
			.filter((r: any) => r.noteId);
	}

	// Save index and metadata to disk
	private async persist(): Promise<void> {
		await this.index.writeIndex(this.indexPath);
		const data: VectorStoreData = {
			metadata: this.metadata,
			nextId: this.nextId,
			noteIdToVectorId: this.noteIdToVectorId,
		};
		fs.writeFileSync(this.dataPath, JSON.stringify(data), 'utf8');
	}

	public getNoteCount(): number {
		return this.nextId;
	}
}