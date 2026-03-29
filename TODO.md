# TODO: Fix declare const window: any

## Steps:
- [x] Step 1: Edit tsconfig.json to add "lib": ["es2015", "dom"]
- [x] Step 2: Edit src/searchPanel.ts (removed declare window: any;, added declare global Window { PLUGIN_INSTALL_DIR }, export {}; used (window as any).PLUGIN_INSTALL_DIR as safe access)
- [ ] Step 3: Run npm run dist to rebuild and verify no errors
- [ ] Step 4: Complete task

