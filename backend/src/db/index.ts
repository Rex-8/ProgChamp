import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./schema";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

client.execute("PRAGMA foreign_keys = ON").catch((err) => {
  console.error("Failed to enable foreign keys:", err);
});

export const db = drizzle(client, { schema });