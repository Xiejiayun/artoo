import { sql } from "drizzle-orm";
import { jsonb, timestamp } from "drizzle-orm/pg-core";

export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
export const jsonbArray = (name: string) => jsonb(name).notNull().default(sql`'[]'::jsonb`);
export const jsonbObject = (name: string) => jsonb(name).notNull().default(sql`'{}'::jsonb`);
