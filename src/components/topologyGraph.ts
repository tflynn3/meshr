import type { Agent, RuntimeBinding, Topic } from "../domain/types";
import type { TopologyRect } from "./topologyRouting";

const AGENT_SIZE = 58;
const NODE_CLEARANCE = 12;

const topicPositions = [
  { x: 365, y: 315 },
  { x: 40, y: 30 },
  { x: 690, y: 30 },
  { x: 40, y: 600 },
  { x: 690, y: 600 },
];

export type TopologyParticipant = {
  agent: Agent;
  badge: string;
};

export type TopologyTopic = {
  topic: Topic;
  participants: TopologyParticipant[];
  selected: boolean;
  rect: TopologyRect;
};

export type TopologyAgent = {
  agent: Agent;
  badge: string;
  rect: TopologyRect;
};

export type TopologyGraph = {
  topics: TopologyTopic[];
  agents: TopologyAgent[];
};

function handleBadgeBases(agents: Agent[]): Map<string, string> {
  return new Map(agents.map((agent) => {
    const normalized = agent.handle
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .toUpperCase();
    const base = normalized.length === 0
      ? "AG"
      : normalized.length === 1
        ? `${normalized}X`
        : normalized;
    return [agent.id, base];
  }));
}

function uniqueHandleBadges(agents: Agent[]): Map<string, string> {
  const bases = handleBadgeBases(agents);
  const badges = new Map<string, string>();
  const unresolvedByBase = new Map<string, Agent[]>();
  for (const agent of agents) {
    const base = bases.get(agent.id)!;
    let badge: string | null = null;
    for (let length = 2; length <= base.length; length += 1) {
      const prefix = base.slice(0, length);
      if (agents.every((other) => other.id === agent.id || !bases.get(other.id)!.startsWith(prefix))) {
        badge = prefix;
        break;
      }
    }
    if (badge) {
      badges.set(agent.id, badge);
    } else {
      unresolvedByBase.set(base, [...(unresolvedByBase.get(base) ?? []), agent]);
    }
  }
  for (const [base, unresolved] of unresolvedByBase) {
    unresolved
      .sort((left, right) => left.id.localeCompare(right.id))
      .forEach((agent, index) => badges.set(agent.id, `${base}-${index + 1}`));
  }
  return badges;
}

function topicDimensions(accent: Topic["accent"], selected: boolean): Pick<TopologyRect, "width" | "height"> {
  switch (accent) {
    case "violet":
      return { width: 252, height: 232 };
    case "coral":
      return { width: 264, height: 230 };
    case "yellow":
      return { width: 238, height: 246 };
    case "blue":
      return { width: 258, height: 224 };
    case "green":
      return selected ? { width: 270, height: 250 } : { width: 260, height: 240 };
  }
}

function distanceBetweenRects(left: TopologyRect, right: TopologyRect): number {
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

function agentCandidates(topicRects: TopologyRect[]): Array<{ x: number; y: number }> {
  const minX = Math.min(...topicRects.map((rect) => rect.x));
  const minY = Math.min(...topicRects.map((rect) => rect.y));
  const maxX = Math.max(...topicRects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...topicRects.map((rect) => rect.y + rect.height));
  const step = AGENT_SIZE + NODE_CLEARANCE;
  const candidates: Array<{ x: number; y: number }> = [];

  for (let ring = 0; ring < 3; ring += 1) {
    const ringOffset = NODE_CLEARANCE + ring * step;
    const top = minY - AGENT_SIZE - ringOffset;
    const bottom = maxY + ringOffset;
    const left = minX - AGENT_SIZE - ringOffset;
    const right = maxX + ringOffset;
    const horizontalSlots = Math.floor((maxX - minX) / step) + 1;
    const verticalSlots = Math.floor((maxY - minY) / step) + 1;
    const slots = Math.max(horizontalSlots, verticalSlots);
    for (let index = 0; index < slots; index += 1) {
      const x = minX + index * step;
      const y = minY + index * step;
      if (index < horizontalSlots) {
        candidates.push({ x, y: top }, { x, y: bottom });
      }
      if (index < verticalSlots) {
        candidates.push({ x: left, y }, { x: right, y });
      }
    }
  }
  return candidates;
}

function layoutAgents(agents: Agent[], topicRects: TopologyRect[], badges: Map<string, string>): TopologyAgent[] {
  if (topicRects.length === 0) {
    return agents.map((agent, index) => ({
      agent,
      badge: badges.get(agent.id)!,
      rect: {
        id: agent.id,
        x: index * (AGENT_SIZE + NODE_CLEARANCE),
        y: 0,
        width: AGENT_SIZE,
        height: AGENT_SIZE,
      },
    }));
  }

  const candidates = agentCandidates(topicRects);
  const placed: TopologyAgent[] = [];
  for (const agent of agents) {
    const position = candidates.find(({ x, y }) => {
      const rect: TopologyRect = { id: agent.id, x, y, width: AGENT_SIZE, height: AGENT_SIZE };
      return topicRects.every((topicRect) => distanceBetweenRects(rect, topicRect) >= NODE_CLEARANCE)
        && placed.every(({ rect: agentRect }) => distanceBetweenRects(rect, agentRect) >= NODE_CLEARANCE);
    });
    if (!position) throw new Error(`topology_layout_capacity_exceeded:${agent.id}`);
    placed.push({
      agent,
      badge: badges.get(agent.id)!,
      rect: { id: agent.id, ...position, width: AGENT_SIZE, height: AGENT_SIZE },
    });
  }
  return placed;
}

export function buildTopologyGraph({
  topics,
  agents,
  runtimeBindings,
  selectedTopicId,
}: {
  topics: Topic[];
  agents: Agent[];
  runtimeBindings: RuntimeBinding[];
  selectedTopicId: string;
}): TopologyGraph {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const connectedAgentIds = new Set(
    runtimeBindings
      .filter((binding) => binding.status === "connected")
      .map((binding) => binding.agentId),
  );
  const badges = uniqueHandleBadges(agents);
  const participant = (agent: Agent): TopologyParticipant => ({
    agent,
    badge: badges.get(agent.id)!,
  });
  const topicsByStableId = [...topics].sort((left, right) => left.id.localeCompare(right.id));
  const visibleTopics = topicsByStableId.slice(0, 5).map((topic, index) => {
    const selected = topic.id === selectedTopicId;
    const dimensions = topicDimensions(topic.accent, selected);
    return {
      topic,
      participants: topic.participantAgentIds
        .map((id) => agentsById.get(id))
        .filter((agent): agent is Agent => Boolean(agent))
        .map(participant),
      selected,
      rect: {
        id: topic.id,
        ...(topicPositions[index] ?? { x: 365 + index * 320, y: 315 }),
        ...dimensions,
      },
    };
  });
  const visibleAgents = [...agents]
    .sort((left, right) => left.id.localeCompare(right.id))
    .filter((agent) => connectedAgentIds.has(agent.id))
    .slice(0, 10);

  return {
    topics: visibleTopics,
    agents: layoutAgents(visibleAgents, visibleTopics.map(({ rect }) => rect), badges),
  };
}
