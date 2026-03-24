import joplin from 'api';
import { SettingItemType } from 'api/types';
import { VectorStore } from './VectorStore';
import { EmbeddingService } from './EmbeddingService';
import { SearchCoordinator, SearchResult } from './SearchCoordinator';

let vectorStore: VectorStore = null;
let searchCoordinator: SearchCoordinator = null;
let isIndexing = false;

joplin.plugins.register({
	onStart: async function() {
		console.info('AI Search: onStart called');
		try {
			const dataDir = await joplin.plugins.dataDir();
			console.info('AI Search: data dir:', dataDir);

			vectorStore = new VectorStore(dataDir);
			await vectorStore.initialize();
			console.info('AI Search: vector store ready');

			searchCoordinator = new SearchCoordinator(vectorStore);

			await joplin.settings.registerSection('aiSearch', {
				label: 'AI Search',
				iconName: 'fas fa-search',
			});

			await joplin.settings.registerSettings({
				'aiSearch.enabled': {
					value: true,
					type: SettingItemType.Bool,
					section: 'aiSearch',
					public: true,
					label: 'Enable AI-powered semantic search',
				},
				'aiSearch.hybridMode': {
					value: true,
					type: SettingItemType.Bool,
					section: 'aiSearch',
					public: true,
					label: 'Hybrid mode (combine semantic + keyword results)',
				},
			});

			const panel = await joplin.views.panels.create('aiSearchPanel');
			await joplin.views.panels.setHtml(panel, getSearchPanelHtml());
			await joplin.views.panels.addScript(panel, 'searchPanel.js');
			await joplin.views.panels.show(panel);

			await joplin.views.panels.onMessage(panel, async (message) => {
				if (message.type === 'search') {
					return await handleSearch(message.query);
				}
				if (message.type === 'indexAll') {
					return await indexAllNotes();
				}
				if (message.type === 'getStatus') {
					return {
						noteCount: await vectorStore.getNoteCount(),
						isIndexing,
					};
				}
			});

			await joplin.commands.register({
				name: 'aiSearch.togglePanel',
				label: 'Toggle AI Search Panel',
				execute: async () => {
					const visible = await joplin.views.panels.visible(panel);
					await joplin.views.panels.show(panel, !visible);
				},
			});

			await joplin.views.menuItems.create(
				'aiSearch.menuItem',
				'aiSearch.togglePanel',
				'tools' as any,
			);

			await joplin.workspace.onNoteChange(async (event: any) => {
				if (event.event === 3) {
					await vectorStore.delete(event.id);
				} else {
					setTimeout(async () => {
						await indexNote(event.id);
					}, 2000);
				}
			});

			console.info('AI Search: plugin ready');
		} catch (error) {
			console.error('AI Search plugin error:', error);
		}
	},
});

async function handleSearch(query: string): Promise<SearchResult[]> {
	if (!query || !searchCoordinator) return [];
	try {
		return await searchCoordinator.search(query, [], 10);
	} catch (error) {
		console.error('AI Search search error:', error);
		return [];
	}
}

async function indexNote(noteId: string): Promise<void> {
	try {
		const note = await joplin.data.get(['notes', noteId], {
			fields: ['id', 'title', 'body', 'updated_time'],
		});
		const text = `${note.title}\n${note.body}`;
		const embeddingService = EmbeddingService.getInstance();
		const vector = await embeddingService.embed(text);
		await vectorStore.upsert(noteId, vector, {
			noteId: note.id,
			title: note.title,
			updatedTime: note.updated_time,
		});
		console.info(`AI Search: indexed note "${note.title}"`);
	} catch (error) {
		console.error(`AI Search: failed to index note ${noteId}:`, error);
	}
}

async function indexAllNotes(): Promise<void> {
	if (isIndexing) return;
	isIndexing = true;
	console.info('AI Search: starting full index...');
	try {
		let page = 1;
		let hasMore = true;
		while (hasMore) {
			const result = await joplin.data.get(['notes'], {
				fields: ['id', 'title', 'body', 'updated_time'],
				page,
			});
			for (const note of result.items) {
				await indexNote(note.id);
			}
			hasMore = result.has_more;
			page++;
		}
		console.info('AI Search: full index complete');
	} finally {
		isIndexing = false;
	}
}

function getSearchPanelHtml(): string {
	return `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: sans-serif; padding: 10px; }
  #searchInput {
    width: 100%; padding: 8px; font-size: 14px;
    border: 1px solid #ccc; border-radius: 4px;
    box-sizing: border-box;
  }
  #results { margin-top: 10px; }
  .result-item {
    padding: 8px; margin: 4px 0;
    border: 1px solid #eee; border-radius: 4px;
    cursor: pointer;
  }
  .result-item:hover { background: #f5f5f5; }
  .result-title { font-weight: bold; font-size: 13px; }
  .result-score { font-size: 11px; color: #888; }
  #status { font-size: 11px; color: #666; margin-top: 5px; }
  #indexBtn {
    margin-top: 8px; padding: 6px 12px;
    background: #1890ff; color: white;
    border: none; border-radius: 4px; cursor: pointer;
    width: 100%;
  }
  #indexBtn:disabled { background: #ccc; }
</style>
</head>
<body>
  <input id="searchInput" type="text" placeholder="Search notes in natural language..." />
  <div id="status">Initialising...</div>
  <button id="indexBtn">Index All Notes</button>
  <div id="results"></div>
</body>
</html>`;
}