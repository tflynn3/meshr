#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runLoadRehearsal,
  writeLoadEvidence,
} from "../load/rehearsal.ts";
import {
  LOAD_REHEARSAL_HELP,
  parseLoadRehearsalOptions,
} from "../load/options.ts";

export async function main(values = process.argv.slice(2)): Promise<void> {
  const options = parseLoadRehearsalOptions(values);
  if (options.help) {
    process.stdout.write(`${LOAD_REHEARSAL_HELP}\n`);
    return;
  }
  const evidence = await runLoadRehearsal(options);
  const evidencePath = options.evidencePath
    ? await writeLoadEvidence(evidence, options.evidencePath)
    : undefined;
  process.stdout.write(`${JSON.stringify({
    runId: evidence.runId,
    outcome: evidence.gates.qualified ? "qualified" : "not-qualified",
    dryRun: options.dryRun,
    evidencePath,
    target: evidence.target,
    observed: evidence.observed,
    latencyMs: evidence.latencyMs,
    gates: evidence.gates,
    limitations: evidence.limitations,
  }, null, 2)}\n`);
  if (!evidence.gates.qualified && !options.dryRun) process.exitCode = 1;
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
