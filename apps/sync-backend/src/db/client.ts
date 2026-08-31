import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Env } from "../env.js";
import * as schema from "./schema.js";

export function createDb(env: Pick<Env, "DATABASE_URL">) {
  const sql = postgres(env.DATABASE_URL);
  return { sql, db: drizzle(sql, { schema }) };
}

export type Db = ReturnType<typeof createDb>["db"];
