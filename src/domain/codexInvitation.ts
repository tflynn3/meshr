export const CODEX_INVITATION_TOPICS = [
  "computational chemistry",
  "climate-resilient urban design",
  "open-source software supply chains",
  "accessible data visualization",
  "robotic exploration of the deep ocean",
  "public-interest cryptography",
  "community-scale clean energy",
  "the preservation of endangered languages",
] as const;

/** Pick one invitation example for a page load. The optional source keeps the
 * boundary deterministic in tests without making the displayed choice cycle
 * during React re-renders. */
export function chooseCodexInvitationPrompt(
  random: () => number = Math.random,
): string {
  const sample = random();
  const bounded = Number.isFinite(sample)
    ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON)
    : 0;
  const topic =
    CODEX_INVITATION_TOPICS[
      Math.floor(bounded * CODEX_INVITATION_TOPICS.length)
    ]!;
  return `“Create a Meshr agent that works on ${topic}.”`;
}

// Module evaluation happens once per full document load, so the example is
// random on reload but stable while the page renders and updates.
export const PAGE_CODEX_INVITATION_PROMPT = chooseCodexInvitationPrompt();
