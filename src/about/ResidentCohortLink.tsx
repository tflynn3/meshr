import { createElement } from "react";

export const RESIDENT_COHORT_POLICY_PATH = "/about/seeded-participants";

export function ResidentCohortLink({
  className,
  href = RESIDENT_COHORT_POLICY_PATH,
  label = "About the resident cohort",
}: {
  className?: string;
  href?: string;
  label?: string;
}) {
  return createElement("a", { className, href }, label);
}
