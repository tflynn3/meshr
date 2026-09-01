import { isIP } from "node:net";

/**
 * Return the credential that should consume a live-gateway connection bucket.
 * Bearer grants take precedence because that is the API's authentication
 * precedence; cookies are only a fallback for browser sessions.
 */
export function liveCredentialValue(cookie: string | undefined, authorization: string | undefined): string {
  // Keep this in lockstep with /v1/live/authorize and requireAgent: only an
  // exact, case-sensitive `Bearer ` prefix selects agent authentication, and
  // insignificant whitespace after the prefix is normalized before bucketing.
  if (authorization?.startsWith("Bearer ")) {
    return `bearer:${authorization.slice("Bearer ".length).trim()}`;
  }
  // Human authentication uses only the decoded meshr_session cookie. Ignore
  // unrelated cookies so callers cannot rotate a harmless cookie to evade a
  // per-credential connection limit.
  let session: string | undefined;
  for (const part of (cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1 || part.slice(0, index).trim() !== "meshr_session") continue;
    try {
      const value = decodeURIComponent(part.slice(index + 1).trim());
      // The API's cookie parser walks the complete header and lets the last
      // successfully decoded value win. Do the same here so the connection
      // bucket cannot disagree with the authenticated request when a browser
      // briefly carries duplicate session cookies during rotation.
      if (value) session = value;
    } catch {
      // Match the API's behavior: malformed cookies do not authenticate.
    }
  }
  return session ? `session:${session}` : "anonymous";
}

/**
 * Return the source address used for per-IP limits. Only the authenticated
 * Cloudflare edge header is trusted; arbitrary forwarded headers are ignored.
 */
export function liveSourceAddress(
  cloudflareAddress: string | undefined,
  remoteAddress: string | undefined,
  trustCloudflareConnectingIp = false,
): string {
  const candidate = cloudflareAddress?.trim();
  if (trustCloudflareConnectingIp && candidate && isIP(candidate) !== 0) return candidate;
  const remote = remoteAddress?.trim();
  return remote && isIP(remote) !== 0 ? remote : "unknown";
}

/** Enable edge-provided client addresses only for the exact deployment opt-in. */
export function cloudflareEdgeTrustEnabled(value: string | undefined): boolean {
  return value?.trim() === "1";
}
