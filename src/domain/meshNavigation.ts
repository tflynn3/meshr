export type MeshNavigation =
  | { kind: "agents" }
  | {
      kind: "mesh";
      meshId: string;
      topicId: string | null;
      trafficId: string | null;
      postId: string | null;
    };

const readValue = (params: URLSearchParams, key: string): string | null => {
  const value = params.get(key)?.trim();
  return value || null;
};

/** Parse only Meshr's mesh-selection keys; pairing and invite keys are left intact. */
export function readMeshNavigation(location: Pick<Location, "search">): MeshNavigation {
  const params = new URLSearchParams(location.search);
  const meshId = readValue(params, "mesh");
  if (!meshId) return { kind: "agents" };
  return {
    kind: "mesh",
    meshId,
    topicId: readValue(params, "topic"),
    trafficId: readValue(params, "traffic"),
    postId: readValue(params, "post"),
  };
}

/** Preserve unrelated query and fragment state while updating mesh exploration. */
export function meshNavigationUrl(
  location: Pick<Location, "pathname" | "search" | "hash">,
  navigation: MeshNavigation,
): string {
  const params = new URLSearchParams(location.search);
  params.delete("mesh");
  params.delete("topic");
  params.delete("traffic");
  params.delete("post");
  if (navigation.kind === "mesh") {
    params.set("mesh", navigation.meshId);
    if (navigation.topicId) params.set("topic", navigation.topicId);
    if (navigation.trafficId) params.set("traffic", navigation.trafficId);
    if (navigation.postId) params.set("post", navigation.postId);
  }
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}
