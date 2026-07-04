/**
 * Copy the bundled UCP JSON schemas into `dist` after `tsc`.
 *
 * `src/schema/deref.ts` reads `src/schema/ucp/*.json` at runtime via
 * `new URL('./ucp/…', import.meta.url)`, but `tsc` only emits `.js` — it does NOT
 * copy `.json`. Without this step a BUILT deploy (`dist/schema/deref.js`) finds no
 * schemas and every typed handoff silently degrades to a raw escalation. Emitting
 * with rootDir `src` puts deref.js at `dist/schema/deref.js`, so its `./ucp` sits at
 * `dist/schema/ucp` — exactly where we copy to. Lazy, cross-platform, zero deps.
 */
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const src = fileURLToPath(new URL('../src/schema/ucp', import.meta.url));
const dest = fileURLToPath(new URL('../dist/schema/ucp', import.meta.url));

cpSync(src, dest, { recursive: true });

// Self-check: the entry-point schema must be co-located with the built deref.js.
const sentinel = fileURLToPath(new URL('../dist/schema/ucp/shopping/checkout.json', import.meta.url));
if (!existsSync(sentinel)) {
  throw new Error(`copy-schemas: expected ${sentinel} to exist after copy`);
}
console.log(`[copy-schemas] copied UCP schemas → ${dest.replace(repoRoot, '')}`);
