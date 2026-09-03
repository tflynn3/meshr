import assert from "node:assert/strict";
import test from "node:test";
import { buildTopologyGraph } from "../src/components/topologyGraph.ts";
import type { Agent, RuntimeBinding, Topic } from "../src/domain/types.ts";

function agent(id: string, handle: string): Agent {
  const label = handle || id;
  return {
    id,
    ownerId: `owner-${id}`,
    name: label[0]!.toUpperCase() + label.slice(1),
    handle,
    initials: handle[0]!.toUpperCase(),
    color: "green",
    tagline: `${handle} agent`,
    interests: [],
    reads: [],
    shares: [],
    attention: { browse: "joined", rootPosts: "autonomous", replies: "autonomous", notes: "" },
    personality: "",
    definitionPath: `.meshr/agents/${handle}.md`,
  };
}

function runtime(agentId: string, status: RuntimeBinding["status"], id = agentId): RuntimeBinding {
  return {
    id: `runtime-${id}`,
    agentId,
    runtime: "other",
    label: `Runtime ${id}`,
    status,
    lastSeenAt: "2026-09-03T12:00:00.000Z",
  };
}

function topic(participantAgentIds: string[]): Topic {
  return {
    id: "topic-presence",
    meshId: "mesh-presence",
    name: "presence",
    title: "Presence",
    description: "Who is live without erasing conversation history.",
    tags: [],
    activityCount: 3,
    recentActivityCount: 0,
    participantAgentIds,
    accent: "green",
  };
}

function variedTopics(participantAgentIds: string[]): Topic[] {
  return (["green", "violet", "coral", "yellow", "blue"] as const).map((accent, index) => ({
    ...topic(participantAgentIds),
    id: `topic-${accent}`,
    name: accent,
    title: `${accent} topic`,
    accent,
    activityCount: index,
  }));
}

function rectDistance(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): number {
  const horizontalGap = Math.max(
    left.x - (right.x + right.width),
    right.x - (left.x + left.width),
    0,
  );
  const verticalGap = Math.max(
    left.y - (right.y + right.height),
    right.y - (left.y + left.height),
    0,
  );
  return Math.hypot(horizontalGap, verticalGap);
}

test("standalone map nodes require a connected runtime while conversation participants retain offline history", () => {
  const agents = [agent("servo", "servo"), agent("sable", "sable"), agent("folio", "folio")];
  const graph = buildTopologyGraph({
    topics: [topic(agents.map(({ id }) => id))],
    agents,
    runtimeBindings: [
      runtime("servo", "offline", "old-servo"),
      runtime("servo", "connected", "live-servo"),
      runtime("sable", "offline"),
      runtime("folio", "sleeping"),
    ],
    selectedTopicId: "topic-presence",
  });

  assert.deepEqual(graph.agents.map(({ agent }) => agent.id), ["servo"]);
  assert.deepEqual(
    graph.topics[0]?.participants.map(({ agent }) => agent.id),
    ["servo", "sable", "folio"],
  );
});

test("agent badges use the shortest unique handle prefix with at least two characters", () => {
  const agents = [
    agent("servo", "servo"),
    agent("sable", "sable"),
    agent("folio", "folio"),
    agent("fork", "fork"),
  ];
  const graph = buildTopologyGraph({
    topics: [topic(agents.map(({ id }) => id))],
    agents,
    runtimeBindings: agents.map(({ id }) => runtime(id, "connected")),
    selectedTopicId: "topic-presence",
  });

  assert.deepEqual(
    Object.fromEntries(graph.agents.map(({ agent, badge }) => [agent.id, badge])),
    { servo: "SE", sable: "SA", folio: "FOL", fork: "FOR" },
  );
  assert.deepEqual(
    graph.topics[0]?.participants.map(({ badge }) => badge),
    ["SE", "SA", "FOL", "FOR"],
  );
});

test("agent badge fallback is unique and deterministic when handles cannot distinguish identities", () => {
  const agents = [
    agent("echo-b", "echo"),
    agent("echo-a", "echo"),
    agent("single", "q"),
    agent("punctuation", "---"),
  ];
  const build = (orderedAgents: Agent[]) => buildTopologyGraph({
    topics: [topic(orderedAgents.map(({ id }) => id))],
    agents: orderedAgents,
    runtimeBindings: orderedAgents.map(({ id }) => runtime(id, "connected")),
    selectedTopicId: "topic-presence",
  });
  const badgesById = (graph: ReturnType<typeof buildTopologyGraph>) => Object.fromEntries(
    graph.agents.map(({ agent, badge }) => [agent.id, badge]),
  );

  const forward = badgesById(build(agents));
  const reversed = badgesById(build([...agents].reverse()));
  assert.deepEqual(reversed, forward);
  assert.equal(new Set(Object.values(forward)).size, agents.length);
  assert.ok(Object.values(forward).every((badge) => badge.length >= 2));
  assert.match(forward["echo-a"]!, /^ECHO-\d+$/);
  assert.match(forward["echo-b"]!, /^ECHO-\d+$/);
});

test("deterministic map layout keeps one, five, and ten agents clear of every topic and each other", () => {
  for (const agentCount of [1, 5, 10]) {
    const agents = Array.from({ length: agentCount }, (_, index) =>
      agent(`agent-${String(index + 1).padStart(2, "0")}`, `handle-${String(index + 1).padStart(2, "0")}`));
    const topics = variedTopics(agents.map(({ id }) => id));
    for (const selectedTopic of topics) {
      const input = {
        topics,
        agents,
        runtimeBindings: agents.map(({ id }) => runtime(id, "connected")),
        selectedTopicId: selectedTopic.id,
      };
      const graph = buildTopologyGraph(input);
      const repeated = buildTopologyGraph(input);
      const reordered = buildTopologyGraph({
        ...input,
        topics: [...topics].reverse(),
        agents: [...agents].reverse(),
        runtimeBindings: [...input.runtimeBindings].reverse(),
      });
      const expectedDimensions = {
        "topic-green": selectedTopic.accent === "green"
          ? { width: 270, height: 250 }
          : { width: 260, height: 240 },
        "topic-violet": { width: 252, height: 232 },
        "topic-coral": { width: 264, height: 230 },
        "topic-yellow": { width: 238, height: 246 },
        "topic-blue": { width: 258, height: 224 },
      };

      assert.equal(graph.agents.length, agentCount);
      assert.deepEqual(
        Object.fromEntries(graph.topics.map(({ topic, rect }) => [
          topic.id,
          { width: rect.width, height: rect.height },
        ])),
        expectedDimensions,
      );
      assert.deepEqual(
        graph.topics.map(({ rect }) => rect),
        repeated.topics.map(({ rect }) => rect),
      );
      assert.deepEqual(
        graph.agents.map(({ rect }) => rect),
        repeated.agents.map(({ rect }) => rect),
      );
      assert.deepEqual(
        Object.fromEntries(graph.topics.map(({ topic, rect }) => [topic.id, rect])),
        Object.fromEntries(reordered.topics.map(({ topic, rect }) => [topic.id, rect])),
      );
      assert.deepEqual(
        Object.fromEntries(graph.agents.map(({ agent, rect }) => [agent.id, rect])),
        Object.fromEntries(reordered.agents.map(({ agent, rect }) => [agent.id, rect])),
      );
      for (const { rect: agentRect } of graph.agents) {
        for (const { rect: topicRect } of graph.topics) {
          assert.ok(
            rectDistance(agentRect, topicRect) >= 12,
            `${agentCount} agents must clear ${selectedTopic.id} topics by at least 12px`,
          );
        }
      }
      graph.topics.forEach(({ rect }, index) => {
        graph.topics.slice(index + 1).forEach(({ rect: other }) => {
          assert.ok(
            rectDistance(rect, other) >= 12,
            `${selectedTopic.id} topics must clear one another by at least 12px`,
          );
        });
      });
      graph.agents.forEach(({ rect }, index) => {
        graph.agents.slice(index + 1).forEach(({ rect: other }) => {
          assert.ok(
            rectDistance(rect, other) >= 12,
            `${agentCount} agents must clear one another by at least 12px`,
          );
        });
      });
    }
  }
});
