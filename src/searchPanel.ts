declare const webviewApi: { postMessage: (msg: any) => Promise<any> };

declare global {
  interface Window {
    PLUGIN_INSTALL_DIR: string;
  }
}

export {};

declare const window: any; // Temporary fallback if needed

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any = null;
let modelReady = false;
let searchTimeout: any = null;

function setStatus(text: string, color = '#666') {
	const el = document.getElementById('status');
	if (el) { el.textContent = text; el.style.color = color; }
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '<').replace(/>/g, '>');
}

function renderResults(results: any[]) {
	const container = document.getElementById('results');
	if (!results || results.length === 0) {
		container.innerHTML = '<p style="color:#888;font-size:12px;">No results found</p>';
		return;
	}
	container.innerHTML = results.map(r => `
		<div class="result-item" data-note-id="${r.noteId}">
			<div class="result-title">${escapeHtml(r.title || 'Untitled')}</div>
			<div class="result-score">Relevance: ${(r.score * 100).toFixed(0)}%</div>
		</div>
	`).join('');

	container.querySelectorAll('.result-item').forEach(el => {
		(el as HTMLElement).addEventListener('click', () => {
			webviewApi.postMessage({ type: 'openNote', noteId: (el as HTMLElement).dataset.noteId });
		});
	});
}

async function loadModel() {
	try {
		setStatus('Loading AI model...', '#1890ff');

		// Use the install dir passed from the plugin
		const installDir = (window as any).PLUGIN_INSTALL_DIR || '';
		// Convert Windows path to file:// URL
		const fileUrl = 'file:///' + installDir.replace(/\\/g, '/') + '/vendor/';
		console.info('AI Search panel: loading from', fileUrl);

		// Dynamically import transformers from local file
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const transformers = await import(fileUrl + 'transformers.min.js') as any;
		const { pipeline, env } = transformers;

		env.allowLocalModels = true;
		env.allowRemoteModels = false;
		env.localModelPath = fileUrl + 'model/';
		env.cacheDir = fileUrl + 'model/';

		setStatus('Model found, initialising...', '#1890ff');

		embedder = await pipeline(
			'feature-extraction',
			'Xenova/all-MiniLM-L6-v2',
			{
				local_files_only: true,
			}
		);

		modelReady = true;
		setStatus('AI model ready! Click "Index All Notes" to begin.', '#1a7340');
		const btn = document.getElementById('indexBtn') as HTMLButtonElement;
		if (btn) btn.disabled = false;

	} catch (err: any) {
		console.error('Model load error:', err);
		setStatus('Error loading model: ' + err.message, '#cc0000');
	}
}

async function embed(text: string): Promise<number[]> {
	const output = await embedder(text, { pooling: 'mean', normalize: true });
	return Array.from(output.data as Float32Array);
}

document.addEventListener('DOMContentLoaded', async () => {
	const searchInput = document.getElementById('searchInput') as HTMLInputElement;
	const indexBtn = document.getElementById('indexBtn') as HTMLButtonElement;

	searchInput.addEventListener('input', () => {
		clearTimeout(searchTimeout);
		const query = searchInput.value.trim();
		if (!query || !modelReady) return;

		searchTimeout = setTimeout(async () => {
			setStatus('Searching...', '#1890ff');
			try {
				const queryVector = await embed(query);
				const results = await webviewApi.postMessage({
					type: 'searchWithVector',
					query,
					vector: queryVector,
				});
				renderResults(results);
				setStatus(`${results.length} result(s) for "${query}"`, '#666');
			} catch (err: any) {
				setStatus('Search error: ' + err.message, '#cc0000');
			}
		}, 600);
	});

	indexBtn.addEventListener('click', async () => {
		if (!modelReady) return;
		indexBtn.disabled = true;
		setStatus('Fetching notes from Joplin...', '#1890ff');

		try {
			const notes = await webviewApi.postMessage({ type: 'getNotes' });
			setStatus(`Indexing ${notes.length} notes...`, '#1890ff');

			const indexed = [];
			for (let i = 0; i < notes.length; i++) {
				const note = notes[i];
				const text = `${note.title} ${note.body}`.slice(0, 2000);
				const vector = await embed(text);
				indexed.push({ noteId: note.id, title: note.title, vector });
				setStatus(`Indexing ${i + 1}/${notes.length}: ${note.title.slice(0, 25)}...`, '#1890ff');
			}

			const result = await webviewApi.postMessage({ type: 'storeVectors', vectors: indexed });
			setStatus(`Done! ${result.count} notes indexed. Try searching now!`, '#1a7340');
		} catch (err: any) {
			setStatus('Indexing error: ' + err.message, '#cc0000');
		} finally {
			indexBtn.disabled = false;
		}
	});

	// Start loading the model
	await loadModel();
});
