import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Finding E: `deref.ts` reads its bundled UCP schemas at runtime via
 * `new URL('./ucp/…', import.meta.url)`, but `tsc` does not copy `.json`. A BUILT
 * deploy must therefore ship the schemas NEXT TO the built `deref.js` — else every
 * typed handoff silently degrades to a raw escalation. This drives the real build
 * and asserts the artifacts are co-located. Lazy: one build, run serially.
 */
describe('npm run build — bundles the UCP schemas into dist (finding E)', () => {
  it('emits deref.js + its sibling ./ucp schemas at the dist root', () => {
    execFileSync('npm', ['run', 'build'], {
      cwd: repoRoot,
      stdio: 'pipe',
      shell: process.platform === 'win32', // npm is npm.cmd on Windows
    });

    // deref.js must land at dist/schema/deref.js (rootDir=src ⇒ dist root),
    // and its `./ucp` schemas must sit right beside it so `import.meta.url` resolves.
    const derefJs = fileURLToPath(new URL('../dist/schema/deref.js', import.meta.url));
    const checkoutSchema = fileURLToPath(
      new URL('../dist/schema/ucp/shopping/checkout.json', import.meta.url)
    );
    expect(existsSync(derefJs)).toBe(true);
    expect(existsSync(checkoutSchema)).toBe(true);

    // The entry point matches package.json main/bin/start (dist/index.js).
    const indexJs = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    expect(existsSync(indexJs)).toBe(true);
  }, 120_000);
});
