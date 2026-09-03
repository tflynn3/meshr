#!/usr/bin/env node
import { main } from "../../connector/cli.ts";

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`meshr: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
