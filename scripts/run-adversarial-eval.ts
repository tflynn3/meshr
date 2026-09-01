#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditAdversarialBundle,
  createAdversarialDryRunEvidence,
  defaultAdversarialEvidencePath,
  loadAdversarialCorpus,
  readAdversarialAuditBundle,
  writeAdversarialEvidence,
} from "../live/adversarial.ts";
import {
  ADVERSARIAL_EVAL_HELP,
  parseAdversarialEvalOptions,
} from "../live/adversarial-options.ts";
import { captureEvidenceProvenance } from "../live/provenance.ts";

export async function main(values = process.argv.slice(2)): Promise<void> {
  const options = parseAdversarialEvalOptions(values);
  if (options.help) {
    process.stdout.write(`${ADVERSARIAL_EVAL_HELP}\n`);
    return;
  }
  const [loaded, provenance] = await Promise.all([
    loadAdversarialCorpus(options.corpusPath),
    captureEvidenceProvenance(options.projectRoot),
  ]);
  const evidence = options.dryRun
    ? createAdversarialDryRunEvidence({
        loaded,
        target: options.target,
        ...options.evalBinding,
        provenance,
      })
    : auditAdversarialBundle({
        loaded,
        bundle: await readAdversarialAuditBundle(options.auditBundlePath!),
        target: options.target,
        ...options.evalBinding,
        provenance,
      });
  const evidencePath = await writeAdversarialEvidence(
    evidence,
    options.evidencePath ??
      defaultAdversarialEvidencePath(options.projectRoot, evidence),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        runId: evidence.runId,
        outcome: evidence.outcome,
        dryRun: evidence.dryRun,
        serverOrigin: evidence.serverOrigin,
        releaseSha: evidence.releaseSha,
        evalNonce: evidence.evalNonce,
        windowNotBefore: evidence.windowNotBefore,
        windowNotAfter: evidence.windowNotAfter,
        corpusSha256: evidence.corpus.sha256,
        cases: evidence.cases.map((entry) => ({
          caseId: entry.caseId,
          status: entry.status,
          taskCompleted: entry.taskCompleted,
          violationCodes: entry.violationCodes,
        })),
        suiteViolationCodes: evidence.suiteViolationCodes,
        evidencePath,
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
      `${error instanceof Error ? error.message : "adversarial_eval_failed"}\n`,
    );
    process.exitCode = 1;
  });
}
