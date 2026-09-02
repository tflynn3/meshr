import { createHash, createHmac } from "node:crypto";
import type {
  MeshrRepository,
  RepositoryResidentPrincipalInput,
  RepositoryResidentPrincipalResult,
} from "../server/repository.ts";
import { hashPassword } from "../server/security.ts";
import type { ResidentCohortDisclosure } from "../server/production.ts";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_PRINCIPALS = 100;

export interface ResidentPrincipalManifest {
  contractVersion: 1;
  generation: string;
  sessionStartsAt: string;
  operator: string;
  purpose: string;
  publicDisclosureAcknowledged: true;
  principals: Array<{
    key: string;
    email: string;
    displayName: string;
  }>;
}

export interface ResidentCredentialBundle {
  contractVersion: 1;
  generation: string;
  manifestDigest: string;
  createdAt: string;
  expiresAt: string;
  cookieName: "meshr_session";
  principals: Array<{
    key: string;
    accountId: string;
    email: string;
    displayName: string;
    /** Private operator credential; never projected or logged. */
    password: string;
    sessionToken: string;
    csrfToken: string;
  }>;
}

export interface ResidentProvisionSummary {
  generation: string;
  manifestDigest: string;
  accountCount: number;
  createdCount: number;
  rotatedSessionCount: number;
  expiresAt: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}.`);
}

function text(
  value: unknown,
  label: string,
  options: { min?: number; max: number; pattern?: RegExp },
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length < (options.min ?? 1) || normalized.length > options.max) {
    throw new Error(`${label} must be between ${options.min ?? 1} and ${options.max} characters.`);
  }
  if (options.pattern && !options.pattern.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function canonicalManifest(manifest: ResidentPrincipalManifest): string {
  return JSON.stringify({
    contractVersion: manifest.contractVersion,
    generation: manifest.generation,
    sessionStartsAt: manifest.sessionStartsAt,
    operator: manifest.operator,
    purpose: manifest.purpose,
    publicDisclosureAcknowledged: manifest.publicDisclosureAcknowledged,
    principals: manifest.principals.map((principal) => ({
      key: principal.key,
      email: principal.email,
      displayName: principal.displayName,
    })),
  });
}

export function parseResidentPrincipalManifest(value: unknown): ResidentPrincipalManifest {
  const input = object(value, "resident manifest");
  exactKeys(input, [
    "contractVersion",
    "generation",
    "sessionStartsAt",
    "operator",
    "purpose",
    "publicDisclosureAcknowledged",
    "principals",
  ], "resident manifest");
  if (input.contractVersion !== 1) throw new Error("resident manifest contractVersion must be 1.");
  if (input.publicDisclosureAcknowledged !== true) {
    throw new Error("resident manifest must explicitly acknowledge the public resident-cohort disclosure.");
  }
  const generation = text(input.generation, "generation", {
    max: 128,
    pattern: /^[a-z0-9][a-z0-9_.:-]*$/i,
  });
  const sessionStartsAt = text(input.sessionStartsAt, "sessionStartsAt", { max: 64 });
  const sessionStartMs = Date.parse(sessionStartsAt);
  if (!Number.isFinite(sessionStartMs) || new Date(sessionStartMs).toISOString() !== sessionStartsAt) {
    throw new Error("sessionStartsAt must be a canonical ISO-8601 timestamp.");
  }
  const operator = text(input.operator, "operator", { max: 128 });
  const purpose = text(input.purpose, "purpose", { min: 10, max: 500 });
  if (!Array.isArray(input.principals) || input.principals.length < 1 || input.principals.length > MAX_PRINCIPALS) {
    throw new Error(`principals must contain between 1 and ${MAX_PRINCIPALS} entries.`);
  }
  const principals = input.principals.map((raw, index) => {
    const principal = object(raw, `principals[${index}]`);
    exactKeys(principal, ["key", "email", "displayName"], `principals[${index}]`);
    const key = text(principal.key, `principals[${index}].key`, {
      max: 64,
      pattern: /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/i,
    }).toLowerCase();
    const email = text(principal.email, `principals[${index}].email`, {
      max: 254,
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    }).toLowerCase();
    const displayName = text(principal.displayName, `principals[${index}].displayName`, { max: 80 });
    return { key, email, displayName };
  });
  if (new Set(principals.map((principal) => principal.key)).size !== principals.length) {
    throw new Error("resident principal keys must be unique.");
  }
  if (new Set(principals.map((principal) => principal.email)).size !== principals.length) {
    throw new Error("resident principal emails must be unique.");
  }
  return {
    contractVersion: 1,
    generation,
    sessionStartsAt,
    operator,
    purpose,
    publicDisclosureAcknowledged: true,
    principals,
  };
}

function derive(secret: string, label: string): string {
  return createHmac("sha256", secret).update(label, "utf8").digest("base64url");
}

export function deriveResidentCredentialBundle(
  manifest: ResidentPrincipalManifest,
  sessionSecret: string,
): ResidentCredentialBundle {
  if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
    throw new Error("The resident session secret must contain at least 32 bytes.");
  }
  const manifestDigest = createHash("sha256").update(canonicalManifest(manifest)).digest("hex");
  const createdAt = manifest.sessionStartsAt;
  const expiresAt = new Date(Date.parse(createdAt) + SESSION_SECONDS * 1_000).toISOString();
  return {
    contractVersion: 1,
    generation: manifest.generation,
    manifestDigest,
    createdAt,
    expiresAt,
    cookieName: "meshr_session",
    principals: manifest.principals.map((principal) => ({
      key: principal.key,
      accountId: "usr_" + createHash("sha256")
        .update(`meshr-resident:v1:${principal.key}`)
        .digest("hex")
        .slice(0, 24),
      email: principal.email,
      displayName: principal.displayName,
      password: `M${derive(
        sessionSecret,
        `meshr-resident-password:v1:${principal.key}`,
      )}!`,
      sessionToken: derive(
        sessionSecret,
        `meshr-resident-session:v1:${manifest.generation}:${principal.key}:token`,
      ),
      csrfToken: derive(
        sessionSecret,
        `meshr-resident-session:v1:${manifest.generation}:${principal.key}:csrf`,
      ),
    })),
  };
}

export async function provisionResidentPrincipals(
  repository: MeshrRepository,
  manifest: ResidentPrincipalManifest,
  bundle: ResidentCredentialBundle,
  disclosure: ResidentCohortDisclosure,
): Promise<ResidentProvisionSummary> {
  if (!repository.provisionResidentPrincipal) {
    throw new Error("The configured repository cannot provision resident principals.");
  }
  if (
    bundle.generation !== manifest.generation ||
    bundle.principals.length !== manifest.principals.length
  ) {
    throw new Error("The resident credential bundle does not match the manifest.");
  }
  const disclosureTextHash = createHash("sha256").update(disclosure.text).digest("hex");
  const results: RepositoryResidentPrincipalResult[] = [];
  for (const [index, principal] of manifest.principals.entries()) {
    const credential = bundle.principals[index]!;
    if (
      credential.key !== principal.key ||
      credential.email !== principal.email ||
      credential.displayName !== principal.displayName
    ) {
      throw new Error("The resident credential bundle does not match the manifest.");
    }
    const auditId = "audit_resident_" + createHash("sha256")
      .update(`${manifest.generation}:${principal.key}`)
      .digest("hex")
      .slice(0, 40);
    const input: RepositoryResidentPrincipalInput = {
      principalKey: principal.key,
      accountId: credential.accountId,
      email: principal.email,
      displayName: principal.displayName,
      passwordHash: await hashPassword(credential.password),
      operator: manifest.operator,
      purpose: manifest.purpose,
      generation: manifest.generation,
      manifestDigest: bundle.manifestDigest,
      disclosureTextHash,
      disclosureUrl: disclosure.url,
      session: {
        tokenHash: createHash("sha256").update(credential.sessionToken).digest("hex"),
        csrfToken: credential.csrfToken,
        createdAt: bundle.createdAt,
        expiresAt: bundle.expiresAt,
        absoluteExpiresAt: bundle.expiresAt,
      },
      audit: {
        auditId,
        actorType: "system",
        actorId: manifest.operator,
        sessionId: null,
        action: "resident_principal.provisioned",
        resourceType: "resident_principal",
        resourceId: principal.key,
        data: {
          accountId: credential.accountId,
          generation: manifest.generation,
          manifestDigest: bundle.manifestDigest,
          operator: manifest.operator,
          purpose: manifest.purpose,
          disclosureUrl: disclosure.url,
          sessionExpiresAt: bundle.expiresAt,
        },
        createdAt: bundle.createdAt,
      },
    };
    results.push(await repository.provisionResidentPrincipal(input));
  }
  return {
    generation: manifest.generation,
    manifestDigest: bundle.manifestDigest,
    accountCount: results.length,
    createdCount: results.filter((result) => result.created).length,
    rotatedSessionCount: results.filter((result) => result.sessionRotated).length,
    expiresAt: bundle.expiresAt,
  };
}
