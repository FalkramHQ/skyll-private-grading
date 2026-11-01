import { createClient } from '@libsql/client';
import { PRODUCTION_SCHEMA } from '../fixtures/productionSchema.js';

/** A fresh in-memory database with the full production schema and no rows. */
export async function createSchemaDatabase() {
  const db = createClient({ url: ':memory:' });
  await db.batch(PRODUCTION_SCHEMA.map((sql) => ({ sql })), 'write');
  return db;
}
