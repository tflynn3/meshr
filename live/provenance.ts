import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LIVE_EVIDENCE_CONTRACT_MAJOR = 1 as const;
export const LIVE_EVIDENCE_ENVIRONMENTS = ["local", "canary", "production"] as const;
export type LiveEvidenceEnvironment = (typeof LIVE_EVIDENCE_ENVIRONMENTS)[number];

/**
 * Provenance attached to every runtime acceptance artifact. A trace is useful
 * for diagnosis when it is historical, but it is release evidence only when
 * its source revision and target environment are explicit and verifiable.
 */
export interface EvidenceProvenance {
  contractMajor: typeof LIVE_EVIDENCE_CONTRACT_MAJOR;
  gitSha: string | null;
  gitBranch: string | null;
  workingTreeClean: boolean;
  environment: LiveEvidenceEnvironment;
}

function configuredEnvironment(value = process.env.MESHR_EVIDENCE_ENV): LiveEvidenceEnvironment {
  const normalized = value?.trim().toLowerCase() || "local";
  if ((LIVE_EVIDENCE_ENVIRONMENTS as readonly string[]).includes(normalized)) {
    return normalized as LiveEvidenceEnvironment;
  }
  throw new Error(
    `MESHR_EVIDENCE_ENV must be one of ${LIVE_EVIDENCE_ENVIRONMENTS.join(", ")}.`,
  );
}

async function gitValue(projectRoot: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-C", projectRoot, ...args], {
      timeout: 2_000,
      maxBuffer: 32 * 1024,
    });
    const value = result.stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Capture release provenance without making a diagnostic run fail on a non-git checkout. */
export async function captureEvidenceProvenance(
  projectRoot: string,
  environment = configuredEnvironment(),
): Promise<EvidenceProvenance> {
  const [gitSha, gitBranch, status] = await Promise.all([
    gitValue(projectRoot, ["rev-parse", "HEAD"]),
    gitValue(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitValue(projectRoot, ["status", "--porcelain", "--untracked-files=all"]),
  ]);
  return {
    contractMajor: LIVE_EVIDENCE_CONTRACT_MAJOR,
    gitSha,
    gitBranch,
    // gitValue returns null when stdout is empty. Treat that as a clean tree;
    // comparing against an empty string would mark every release dirty.
    workingTreeClean: status === null,
    environment,
  };
}
