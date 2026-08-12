// Server-only Postgres client (provider-agnostic postgres-js driver).
import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export class DbConfigError extends Error {}

export const getDatabaseUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new DbConfigError(
      "Missing required environment variable: DATABASE_URL. Add a PostgreSQL connection string to .env (any managed Postgres provider works), then run npm run db:migrate.",
    );
  }
  return url;
};

const globalForDb = globalThis as unknown as { vindexPostgres?: postgres.Sql };
const globalForDrizzle = globalThis as unknown as { vindexDrizzle?: ReturnType<typeof createDrizzle> };

function createDrizzle(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 4 });
  globalForDb.vindexPostgres = sql;
  return drizzle(sql, { schema });
}

export function getDb(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = getDatabaseUrl(env);
  if (!globalForDrizzle.vindexDrizzle) {
    globalForDrizzle.vindexDrizzle = createDrizzle(databaseUrl);
  }
  return globalForDrizzle.vindexDrizzle;
}

export type VindexDb = ReturnType<typeof getDb>;
