// This script runs inside the Joplin panel webview
// It handles user interactions and communicates with the plugin backend

// webviewApi is injected by Joplin at runtime in the panel webview
declare const webviewApi: {
	postMessage: (message: any) => Promise<any>;
};

let searchTimeout: any = null;

function debounce(fn: () => void, delay: number) {
	clearTimeout(searchTimeout);
	searchTimeout = setTimeout(fn, delay);
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
			<div class="result-score">
				${r.source} · relevance: ${(r.score * 100).toFixed(0)}%
			</div>
		</div>
	`).join('');

	// Click a result to open the note
	container.querySelectorAll('.result-item').forEach(el => {
		el.addEventListener('click', () => {
			const noteId = (el as HTMLElement).dataset.noteId;
			webviewApi.postMessage({ type: 'openNote', noteId });
		});
	});
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function setStatus(text: string) {
	const el = document.getElementById('status');
	if (el) el.textContent = text;
}

document.addEventListener('DOMContentLoaded', async () => {
	const searchInput = document.getElementById('searchInput') as HTMLInputElement;
	const indexBtn = document.getElementById('indexBtn') as HTMLButtonElement;

	// Get initial status
	const status = await webviewApi.postMessage({ type: 'getStatus' });
	setStatus(`${status.noteCount} notes indexed`);

	// Search as user types with 500ms debounce
	searchInput.addEventListener('input', () => {
		const query = searchInput.value.trim();
		if (!query) {
			document.getElementById('results').innerHTML = '';
			setStatus(`${status.noteCount} notes indexed`);
			return;
		}

		debounce(async () => {
			setStatus('Searching...');
			const results = await webviewApi.postMessage({
				type: 'search',
				query,
			});
			renderResults(results);
			setStatus(`${results.length} results for "${query}"`);
		}, 500);
	});

	// Index all notes button
	indexBtn.addEventListener('click', async () => {
		indexBtn.disabled = true;
		setStatus('Indexing all notes... this may take a while');
		await webviewApi.postMessage({ type: 'indexAll' });
		const newStatus = await webviewApi.postMessage({ type: 'getStatus' });
		setStatus(`Done! ${newStatus.noteCount} notes indexed`);
		indexBtn.disabled = false;
	});
});