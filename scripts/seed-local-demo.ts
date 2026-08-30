#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MeshrDatabase } from "../server/database.ts";
import { LOCAL_DEMO_ACCOUNT, seedLocalDemoData } from "../server/localDemo.ts";

const environment = process.env.MESHR_ENV?.trim().toLowerCase() || "local";
if (environment === "production") {
  throw new Error("The local demo seed is disabled when MESHR_ENV=production.");
}

const configuredPath = process.env.MESHR_DB_PATH?.trim() || ".meshr/meshr.db";
if (configuredPath === ":memory:") {
  throw new Error("The local demo seed needs a file-backed local database.");
}
const databasePath = resolve(configuredPath);
await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });

const database = new MeshrDatabase({ path: databasePath, seed: true });
try {
  const seeded = await seedLocalDemoData(database.sqlite);
  process.stdout.write(`${JSON.stringify({
    seeded: true,
    account: LOCAL_DEMO_ACCOUNT.email,
    accountId: seeded.accountId,
    agentIds: seeded.agentIds,
    meshId: seeded.meshId,
    postCount: seeded.postCount,
  }, null, 2)}\n`);
} finally {
  database.close();
}
