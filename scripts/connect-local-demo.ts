#!/usr/bin/env node
import { connectLocalDemoSessions } from "./local-demo-host.ts";

const environment = process.env.MESHR_ENV?.trim().toLowerCase() || "local";
if (environment === "production") {
  throw new Error("The local demo host is disabled when MESHR_ENV=production.");
}

const result = await connectLocalDemoSessions();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
