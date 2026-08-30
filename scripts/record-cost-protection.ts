import { createHash } from "node:crypto";
import { createFirestore } from "../platform/googleClients.ts";
import { FirestoreMeshrRepository } from "../server/firestoreRepository.ts";
import type { RepositoryAuditInput } from "../server/repository.ts";

type ProtectionMode = "normal" | "protect" | "throttle";
type ProtectionPhase = "requested" | "applied" | "transitioned";

function required(name: string, max = 256): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value || value.length > max) throw new Error(`${name} is required and must be at most ${max} characters.`);
  return value;
}

function mode(name: string): ProtectionMode {
  const value = required(name, 16).toLowerCase();
  if (value !== "normal" && value !== "protect" && value !== "throttle") {
    throw new Error(`${name} must be normal, protect, or throttle.`);
  }
  return value;
}

function phase(): ProtectionPhase {
  const value = process.env.MESHR_COST_PROTECTION_PHASE?.trim().toLowerCase() || "transitioned";
  if (value !== "requested" && value !== "applied" && value !== "transitioned") {
    throw new Error("MESHR_COST_PROTECTION_PHASE must be requested, applied, or transitioned.");
  }
  return value;
}

const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || required("GCP_PROJECT_ID", 128);
const databaseId = process.env.MESHR_FIRESTORE_DATABASE?.trim() || "(default)";
const previousMode = mode("MESHR_COST_PROTECTION_PREVIOUS_MODE");
const nextMode = mode("MESHR_COST_PROTECTION_MODE");
const operator = required("MESHR_COST_PROTECTION_OPERATOR", 128);
const reason = required("MESHR_COST_PROTECTION_REASON", 1_000);
const transitionId = required("MESHR_COST_PROTECTION_TRANSITION_ID", 128);
const transitionPhase = phase();

// The explicit two-phase workflow may need to append an `applied` receipt on
// a retry after the ConfigMap already contains the desired mode.  The legacy
// one-shot phase remains a no-op when there was no mode change.
if (previousMode === nextMode && transitionPhase !== "applied") {
  console.log(JSON.stringify({ changed: false, mode: nextMode, transitionId }));
  process.exit(0);
}

const firestore = createFirestore(projectId, databaseId);
const repository = new FirestoreMeshrRepository({ firestore });
const now = new Date().toISOString();
const auditId = `audit_cost_protection_${createHash("sha256")
  .update(`${transitionId}:${transitionPhase}`)
  .digest("hex")
  .slice(0, 40)}`;
const action = transitionPhase === "requested"
  ? "cost_protection.transition_requested"
  : transitionPhase === "applied"
    ? "cost_protection.transition_applied"
    : "cost_protection.transitioned";
const audit: RepositoryAuditInput = {
  auditId,
  actorType: "system",
  actorId: operator,
  sessionId: null,
  action,
  resourceType: "cost_protection",
  resourceId: "global",
  data: {
    transitionId,
    phase: transitionPhase,
    previousMode,
    mode: nextMode,
    operator,
    reason,
    source: "protected-release-workflow",
  },
  createdAt: now,
};
await repository.appendAuditEvent(audit);
await firestore.terminate();
console.log(JSON.stringify({
  changed: previousMode !== nextMode,
  phase: transitionPhase,
  auditId,
  previousMode,
  mode: nextMode,
  transitionId,
  recordedAt: now,
}));
