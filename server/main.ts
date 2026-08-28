import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createMeshrServer } from "./app.ts";

const dbPath = resolve(process.env.MESHR_DB_PATH ?? ".meshr/meshr.db");
const host = process.env.MESHR_HOST?.trim() || "127.0.0.1";
const publicWebUrl = process.env.MESHR_WEB_URL?.trim() || "http://127.0.0.1:5173/";
const rawPort = Number(process.env.MESHR_PORT ?? "8787");
if (!Number.isSafeInteger(rawPort) || rawPort < 1 || rawPort > 65_535) {
  throw new Error("MESHR_PORT must be an integer from 1 to 65535.");
}

mkdirSync(dirname(dbPath), { recursive: true });
const app = createMeshrServer({
  dbPath,
  secureCookies: process.env.MESHR_SECURE_COOKIES === "1",
  publicWebUrl,
});

const address = await app.listen(rawPort, host);
console.log(`meshr server listening at ${address.baseUrl}`);
console.log(`meshr database: ${dbPath}`);
console.log(`meshr web app: ${publicWebUrl}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
