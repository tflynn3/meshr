import type { ConversationalAgentProfile } from "./agentTools";

export interface RecommendationMesh {
  id: string;
  name: string;
  description: string;
  visibility: string;
  joinPolicy: string;
  joined: boolean;
}

export interface MeshRecommendation extends RecommendationMesh {
  reason: string;
  score: number;
}

const stopWords = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "into",
  "of", "on", "or", "the", "through", "to", "with", "works",
]);

function words(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !stopWords.has(word));
}

function weightedTerms(profile: ConversationalAgentProfile): Map<string, number> {
  const terms = new Map<string, number>();
  const add = (value: string, weight: number) => {
    for (const word of words(value)) {
      terms.set(word, Math.max(terms.get(word) ?? 0, weight));
    }
  };
  add(profile.name, 2);
  add(profile.tagline, 3);
  add(profile.personality, 1);
  for (const interest of profile.interests) add(interest, 6);
  return terms;
}

export function rankMeshRecommendations(
  profile: ConversationalAgentProfile,
  meshes: RecommendationMesh[],
  limit = 3,
): MeshRecommendation[] {
  const profileTerms = weightedTerms(profile);
  return meshes
    .filter((mesh) => mesh.visibility === "public" || mesh.joined)
    .map((mesh) => {
      const meshTerms = new Map<string, number>();
      for (const word of words(mesh.name)) meshTerms.set(word, 4);
      for (const word of words(mesh.description)) {
        meshTerms.set(word, Math.max(meshTerms.get(word) ?? 0, 2));
      }
      const matches = [...profileTerms.entries()]
        .filter(([word]) => meshTerms.has(word))
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
      const relevance = matches.reduce(
        (score, [word, weight]) => score + weight * (meshTerms.get(word) ?? 1),
        0,
      );
      const score = relevance + (mesh.joined ? 3 : 0) + (mesh.joinPolicy === "open" ? 2 : 0);
      const matchedWords = matches.slice(0, 3).map(([word]) => word);
      const reason = matchedWords.length
        ? `Matches ${matchedWords.join(", ")} from this agent's profile.`
        : mesh.joined
          ? "Already joined and ready for this agent to explore."
          : mesh.joinPolicy === "open"
            ? "An open public mesh where this agent can begin exploring."
            : "A visible public mesh that may fit this agent's interests.";
      return { ...mesh, reason, score };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.joined) - Number(left.joined) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, Math.max(0, Math.min(10, limit)));
}
