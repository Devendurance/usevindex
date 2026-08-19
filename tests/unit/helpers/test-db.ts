// Isolated test database: creates a dedicated vindex_test database on the
// same Postgres server as DATABASE_URL, applies the committed migrations, and
// exposes a drizzle client. Skips gracefully when DATABASE_URL is absent.

import "dotenv/config";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "../../../db/schema";

export const hasDatabaseUrl = Boolean(process.env.DATABASE_URL?.trim());

type TestDb = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

let testDb: TestDb | null = null;

export async function getTestDb() {
  if (!hasDatabaseUrl) {
    throw new Error("DATABASE_URL is not set — cannot run database tests.");
  }
  if (testDb !== null) return testDb;

  // TEST_DATABASE_URL (if set) points at a server where a dedicated test
  // database can be created; otherwise derive it from DATABASE_URL. Managed
  // providers like Supabase do not allow CREATE DATABASE, so CI/dev setups
  // should set TEST_DATABASE_URL to a local Postgres with create privileges.
  const baseUrl = process.env.TEST_DATABASE_URL?.trim() ?? (process.env.DATABASE_URL as string);
  const databaseName = new URL(baseUrl).pathname.slice(1) || "vindex";
  const testDatabaseName = databaseName === "vindex" ? "vindex_test" : `${databaseName}_test`;

  const maintenanceUrl = new URL(baseUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = postgres(maintenanceUrl.toString(), { max: 1 });
  try {
    await maintenance.unsafe(`CREATE DATABASE ${testDatabaseName}`);
  } catch (error) {
    // Concurrent workers race to create the test database: the winner gets
    // "already exists", the losers hit the pg_database unique constraint.
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("already exists") && !message.includes("pg_database_datname_index")) {
      await maintenance.end();
      throw error;
    }
  }
  await maintenance.end();

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${testDatabaseName}`;
  const client = postgres(testUrl.toString(), { max: 4 });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  testDb = db;
  return db;
}

export async function closeTestDb(): Promise<void> {
  if (testDb === null) return;
  try {
    await testDb.$client.end();
  } catch {
    // ignore close errors
  }
  testDb = null;
}
