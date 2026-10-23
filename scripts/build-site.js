#!/usr/bin/env node
// Assemble the static site in _site/ (same layout as scripts/serve-web.js).
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const out = join(root, '_site');
await rm(out, { recursive: true, force: true });
await cp(join(root, 'web'), out, { recursive: true });
// src/index.js is the Node entry point (sharp, fs); the page only loads src/core.js.
await cp(join(root, 'src'), join(out, 'src'), { recursive: true, filter: (f) => !f.endsWith('index.js') });
await mkdir(join(out, 'vendor'));
await cp(join(root, 'node_modules/jsnes/dist/jsnes.min.js'), join(out, 'vendor/jsnes.min.js'));
await cp(join(root, 'node_modules/jsnes/LICENSE'), join(out, 'vendor/jsnes-LICENSE.txt'));
console.log(`Built ${out}`);
