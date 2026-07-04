/**
 * demo/mint-admin-key.ts — mint the FIRST AgentGate admin API key.
 *
 * The first admin key is a chicken-and-egg: creating a key via the API needs an
 * existing admin key. So we mint it directly into the SQLite DB by importing the
 * AgentGate server's OWN built modules (dist/db + dist/lib/api-keys). This must
 * run while the server is DOWN (it opens the same DB file and runs migrations),
 * then the server starts against the seeded DB.
 *
 * Config (env):
 *   AGENTGATE_SERVER_DIR  path to packages/server (contains dist/ + drizzle/)
 *   DATABASE_URL          sqlite file path for the AgentGate DB (required)
 *   DB_DIALECT            forced to sqlite
 *
 * Output: the agk_ admin key on stdout (single line).
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const SERVER_DIR =
  process.env.AGENTGATE_SERVER_DIR ??
  'C:/Users/amitp/projects/agentkitai/agentgate/packages/server';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  process.env.DB_DIALECT = 'sqlite';

  const dbModUrl = pathToFileURL(resolve(SERVER_DIR, 'dist/db/index.js')).href;
  const keysModUrl = pathToFileURL(resolve(SERVER_DIR, 'dist/lib/api-keys.js')).href;

  // Importing dist/db/index.js runs initSqliteSync() at module load: it opens
  // DATABASE_URL and applies migrations. We then re-run migrations explicitly so
  // any failure is loud (the sync path swallows migration errors).
  const db = (await import(dbModUrl)) as { runMigrations: () => Promise<void> };
  await db.runMigrations();

  const keys = (await import(keysModUrl)) as {
    createApiKey: (name: string, scopes: string[]) => Promise<{ id: string; key: string }>;
  };
  const { key } = await keys.createApiKey('demo-admin (bootstrap)', [
    'admin',
    'request:create',
    'request:read',
    'request:decide',
  ]);

  process.stdout.write(key + '\n');
}

main().catch((err) => {
  process.stderr.write(`[mint] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
