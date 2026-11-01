// Discovers every API entry point from the router sources themselves, so the
// role × school matrix guard (FLKRM-386) notices a new route without anyone
// remembering to register it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

/** Keys of a `const handlers = { ... };` literal (shorthand or 'quoted': value). */
function handlerKeys(source) {
  const block = source.match(/const handlers = \{([\s\S]*?)\n\};/)?.[1] ?? source.match(/const handlers = \{([^}]*)\}/)?.[1];
  if (!block) return [];
  return block.split(/[,\n]/).map((part) => part.trim()).filter(Boolean)
    .map((part) => part.replace(/:.*$/, '').replace(/['"]/g, '').trim())
    .filter((key) => /^[\w/-]+$/.test(key));
}

const quoted = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]);

export function discoverRoutes() {
  const routes = new Set();
  const add = (key) => routes.add(key);

  const auth = read('api/auth/[...route].js');
  handlerKeys(auth).forEach((key) => add(`auth/${key}`));
  quoted(auth, /subRoute === '([\w-]+)'/g).forEach((sub) => {
    const parent = auth.indexOf(`subRoute === '${sub}'`) > auth.indexOf("route === 'parent'") ? 'parent' : 'schools';
    add(`auth/${parent}/${sub}`);
  });
  if (/route === 'crm'/.test(auth)) add('auth/crm/*');

  handlerKeys(read('api/ai/[...route].js')).forEach((key) => add(`ai/${key}`));
  handlerKeys(read('api/intake/[...route].js')).forEach((key) => add(`intake/${key}`));
  quoted(read('api/images/[...route].js'), /kind === '([\w-]+)'/g).forEach((kind) => add(`images/${kind}`));

  const queue = read('api/vl-queue.js');
  const actions = queue.match(/SUPPORTED_ACTIONS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  quoted(actions, /'([\w-]+)'/g).forEach((action) => add(`vl-queue/${action}`));
  add('vl-queue/GET');

  // Every other serverless function file under api/ (each is a route of its own).
  const walk = (dir) => readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    if (name === '_lib' || name.startsWith('.')) return [];
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
  const routerFiles = new Set(['api/auth/[...route].js', 'api/ai/[...route].js', 'api/intake/[...route].js', 'api/images/[...route].js', 'api/vl-queue.js']);
  walk('api').filter((file) => file.endsWith('.js') && !routerFiles.has(file))
    .forEach((file) => add(file.replace(/^api\//, '').replace(/\.js$/, '')));
  return [...routes].sort();
}
