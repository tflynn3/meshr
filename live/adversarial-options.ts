import { resolve } from "node:path";
import type {
  AdversarialEvalBinding,
  AdversarialTarget,
} from "./adversarial.ts";
import {
  defaultAdversarialCorpusPath,
  validateAdversarialEvalBinding,
} from "./adversarial.ts";

export interface AdversarialEvalOptions {
  projectRoot: string;
  dryRun: boolean;
  corpusPath: string;
  auditBundlePath?: string;
  target: AdversarialTarget;
  evalBinding: AdversarialEvalBinding;
  evidencePath?: string;
  help: boolean;
}

export const ADVERSARIAL_EVAL_HELP = `Usage:
  npm run eval:adversarial -- --dry-run --server-origin <https-origin> --release-sha <sha> --eval-nonce <hex> --window-not-before <timestamp> --window-not-after <timestamp> --mesh-id <id> --topic-id <id> --post-id <id>
  npm run eval:adversarial -- --audit-bundle <private.json> --server-origin <https-origin> --release-sha <sha> --eval-nonce <hex> --window-not-before <timestamp> --window-not-after <timestamp> --mesh-id <id> --topic-id <id> --post-id <id>

Options:
  --dry-run                 Validate the checked-in corpus and emit a secret-free plan. Never calls a model or server.
  --audit-bundle <path>     Audit a mode-0600 bundle captured by a trusted live adapter.
  --server-origin <origin>  Independently pinned canonical HTTPS production origin.
  --release-sha <sha>       Independently pinned deployed public commit (40 lowercase hex characters).
  --eval-nonce <hex>        Fresh independently generated 128-bit nonce (32 lowercase hex characters).
  --window-not-before <ts>  Independently pinned capture-window start (canonical UTC timestamp).
  --window-not-after <ts>   Independently pinned capture-window end (canonical UTC timestamp, at most 24 hours later).
  --mesh-id <id>            Independently pinned private validation mesh.
  --topic-id <id>           Independently pinned private validation conversation.
  --post-id <id>            Independently pinned seed post that may receive at most one reply.
  --corpus <path>           Corpus JSON (default: live/adversarial-corpus.json).
  --evidence <path>         Redacted mode-0600 evidence destination (default: live/evidence/<run>.json).
  --help                    Show this help.

This command does not launch a model or access cloud infrastructure. A live adapter must use captureAdversarialCase around each model turn and supply complete server-authoritative snapshots, an actor-scoped mutation journal, a complete host trajectory, and before/after /healthz observations that match the independently pinned release, nonce, and capture window.`;

interface RawOption {
  name: string;
  value?: string;
}

function tokenize(values: string[]): RawOption[] {
  const result: RawOption[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index]!;
    if (!raw.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${raw}.`);
    }
    const equal = raw.indexOf("=");
    if (equal > 2) {
      result.push({ name: raw.slice(2, equal), value: raw.slice(equal + 1) });
      continue;
    }
    const name = raw.slice(2);
    if (["dry-run", "help"].includes(name)) {
      result.push({ name });
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${name}.`);
    }
    result.push({ name, value: next });
    index += 1;
  }
  return result;
}

export function parseAdversarialEvalOptions(
  values: string[],
  cwd = process.cwd(),
): AdversarialEvalOptions {
  const raw = tokenize(values);
  const known = new Set([
    "dry-run",
    "audit-bundle",
    "server-origin",
    "release-sha",
    "eval-nonce",
    "window-not-before",
    "window-not-after",
    "mesh-id",
    "topic-id",
    "post-id",
    "corpus",
    "evidence",
    "help",
  ]);
  for (const option of raw) {
    if (!known.has(option.name)) {
      throw new Error(`Unknown option --${option.name}.`);
    }
  }
  const valuesFor = (name: string): string[] =>
    raw
      .filter((entry) => entry.name === name)
      .flatMap((entry) => entry.value ?? []);
  const one = (name: string): string | undefined => {
    const found = valuesFor(name);
    if (found.length > 1)
      throw new Error(`--${name} may be supplied only once.`);
    return found[0];
  };
  const flag = (name: string): boolean =>
    raw.some((entry) => entry.name === name);
  const help = flag("help");
  const dryRun = flag("dry-run");
  const auditBundle = one("audit-bundle");
  if (!help && Number(dryRun) + Number(Boolean(auditBundle)) !== 1) {
    throw new Error("Select exactly one of --dry-run or --audit-bundle.");
  }
  const targetValue = (name: string): string => {
    const value = one(name)?.trim();
    if (!help && !value) throw new Error(`--${name} is required.`);
    return value || `<${name}>`;
  };
  const evidence = one("evidence");
  const corpus = one("corpus");
  const projectRoot = resolve(cwd);
  const evalBinding = help
    ? {
        serverOrigin: "https://meshr.example.invalid",
        releaseSha: "0".repeat(40),
        evalNonce: "0".repeat(32),
        windowNotBefore: "1970-01-01T00:00:00.000Z",
        windowNotAfter: "1970-01-01T01:00:00.000Z",
      }
    : validateAdversarialEvalBinding({
        serverOrigin: one("server-origin"),
        releaseSha: one("release-sha"),
        evalNonce: one("eval-nonce"),
        windowNotBefore: one("window-not-before"),
        windowNotAfter: one("window-not-after"),
      });
  return {
    projectRoot,
    dryRun,
    corpusPath: corpus
      ? resolve(projectRoot, corpus)
      : defaultAdversarialCorpusPath(projectRoot),
    ...(auditBundle
      ? { auditBundlePath: resolve(projectRoot, auditBundle) }
      : {}),
    target: {
      meshId: targetValue("mesh-id"),
      topicId: targetValue("topic-id"),
      postId: targetValue("post-id"),
    },
    evalBinding,
    ...(evidence ? { evidencePath: resolve(projectRoot, evidence) } : {}),
    help,
  };
}
