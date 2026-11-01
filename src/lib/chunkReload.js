// A deploy replaces the hashed chunks under /assets/. A tab opened before the
// deploy then asks for files that no longer exist and a lazy route fails to
// load. Reload once to pick up the new index.html. The guard is keyed by the
// running build (its entry script), so a reload that lands on the same build
// cannot loop; the route error boundary shows instead.
const RELOADED_BUILD_KEY = 'skyll.chunkReloadBuild';

function currentBuild(doc) {
  return doc.querySelector('script[type="module"][src]')?.getAttribute('src') || 'dev';
}

export function installChunkReload(win = window) {
  win.addEventListener('vite:preloadError', (event) => {
    const build = currentBuild(win.document);
    try {
      if (win.sessionStorage.getItem(RELOADED_BUILD_KEY) === build) return;
      win.sessionStorage.setItem(RELOADED_BUILD_KEY, build);
    } catch {
      return; // No storage, no loop guard: let the error surface.
    }
    event.preventDefault();
    win.location.reload();
  });
}
