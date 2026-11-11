/**
 * Worker process: `npm run worker`.
 *
 * Migrates if needed, then polls the job queue until SIGINT/SIGTERM. Handler modules
 * register themselves on import, so every module that owns handlers must be imported
 * here (or from a shared handlers index) before the loop starts.
 */

import { getDb } from '../src/lib/db';
import { migrate } from '../src/lib/migrate';
import { runForever } from '../src/jobs/runner';
import { missingHandlers, unexpectedMissingHandlers } from '../src/jobs/registry';
import '../src/jobs/handlers';

async function main() {
  const db = await getDb();
  console.log(`backend: ${db.backend}`);
  const ran = await migrate(db);
  if (ran.length) console.log(`migrated ${ran.length} file(s)`);

  const unexpected = unexpectedMissingHandlers();
  if (unexpected.length) {
    // Not fatal, but it must be impossible to miss in the logs.
    console.error(`WARNING: no handler registered for: ${unexpected.join(', ')}`);
  }
  const notYet = missingHandlers().filter((t) => !unexpected.includes(t));
  if (notYet.length) console.log(`not yet implemented (jobs of these types will retry then die): ${notYet.join(', ')}`);

  const controller = new AbortController();
  const stop = (sig: string) => {
    console.log(`${sig} received, finishing current job...`);
    controller.abort();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  const intervalMs = Number.parseInt(process.env.WORKER_INTERVAL_MS ?? '', 10) || 5_000;
  await runForever({ intervalMs, signal: controller.signal, db });
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
