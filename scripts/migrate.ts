import { getDb } from '../src/lib/db';
import { migrate } from '../src/lib/migrate';

async function main() {
  const db = await getDb();
  console.log(`backend: ${db.backend}`);
  const ran = await migrate(db);
  console.log(ran.length ? `migrated ${ran.length} file(s)` : 'already up to date');
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
