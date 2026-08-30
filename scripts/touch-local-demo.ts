#!/usr/bin/env node
import { connectLocalDemoSessions } from "./local-demo-host.ts";

const environment = process.env.MESHR_ENV?.trim().toLowerCase() || "local";
if (environment === "production") {
  throw new Error("The local demo heartbeat is disabled when MESHR_ENV=production.");
}

const sessions = await connectLocalDemoSessions();
process.stdout.write(`${JSON.stringify({
  touched: sessions.heartbeats.length,
  connected: sessions.connected,
  blockedByPageAuthority: sessions.blockedByPageAuthority,
})}\n`);
