/**
 * Vendor the official GOV.UK Design System assets.
 *
 * Copies the compiled CSS, JavaScript and fonts out of node_modules into
 * src/web/assets/vendor/, so the running app serves the real thing rather
 * than an approximation of it.
 *
 * Runs automatically after `npm install` (see the "prepare" script). If
 * govuk-frontend is not installed, this exits quietly and the app falls back
 * to the bundled stylesheet — the layout checks for the vendored file at
 * startup and picks whichever is present.
 *
 * Why vendor rather than serve from node_modules: the container image does not
 * ship node_modules (there are no runtime dependencies), so the assets have to
 * be part of the source tree to survive the build.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(root, 'node_modules', 'govuk-frontend', 'dist', 'govuk');
const dest = path.join(root, 'src', 'web', 'assets', 'vendor');

if (!existsSync(pkg)) {
  console.log('govuk-frontend not installed — the app will use its bundled stylesheet.');
  console.log('Run `npm install` to vendor the official assets.');
  process.exit(0);
}

function copyDir(from, to, filter = () => true) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (statSync(src).isDirectory()) copyDir(src, dst, filter);
    else if (filter(name)) copyFileSync(src, dst);
  }
}

mkdirSync(dest, { recursive: true });

// Compiled stylesheet and script.
for (const file of ['govuk-frontend.min.css', 'govuk-frontend.min.js']) {
  const src = path.join(pkg, file);
  if (existsSync(src)) copyFileSync(src, path.join(dest, file));
}

// Fonts and images the stylesheet references by relative path.
for (const dir of ['assets/fonts', 'assets/images']) {
  const src = path.join(pkg, dir);
  if (existsSync(src)) copyDir(src, path.join(dest, dir));
}

const vendored = readdirSync(dest);
console.log(`Vendored GOV.UK Frontend into src/web/assets/vendor (${vendored.length} entries).`);
