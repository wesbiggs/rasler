import { watch } from 'node:fs/promises';
import { indexStaticRoot } from './static.js';

// Starts a recursive fs watcher for a single static root. Re-indexes the root
// after a 300 ms debounce whenever any file inside it changes.
function watchStaticRoot({ directory, ignore }, store, { maxHistory }) {
  let debounceTimer = null;

  (async () => {
    try {
      const watcher = watch(directory, { recursive: true });
      for await (const _ of watcher) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            const maslCid = await indexStaticRoot(directory, store, { maxHistory, ignore });
            if (maslCid) console.log(`Static root re-indexed: ${directory} → MASL ${maslCid}`);
            else console.warn(`Static root re-indexed but empty: ${directory}`);
          } catch (err) {
            console.error(`Failed to re-index static root ${directory}: ${err.message}`);
          }
        }, 300);
      }
    } catch (err) {
      if (err.code !== 'ABORT_ERR') {
        console.error(`Watcher error for ${directory}: ${err.message}`);
      }
    }
  })();
}

// Starts watchers for every static root that has watch: true.
export function startStaticRootWatchers(staticRoots, store, { maxHistory = null } = {}) {
  for (const root of staticRoots) {
    if (root.watch) watchStaticRoot(root, store, { maxHistory });
  }
}
