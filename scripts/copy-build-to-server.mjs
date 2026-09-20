/**
 * Copies this app's Vite build (dist/) into the server repo's public/ folder,
 * so the deployed Node server serves the dashboard at / alongside the API at
 * /api/*. The server repo COMMITS public/ - see its .gitignore - so the copy
 * has to be committed and pushed there before Render picks it up.
 *
 * Run via `npm run deploy:web` (which builds first). Override the destination
 * with SERVER_PUBLIC_DIR=../some/other/public.
 *
 * There is an older copy of this script one directory up, in the top-level
 * vibescreener-react/ folder. That folder is a dead local copy wired to
 * nothing, so its version builds source that is never deployed. This one is
 * the live app's, and is the one to use.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(projectRoot, 'dist');
const targetDir = path.resolve(
  projectRoot,
  process.env.SERVER_PUBLIC_DIR || path.join('..', 'Vibe-mm-server', 'public')
);

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('No build found at ' + distDir + '. Run `npm run build` first.');
  process.exit(1);
}

// Refuse to wipe a directory that is not the one we think it is. This script
// deletes everything at the target, and the default target is inside a
// different git repo - a mistyped SERVER_PUBLIC_DIR should not cost real work.
if (!fs.existsSync(targetDir)) {
  console.error('Target does not exist: ' + targetDir);
  console.error('Expected the server repo\'s public/ folder. Set SERVER_PUBLIC_DIR to override.');
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

// Clear stale assets (hashed filenames accumulate otherwise), keeping .gitkeep.
for (const entry of fs.readdirSync(targetDir)) {
  if (entry === '.gitkeep') continue;
  fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
}

fs.cpSync(distDir, targetDir, { recursive: true });

const count = fs.readdirSync(path.join(targetDir, 'assets'), { withFileTypes: true }).length;
console.log('Copied build -> ' + targetDir);
console.log('index.html + ' + count + ' asset file(s)');
console.log('Next: commit and push the Vibe-mm-server repo, then Render redeploys.');
