import assert from "node:assert/strict";
import test from "node:test";
import { routeTrafficEdge, trafficPorts, visibleTrafficLinks, type TopologyPoint, type TopologyRect } from "../src/components/topologyRouting.ts";

const sourceRect: TopologyRect = { id: "agent-source", x: 660, y: 370, width: 58, height: 58 };
const targetRect: TopologyRect = { id: "agent-target", x: 100, y: 360, width: 58, height: 58 };
const unrelatedConversation: TopologyRect = { id: "topic-unrelated", x: 270, y: 230, width: 270, height: 250 };

function pointInRect(point: TopologyPoint, rect: TopologyRect, padding = 0): boolean {
  return point.x > rect.x - padding && point.x < rect.x + rect.width + padding
    && point.y > rect.y - padding && point.y < rect.y + rect.height + padding;
}

function pathLength(points: TopologyPoint[]): number {
  return points.slice(1).reduce((total, point, index) => {
    const previous = points[index]!;
    return total + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0);
}

function segmentIntersectsRect(start: TopologyPoint, end: TopologyPoint, rect: TopologyRect, padding = 14): boolean {
  const expanded = { x: rect.x - padding, y: rect.y - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 };
  if (start.y === end.y) {
    return start.y > expanded.y && start.y < expanded.y + expanded.height
      && Math.max(Math.min(start.x, end.x), expanded.x) < Math.min(Math.max(start.x, end.x), expanded.x + expanded.width);
  }
  if (start.x === end.x) {
    return start.x > expanded.x && start.x < expanded.x + expanded.width
      && Math.max(Math.min(start.y, end.y), expanded.y) < Math.min(Math.max(start.y, end.y), expanded.y + expanded.height);
  }
  return true;
}

test("traffic routing stays local and avoids unrelated node interiors", () => {
  const ports = trafficPorts(sourceRect, targetRect);
  const route = routeTrafficEdge({
    sourceNodeId: sourceRect.id,
    targetNodeId: targetRect.id,
    source: ports.source,
    target: ports.target,
    sourceRect,
    targetRect,
    obstacles: [sourceRect, targetRect, unrelatedConversation],
  });

  assert.ok(route.points.slice(1).every((point) => !pointInRect(point, unrelatedConversation)), "route control points must not enter an unrelated node");
  assert.ok(route.points.every((point, index) => index === 0 || point.x === route.points[index - 1]!.x || point.y === route.points[index - 1]!.y), "fallback must not introduce a diagonal through the canvas");
  assert.ok(route.points.every((point, index) => index === 0 || !segmentIntersectsRect(route.points[index - 1]!, point, unrelatedConversation)), "every rendered segment must avoid the unrelated node bounds");
  assert.deepEqual(ports, { source: { x: 660, y: 399 }, target: { x: 158, y: 389 }, sourcePort: "left", targetPort: "right" });
  const directDistance = Math.hypot(660 - 158, 399 - 389);
  assert.ok(route.points.every((point) => point.x >= 4 && point.x <= 814), "route must remain in the local source/target corridor");
  assert.ok(pathLength(route.points) < directDistance * 1.55, "route must not make a canvas-spanning detour");
});

test("self traffic takes a compact loop around the agent boundary", () => {
  const route = routeTrafficEdge({
    sourceNodeId: sourceRect.id,
    targetNodeId: sourceRect.id,
    source: { x: sourceRect.x + sourceRect.width, y: sourceRect.y + sourceRect.height / 2 },
    target: { x: sourceRect.x, y: sourceRect.y + sourceRect.height / 2 },
    sourceRect,
    targetRect: sourceRect,
    obstacles: [sourceRect, unrelatedConversation],
  });

  assert.ok(route.points.slice(1, -1).every((point) => !pointInRect(point, sourceRect)), "self route must not enter the agent node");
  assert.ok(pathLength(route.points) < 260, "self route must remain a compact local loop");
});

test("vertical traffic uses bottom-to-top boundary ports", () => {
  const source: TopologyRect = { id: "vertical-source", x: 300, y: 100, width: 58, height: 58 };
  const target: TopologyRect = { id: "vertical-target", x: 300, y: 500, width: 58, height: 58 };
  const unrelatedConversation: TopologyRect = { id: "vertical-obstacle", x: 260, y: 250, width: 138, height: 120 };
  const ports = trafficPorts(source, target);
  const route = routeTrafficEdge({
    sourceNodeId: source.id,
    targetNodeId: target.id,
    source: ports.source,
    target: ports.target,
    sourceRect: source,
    targetRect: target,
    obstacles: [source, target, unrelatedConversation],
  });

  assert.equal(ports.sourcePort, "bottom");
  assert.equal(ports.targetPort, "top");
  assert.deepEqual(ports.source, { x: 329, y: 158 });
  assert.deepEqual(ports.target, { x: 329, y: 500 });
  assert.ok(route.points.every((point, index) => index === 0 || point.x === route.points[index - 1]!.x || point.y === route.points[index - 1]!.y));
  assert.ok(pathLength(route.points) < Math.hypot(0, 342) * 1.55, "vertical route must remain close to its boundary-to-boundary distance");
});

test("overlapping topic cards still get an axis-aligned escape route", () => {
  const bramble: TopologyRect = { id: "bramble", x: 450, y: 430, width: 58, height: 58 };
  const hearth: TopologyRect = { id: "hearth", x: 280, y: 665, width: 58, height: 58 };
  const topics: TopologyRect[] = [
    { id: "topic-center", x: 270, y: 230, width: 270, height: 250 },
    { id: "topic-lower-left", x: 30, y: 490, width: 260, height: 240 },
  ];
  const ports = trafficPorts(bramble, hearth);
  const route = routeTrafficEdge({
    sourceNodeId: bramble.id,
    targetNodeId: hearth.id,
    source: ports.source,
    target: ports.target,
    sourceRect: bramble,
    targetRect: hearth,
    obstacles: [bramble, hearth, ...topics],
  });

  assert.ok(route.points.every((point, index) => index === 0 || point.x === route.points[index - 1]!.x || point.y === route.points[index - 1]!.y), "fallback must not draw a diagonal through the map");
  assert.ok(pathLength(route.points) < 460, "overlap escape must remain local");
});

test("map disclosure suppresses idle history but keeps a selected idle link visible", () => {
  const link = (id: string, recentEventCount: number, messagesPerMinute: number): any => ({
    id,
    recentEventCount,
    messagesPerMinute,
    lastEventAt: "2026-09-02T20:00:00.000Z",
  });
  const links = [link("idle", 0, 0), link("active", 2, 0), link("rate", 0, 1)];
  assert.deepEqual(visibleTrafficLinks(links, null).map((candidate) => candidate.id), ["active", "rate"]);
  assert.deepEqual(visibleTrafficLinks(links, "idle").map((candidate) => candidate.id), ["active", "rate", "idle"]);
});
