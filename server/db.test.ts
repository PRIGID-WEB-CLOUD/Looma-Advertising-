import test from 'node:test';
import assert from 'node:assert/strict';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { convertPlaceholdersToPg, getDb, shouldUsePostgresSsl, withTransaction } from './db';
import { POSTGRES_DRIZZLE_TABLES, POSTGRES_SCHEMA_DDL } from './db/drizzle-schema';
import * as schema from './db/schema';

test('convertPlaceholdersToPg converts ? outside quotes/comments and preserves ? inside strings, identifiers, and comments', () => {
  const sql = `
    SELECT id, name, 'why? ''quoted?'' literal' AS note, "col?name"
    FROM users -- ignore ? in line comment
    /* ignore ? and ? in block comment */
    WHERE email = ? AND status = ? AND count > ?
  `;
  const pgSql = convertPlaceholdersToPg(sql);
  assert.ok(pgSql.includes("'why? ''quoted?'' literal'"));
  assert.ok(pgSql.includes('"col?name"'));
  assert.ok(pgSql.includes('-- ignore ? in line comment'));
  assert.ok(pgSql.includes('/* ignore ? and ? in block comment */'));
  assert.ok(pgSql.includes('WHERE email = $1 AND status = $2 AND count > $3'));
  assert.ok(!pgSql.includes('$4'));
});

test('shouldUsePostgresSsl respects explicit sslmode and defaults SSL on for remote hosts', () => {
  assert.equal(shouldUsePostgresSsl('postgresql://postgres:pass@localhost:5432/looma'), false);
  assert.equal(shouldUsePostgresSsl('postgresql://postgres:pass@127.0.0.1:5432/looma'), false);
  assert.equal(shouldUsePostgresSsl('postgresql://postgres:pass@db.neon.tech:5432/looma'), true);
  assert.equal(shouldUsePostgresSsl('postgresql://postgres:pass@db.neon.tech:5432/looma?sslmode=disable'), false);
  assert.equal(shouldUsePostgresSsl('postgresql://postgres:pass@localhost:5432/looma?sslmode=require'), true);
});

test('Drizzle ORM PostgreSQL schema covers all 48 platform tables matching POSTGRES_DRIZZLE_TABLES and DDL', () => {
  const schemaTableNames = Object.values(schema)
    .filter((entry) => is(entry, PgTable))
    .map((table) => getTableName(table as PgTable));

  assert.equal(POSTGRES_DRIZZLE_TABLES.length, 48);
  assert.equal(schemaTableNames.length, 48);

  const schemaSet = new Set(schemaTableNames);
  for (const tableName of POSTGRES_DRIZZLE_TABLES) {
    assert.ok(schemaSet.has(tableName), `Missing Drizzle pgTable definition for ${tableName}`);
    assert.ok(
      POSTGRES_SCHEMA_DDL.includes(`CREATE TABLE IF NOT EXISTS ${tableName}`),
      `Missing DDL statement for ${tableName}`
    );
  }
});

test('DbClient transaction supports atomic commits, rollback on error, and nested SAVEPOINT isolation', async () => {
  const db = await getDb(':memory:');
  try {
    await withTransaction(db, async (tx) => {
      await tx.execute("INSERT INTO roles (id, name, description) VALUES ('role_test', 'tester', 'Outer test role')");

      await assert.rejects(
        async () => {
          await tx.transaction(async (nested) => {
            await nested.execute(
              "INSERT INTO roles (id, name, description) VALUES ('role_nested_abort', 'aborted', 'Nested rollback role')"
            );
            throw new Error('force_nested_rollback');
          });
        },
        /force_nested_rollback/
      );

      await tx.transaction(async (nestedOk) => {
        await nestedOk.execute(
          "INSERT INTO roles (id, name, description) VALUES ('role_nested_ok', 'saved', 'Nested commit role')"
        );
      });
    });

    const outer = await db.queryOne("SELECT id FROM roles WHERE id = 'role_test'");
    const nestedAborted = await db.queryOne("SELECT id FROM roles WHERE id = 'role_nested_abort'");
    const nestedCommitted = await db.queryOne("SELECT id FROM roles WHERE id = 'role_nested_ok'");

    assert.ok(outer);
    assert.equal(nestedAborted, undefined);
    assert.ok(nestedCommitted);
  } finally {
    await db.close();
  }
});
