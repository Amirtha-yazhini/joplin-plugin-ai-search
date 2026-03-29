import joplin from 'api';
import { SettingItemType } from 'api/types';
import { VectorStore } from './VectorStore';
import { SearchCoordinator, SearchResult } from './SearchCoordinator';

let vectorStore: VectorStore = null;
let searchCoordinator: SearchCoordinator = null;
let isIndexing = false;

joplin.plugins.register({
	onStart: async function() {
		console.info('AI Search: onStart called');
		try {
			const dataDir = await joplin.plugins.dataDir();
			const installDir = await joplin.plugins.installationDir();
			console.info('AI Search: installDir =', installDir);
			console.info('AI Search: dataDir =', dataDir);

			vectorStore = new VectorStore(dataDir);
			await vectorStore.initialize();
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
			});

			const panel = await joplin.views.panels.create('aiSearchPanel');

			// Pass installDir as a global variable into the panel HTML
			await joplin.views.panels.setHtml(panel, `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: sans-serif; padding: 10px; margin: 0; background: white; }
  #searchInput {
    width: 100%; padding: 8px; font-size: 14px;
    border: 1px solid #ccc; border-radius: 4px;
    box-sizing: border-box; margin-bottom: 6px;
  }
  #status {
    font-size: 11px; color: #666; padding: 4px;
    background: #f5f5f5; border-radius: 3px; margin-bottom: 6px;
    min-height: 18px;
  }
  #indexBtn {
    padding: 6px 12px; background: #1890ff; color: white;
    border: none; border-radius: 4px; cursor: pointer;
    width: 100%; font-size: 13px; margin-bottom: 6px;
  }
  #indexBtn:disabled { background: #ccc; cursor: not-allowed; }
  .result-item {
    padding: 8px; margin: 4px 0; border: 1px solid #eee;
    border-radius: 4px; cursor: pointer;
  }
  .result-item:hover { background: #f0f7ff; }
  .result-title { font-weight: bold; font-size: 13px; color: #1F4E79; }
  .result-score { font-size: 11px; color: #888; }
</style>
</head>
<body>
  <input id="searchInput" type="text" placeholder="Search notes in natural language..." />
  <div id="status">Loading AI model...</div>
  <button id="indexBtn" disabled>Index All Notes</button>
  <div id="results"></div>
  <script>
    // Install dir injected from plugin
    window.PLUGIN_INSTALL_DIR = ${JSON.stringify(installDir)};
  </script>
</body>
</html>`);

			// Add the search panel script which loads the model
			await joplin.views.panels.addScript(panel, 'searchPanel.js');
			await joplin.views.panels.show(panel);

			await joplin.views.panels.onMessage(panel, async (message) => {
				if (message.type === 'getNotes') {
					const notes = [];
					let page = 1;
					let hasMore = true;
					while (hasMore) {
						const result = await joplin.data.get(['notes'], {
							fields: ['id', 'title', 'body'],
							page,
						});
						notes.push(...result.items);
						hasMore = result.has_more;
						page++;
					}
					return notes;
				}
				if (message.type === 'storeVectors') {
					for (const item of message.vectors) {
						await vectorStore.upsert(item.noteId, item.vector, {
							noteId: item.noteId,
							title: item.title,
							updatedTime: Date.now(),
						});
					}
					return { success: true, count: vectorStore.getNoteCount() };
				}
				if (message.type === 'searchWithVector') {
					return await vectorStore.search(message.vector, 10);
				}
				if (message.type === 'openNote') {
					await joplin.commands.execute('openNote', message.noteId);
					return {};
				}
				if (message.type === 'getStatus') {
					return { noteCount: vectorStore.getNoteCount(), isIndexing };
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
				}
			});

			console.info('AI Search: plugin ready. installDir =', installDir);
		} catch (error) {
			console.error('AI Search plugin error:', error);
		}
	},
});