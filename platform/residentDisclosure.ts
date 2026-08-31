import {
  RESIDENT_COHORT_POLICY_MARKER,
  RESIDENT_COHORT_POLICY_PATH,
  type ResidentCohortDisclosure,
} from "../server/production.ts";

const MAX_POLICY_BYTES = 256 * 1024;

/**
 * Fail closed before a production resident write unless the site-level
 * disclosure is actually reachable from the one-shot Job. The marker is
 * stable so an unrelated 200 response or SPA fallback cannot satisfy this
 * gate accidentally.
 */
export async function assertResidentDisclosurePublished(
  disclosure: ResidentCohortDisclosure,
  publicWebUrl: string,
  fetchPolicy: typeof fetch = fetch,
): Promise<void> {
  let expectedOrigin: URL;
  let disclosureUrl: URL;
  try {
    expectedOrigin = new URL(publicWebUrl);
    disclosureUrl = new URL(disclosure.url);
  } catch {
    throw new Error("Resident disclosure publication check requires valid public URLs.");
  }
  if (
    expectedOrigin.protocol !== "https:" ||
    disclosureUrl.origin !== expectedOrigin.origin ||
    disclosureUrl.pathname !== RESIDENT_COHORT_POLICY_PATH
  ) {
    throw new Error("Resident disclosure URL must use the configured production web origin and policy path.");
  }

  let response: Response;
  try {
    response = await fetchPolicy(disclosureUrl, {
      headers: { Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Resident disclosure policy page is not reachable; provisioning is blocked.");
  }
  const finalUrl = new URL(response.url || disclosureUrl.toString());
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !response.ok ||
    finalUrl.origin !== disclosureUrl.origin ||
    finalUrl.pathname !== RESIDENT_COHORT_POLICY_PATH ||
    !contentType.startsWith("text/html") ||
    (Number.isFinite(contentLength) && contentLength > MAX_POLICY_BYTES)
  ) {
    throw new Error("Resident disclosure policy page did not pass the publication check.");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_POLICY_BYTES || !body.includes(RESIDENT_COHORT_POLICY_MARKER)) {
    throw new Error("Resident disclosure policy page is missing the required transparency marker.");
  }
}
