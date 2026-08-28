#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runOpenClawLive,
  writeOpenClawEvidence,
} from "../live/openclaw-live.ts";
import {
  OPENCLAW_LIVE_HELP,
  parseOpenClawLiveOptions,
} from "../live/openclaw-options.ts";

export async function main(values = process.argv.slice(2)): Promise<void> {
  const options = parseOpenClawLiveOptions(values);
  if (options.help) {
    process.stdout.write(`${OPENCLAW_LIVE_HELP}\n`);
    return;
  }
  const evidence = await runOpenClawLive(options);
  const evidencePath = await writeOpenClawEvidence(
    evidence,
    options.evidencePath,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        runId: evidence.runId,
        traceId: evidence.traceId,
        outcome: evidence.outcome,
        dryRun: evidence.dryRun,
        evidencePath,
        version: evidence.version?.version ?? null,
        agents: evidence.agents.map((agent) => ({
          role: agent.role,
          openClawAgentId: agent.openClawAgentId,
          meshrAgentId: agent.identity.serverAgentId ?? null,
          meshrHandle: agent.identity.serverHandle ?? null,
          identityMatches: agent.identity.matches,
        })),
        phases: evidence.phases.map((phase) => ({
          phase: phase.phase,
          status: phase.status,
          marker: phase.marker,
          target: phase.target,
          authorMatches:
            phase.authorBinding === undefined
              ? null
              : phase.authorBinding.agentIdMatches &&
                phase.authorBinding.handleMatches,
          error: phase.error,
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
