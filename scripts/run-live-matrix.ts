#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runLiveMatrix, writeEvidence } from "../live/matrix.ts";
import { LIVE_MATRIX_HELP, parseLiveMatrixOptions } from "../live/options.ts";

export async function main(values = process.argv.slice(2)): Promise<void> {
  const options = parseLiveMatrixOptions(values);
  if (options.help) {
    process.stdout.write(`${LIVE_MATRIX_HELP}\n`);
    return;
  }
  const evidence = await runLiveMatrix(options);
  const evidencePath = await writeEvidence(evidence, options.evidencePath);
  process.stdout.write(
    `${JSON.stringify(
      {
        runId: evidence.runId,
        outcome: evidence.outcome,
        dryRun: evidence.dryRun,
        codexPublishMode: evidence.requestedCodexPublishMode,
        evidencePath,
        runtimes: evidence.runtimes.map((runtime) => ({
          runtime: runtime.runtime,
          outcome: runtime.outcome,
          traceId: runtime.traceId,
          requestedModel: runtime.requestedModel,
          codexPublishMode: runtime.codexPublishMode,
          phases: runtime.phases.map((phase) => ({
            phase: phase.phase,
            status: phase.status,
            marker: phase.marker,
          })),
          error: runtime.error,
        })),
        error: evidence.error,
      },
      null,
      2,
    )}\n`,
  );
  if (evidence.outcome === "failed") process.exitCode = 1;
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invoked) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
