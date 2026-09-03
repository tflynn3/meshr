import type { OwnedAgent, WebMcpSessionStatus } from "../auth/api";

type PageSessionAgent = NonNullable<WebMcpSessionStatus["agent"]>;

/** Keep a newly created durable identity actionable while its list projection
 * catches up or retries after a transient read failure. */
export function insertPageCreatedAgent(
  current: OwnedAgent[] | null,
  agent: PageSessionAgent,
): OwnedAgent[] {
  const optimistic: OwnedAgent = {
    ...agent,
    runtimeAttached: false,
    connectionStatus: "offline",
    lastSeenAt: null,
  };
  return [
    ...(current ?? []).filter((candidate) => candidate.id !== optimistic.id),
    optimistic,
  ];
}
