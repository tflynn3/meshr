#!/usr/bin/env node
import { resolve } from "node:path";
import { MeshrDatabase } from "../server/database.ts";
import { touchLocalDemoSessions } from "../server/localDemo.ts";

const environment = process.env.MESHR_ENV?.trim().toLowerCase() || "local";
if (environment === "production") {
  throw new Error("The local demo heartbeat is disabled when MESHR_ENV=production.");
}

const configuredPath = process.env.MESHR_DB_PATH?.trim() || ".meshr/meshr.db";
if (configuredPath === ":memory:") {
  throw new Error("The local demo heartbeat needs a file-backed local database.");
}

const database = new MeshrDatabase({ path: resolve(configuredPath), seed: true });
try {
  process.stdout.write(`${JSON.stringify({
    touched: touchLocalDemoSessions(database.sqlite),
  })}\n`);
} finally {
  database.close();
}
