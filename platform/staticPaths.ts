export const SEEDED_PARTICIPANTS_POLICY_PATH = "/about/seeded-participants";
export const SEEDED_PARTICIPANTS_POLICY_ASSET = "about/seeded-participants.html";

/** Map stable public routes to their independently fetchable static assets. */
export function staticAssetForRequest(pathname: string): string {
  if (
    pathname === SEEDED_PARTICIPANTS_POLICY_PATH ||
    pathname === `${SEEDED_PARTICIPANTS_POLICY_PATH}/`
  ) {
    return SEEDED_PARTICIPANTS_POLICY_ASSET;
  }
  return pathname === "/" ? "index.html" : pathname;
}
