import { createPublicKey, createVerify } from "node:crypto";
import type { IdentityVerifier, SocialIdentityClaims, SocialProvider } from "./types.ts";

const GOOGLE_CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const CLOCK_SKEW_SECONDS = 60;
const UNKNOWN_KEY_REFRESH_COOLDOWN_MS = 60_000;
interface CertificateSet {
  expiresAt: number;
  certificates: Record<string, string>;
}

const certCache = new Map<string, CertificateSet>();
let certificateRefresh: Promise<CertificateSet> | undefined;
let unknownKeyRefreshAllowedAt = 0;

interface IdentityTokenClaims {
  aud?: unknown;
  iss?: unknown;
  sub?: unknown;
  user_id?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  exp?: unknown;
  iat?: unknown;
  firebase?: unknown;
  [key: string]: unknown;
}

function decodePart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("The identity token is not valid JSON.");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The identity token has an invalid payload.");
  }
  return value as Record<string, unknown>;
}

async function refreshCertificates(): Promise<CertificateSet> {
  if (certificateRefresh) return certificateRefresh;
  const refresh = (async () => {
    const response = await fetch(GOOGLE_CERT_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new Error(`Identity certificate request failed (${response.status}).`);
    const values = (await response.json()) as unknown;
    const parsed = record(values);
    const maxAge = response.headers
      .get("cache-control")
      ?.match(/max-age=(\d+)/i)?.[1];
    const ttl = Math.max(60, Math.min(86_400, Number(maxAge ?? 3_600)));
    const certificateMap = Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    if (Object.keys(certificateMap).length === 0)
      throw new Error("Identity certificates were empty.");
    const refreshed = {
      expiresAt: Date.now() + ttl * 1_000,
      certificates: certificateMap,
    };
    certCache.set(GOOGLE_CERT_URL, refreshed);
    return refreshed;
  })();
  certificateRefresh = refresh;
  try {
    return await refresh;
  } finally {
    if (certificateRefresh === refresh) certificateRefresh = undefined;
  }
}

async function certificates(
  now = Date.now(),
): Promise<{ cached: boolean; certificateSet: CertificateSet }> {
  const cached = certCache.get(GOOGLE_CERT_URL);
  if (cached && cached.expiresAt > now) return { cached: true, certificateSet: cached };
  return { cached: false, certificateSet: await refreshCertificates() };
}

async function refreshCachedCertificates(
  observed: CertificateSet,
  now = Date.now(),
): Promise<CertificateSet> {
  const current = certCache.get(GOOGLE_CERT_URL);
  // A concurrent verifier already refreshed the snapshot we observed. Reuse it
  // instead of immediately issuing another cache-bypass request.
  if (current && current !== observed) return current;
  // Unknown JWT key ids are attacker-controlled. Share an in-flight refresh,
  // then enforce a short global cooldown so a stream of random ids cannot turn
  // login verification into unbounded requests to Google's certificate endpoint.
  if (certificateRefresh) return certificateRefresh;
  if (now < unknownKeyRefreshAllowedAt) return current ?? observed;
  unknownKeyRefreshAllowedAt = now + UNKNOWN_KEY_REFRESH_COOLDOWN_MS;
  return refreshCertificates();
}

async function verifyToken(projectId: string, token: string): Promise<IdentityTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("The identity token is malformed.");
  const header = record(decodePart(parts[0]!));
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("The identity token uses an unsupported signing algorithm.");
  }
  const payload = record(decodePart(parts[1]!)) as IdentityTokenClaims;
  const signature = Buffer.from(parts[2]!, "base64url");
  const snapshot = await certificates();
  let cert = snapshot.certificateSet.certificates[header.kid];
  if (!cert && snapshot.cached) {
    cert = (await refreshCachedCertificates(snapshot.certificateSet)).certificates[header.kid];
  }
  if (!cert) throw new Error("The identity token signing key is unknown.");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(createPublicKey(cert), signature)) {
    throw new Error("The identity token signature is invalid.");
  }
  const now = Math.floor(Date.now() / 1_000);
  if (
    payload.aud !== projectId ||
    payload.iss !== `https://securetoken.google.com/${projectId}` ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.exp !== "number" ||
    payload.exp <= now - CLOCK_SKEW_SECONDS ||
    (typeof payload.iat === "number" && payload.iat > now + CLOCK_SKEW_SECONDS)
  ) {
    throw new Error("The identity token claims are invalid or expired.");
  }
  return payload;
}

/**
 * Verifies the ID token minted by Google Cloud Identity Platform. Both Google
 * and GitHub federation resolve to the same securetoken issuer; the provider
 * argument records which login button the user selected and is never used as
 * an authorization shortcut.
 */
export function createIdentityPlatformVerifier(projectId: string): IdentityVerifier {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error("A Google Cloud project id is required.");
  return async (provider: SocialProvider, idToken: string): Promise<SocialIdentityClaims> => {
    if (!idToken.trim()) throw new Error("An identity token is required.");
    const payload = await verifyToken(normalizedProjectId, idToken.trim());
    const firebase = record(payload.firebase);
    const signedProvider = firebase.sign_in_provider;
    const expectedProvider = provider === "google" ? "google.com" : "github.com";
    if (signedProvider !== expectedProvider) {
      throw new Error("The identity token provider does not match the selected login.");
    }
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email || email.length > 254) throw new Error("The identity token has no usable email.");
    const displayName =
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim().slice(0, 80)
        : email.split("@", 1)[0]!.slice(0, 80);
    return {
      provider,
      subject: String(payload.user_id ?? payload.sub),
      email,
      displayName,
      emailVerified: payload.email_verified === true,
      authTime: typeof payload.auth_time === "number" ? payload.auth_time : undefined,
    };
  };
}

/** Deterministic verifier useful for local browser/e2e environments. */
export function createDevelopmentIdentityVerifier(
  tokens: Record<string, Omit<SocialIdentityClaims, "provider">>,
): IdentityVerifier {
  return async (provider, token) => {
    const claims = tokens[token];
    if (!claims) throw new Error("The development identity token is unknown.");
    return { ...claims, provider };
  };
}
