import type { TrafficLink } from "../domain/topology";

export type TopologyPoint = { x: number; y: number };

export type TopologyRect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TrafficRoute = {
  path: string;
  label: TopologyPoint;
  points: TopologyPoint[];
};

export type TrafficRouteInput = {
  sourceNodeId: string;
  targetNodeId: string;
  source: TopologyPoint;
  target: TopologyPoint;
  sourceRect: TopologyRect;
  targetRect: TopologyRect;
  obstacles: TopologyRect[];
};

export function visibleTrafficLinks(links: TrafficLink[], selectedLinkId: string | null): TrafficLink[] {
  return links
    .filter((link) => link.id === selectedLinkId || (link.recentEventCount ?? 0) > 0 || link.messagesPerMinute > 0)
    .sort((left, right) =>
      (right.recentEventCount ?? 0) - (left.recentEventCount ?? 0)
      || right.messagesPerMinute - left.messagesPerMinute
      || right.lastEventAt.localeCompare(left.lastEventAt)
      || left.id.localeCompare(right.id),
    )
    .slice(0, 5);
}

export type TopologyPort = "left" | "right" | "top" | "bottom";

export function trafficPorts(source: TopologyRect, target: TopologyRect): {
  source: TopologyPoint;
  target: TopologyPoint;
  sourcePort: TopologyPort;
  targetPort: TopologyPort;
} {
  const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const horizontal = Math.abs(targetCenter.x - sourceCenter.x) >= Math.abs(targetCenter.y - sourceCenter.y);
  const sourcePort: TopologyPort = horizontal
    ? (targetCenter.x >= sourceCenter.x ? "right" : "left")
    : (targetCenter.y >= sourceCenter.y ? "bottom" : "top");
  const targetPort: TopologyPort = sourcePort === "right" ? "left"
    : sourcePort === "left" ? "right"
      : sourcePort === "bottom" ? "top" : "bottom";
  const pointFor = (rect: TopologyRect, port: TopologyPort): TopologyPoint => {
    switch (port) {
      case "left": return { x: rect.x, y: rect.y + rect.height / 2 };
      case "right": return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
      case "top": return { x: rect.x + rect.width / 2, y: rect.y };
      case "bottom": return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    }
  };
  return { source: pointFor(source, sourcePort), target: pointFor(target, targetPort), sourcePort, targetPort };
}

function key(point: TopologyPoint): string {
  return `${point.x}:${point.y}`;
}

function isStrictlyInside(point: TopologyPoint, rect: TopologyRect): boolean {
  return point.x > rect.x && point.x < rect.x + rect.width
    && point.y > rect.y && point.y < rect.y + rect.height;
}

function segmentClear(start: TopologyPoint, end: TopologyPoint, obstacles: TopologyRect[], escapePoint?: TopologyPoint): boolean {
  const horizontal = start.y === end.y;
  const vertical = start.x === end.x;
  if (!horizontal && !vertical) return false;
  return obstacles.every((rect) => {
    const containsEscape = escapePoint && isStrictlyInside(escapePoint, rect);
    if (containsEscape && (key(start) === key(escapePoint) || key(end) === key(escapePoint))) return true;
    if (horizontal) {
      return !(start.y > rect.y && start.y < rect.y + rect.height
        && Math.max(Math.min(start.x, end.x), rect.x) < Math.min(Math.max(start.x, end.x), rect.x + rect.width));
    }
    return !(start.x > rect.x && start.x < rect.x + rect.width
      && Math.max(Math.min(start.y, end.y), rect.y) < Math.min(Math.max(start.y, end.y), rect.y + rect.height));
  });
}

function simplify(points: TopologyPoint[]): TopologyPoint[] {
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const previous = points[index - 1]!;
    const next = points[index + 1]!;
    return !((previous.x === point.x && point.x === next.x) || (previous.y === point.y && point.y === next.y));
  });
}

function pathFor(points: TopologyPoint[]): { path: string; label: TopologyPoint } {
  if (points.length < 3) {
    return {
      path: `M${points[0]!.x},${points[0]!.y} L${points.at(-1)!.x},${points.at(-1)!.y}`,
      label: { x: (points[0]!.x + points.at(-1)!.x) / 2, y: (points[0]!.y + points.at(-1)!.y) / 2 },
    };
  }
  const radius = 18;
  const path: string[] = [`M${points[0]!.x},${points[0]!.y}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const next = points[index + 1]!;
    const beforeDistance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const afterDistance = Math.hypot(next.x - point.x, next.y - point.y);
    const before = Math.min(radius, beforeDistance / 2);
    const after = Math.min(radius, afterDistance / 2);
    const beforePoint = {
      x: point.x + ((previous.x - point.x) / beforeDistance) * before,
      y: point.y + ((previous.y - point.y) / beforeDistance) * before,
    };
    const afterPoint = {
      x: point.x + ((next.x - point.x) / afterDistance) * after,
      y: point.y + ((next.y - point.y) / afterDistance) * after,
    };
    path.push(`L${beforePoint.x},${beforePoint.y} Q${point.x},${point.y} ${afterPoint.x},${afterPoint.y}`);
  }
  const last = points.at(-1)!;
  path.push(`L${last.x},${last.y}`);
  const middle = points[Math.floor(points.length / 2)]!;
  return { path: path.join(" "), label: middle };
}

function expandedObstacles(input: TrafficRouteInput): TopologyRect[] {
  const padding = 14;
  return input.obstacles.map((rect) => {
    if (rect.id === input.sourceNodeId || rect.id === input.targetNodeId) return rect;
    return { ...rect, x: rect.x - padding, y: rect.y - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 };
  });
}

function axisFallback(input: TrafficRouteInput): TopologyPoint[] {
  const obstacles = expandedObstacles(input);
  const vertical = Math.abs(input.target.y - input.source.y) > Math.abs(input.target.x - input.source.x);
  const lanes = vertical
    ? [
      (input.source.y + input.target.y) / 2,
      ...obstacles.flatMap((rect) => [rect.y - 18, rect.y + rect.height + 18]),
    ]
    : [
      (input.source.x + input.target.x) / 2,
      ...obstacles.flatMap((rect) => [rect.x - 18, rect.x + rect.width + 18]),
    ];
  const candidate = lanes
    .map((lane) => vertical
      ? [input.source, { x: input.source.x, y: lane }, { x: input.target.x, y: lane }, input.target]
      : [input.source, { x: lane, y: input.source.y }, { x: lane, y: input.target.y }, input.target])
    .filter((points) => points.slice(1, -1).every((point) => !obstacles.some((rect) => isStrictlyInside(point, rect))))
    .filter((points) => points.slice(0, -1).every((point, index) => segmentClear(
      point,
      points[index + 1]!,
      obstacles,
      index === 0 ? input.source : index === points.length - 2 ? input.target : undefined,
    )))
    .sort((left, right) => pathLength(left) - pathLength(right))[0];
  return candidate ?? (vertical
    ? [input.source, { x: input.source.x, y: input.target.y }, input.target]
    : [input.source, { x: input.target.x, y: input.source.y }, input.target]);
}

function pathLength(points: TopologyPoint[]): number {
  return points.slice(1).reduce((total, point, index) => total + Math.hypot(
    point.x - points[index]!.x,
    point.y - points[index]!.y,
  ), 0);
}

function gridRoute(input: TrafficRouteInput): TopologyPoint[] {
  const obstacles = expandedObstacles(input);
  const xs = [...new Set([
    input.source.x,
    input.target.x,
    ...obstacles.flatMap((rect) => [rect.x, rect.x + rect.width]),
  ])].sort((left, right) => left - right);
  const ys = [...new Set([
    input.source.y,
    input.target.y,
    ...obstacles.flatMap((rect) => [rect.y, rect.y + rect.height]),
  ])].sort((left, right) => left - right);
  const start = key(input.source);
  const goal = key(input.target);
  const pointFor = (x: number, y: number): TopologyPoint => ({ x, y });
  const blocked = (point: TopologyPoint) => key(point) !== start && key(point) !== goal && obstacles.some((rect) => isStrictlyInside(point, rect));
  const open = [{ point: input.source, cost: 0, estimate: 0, direction: "" }];
  const scores = new Map([[start, 0]]);
  const previous = new Map<string, string>();
  const directions = new Map([[start, ""]]);
  while (open.length) {
    open.sort((left, right) => left.estimate - right.estimate || left.point.y - right.point.y || left.point.x - right.point.x);
    const current = open.shift()!;
    if (key(current.point) === goal) {
      const points = [current.point];
      let cursor = goal;
      while (previous.has(cursor)) {
        cursor = previous.get(cursor)!;
        points.unshift(pointFor(...cursor.split(":").map(Number) as [number, number]));
      }
      return simplify(points);
    }
    const xIndex = xs.indexOf(current.point.x);
    const yIndex = ys.indexOf(current.point.y);
    const neighbors: Array<{ point: TopologyPoint; direction: string }> = [];
    if (xIndex > 0) neighbors.push({ point: pointFor(xs[xIndex - 1]!, current.point.y), direction: "w" });
    if (xIndex < xs.length - 1) neighbors.push({ point: pointFor(xs[xIndex + 1]!, current.point.y), direction: "e" });
    if (yIndex > 0) neighbors.push({ point: pointFor(current.point.x, ys[yIndex - 1]!), direction: "n" });
    if (yIndex < ys.length - 1) neighbors.push({ point: pointFor(current.point.x, ys[yIndex + 1]!), direction: "s" });
    for (const neighbor of neighbors) {
      if (blocked(neighbor.point) || !segmentClear(current.point, neighbor.point, obstacles, input.source)) continue;
      const distance = Math.abs(neighbor.point.x - current.point.x) + Math.abs(neighbor.point.y - current.point.y);
      const bend = directions.get(key(current.point)) && directions.get(key(current.point)) !== neighbor.direction ? 28 : 0;
      const score = (scores.get(key(current.point)) ?? 0) + distance + bend;
      if (score >= (scores.get(key(neighbor.point)) ?? Number.POSITIVE_INFINITY)) continue;
      scores.set(key(neighbor.point), score);
      previous.set(key(neighbor.point), key(current.point));
      directions.set(key(neighbor.point), neighbor.direction);
      const estimate = score + Math.abs(neighbor.point.x - input.target.x) + Math.abs(neighbor.point.y - input.target.y);
      open.push({ point: neighbor.point, cost: score, estimate, direction: neighbor.direction });
    }
  }
  return axisFallback(input);
}

function selfRoute(input: TrafficRouteInput): TopologyPoint[] {
  const own = input.sourceRect;
  const gap = 22;
  const right = own.x + own.width + gap;
  const left = own.x - gap;
  const candidates = [own.y - gap, own.y + own.height + gap];
  const routeFor = (laneY: number) => [
    input.source,
    { x: right, y: input.source.y },
    { x: right, y: laneY },
    { x: left, y: laneY },
    { x: left, y: input.target.y },
    input.target,
  ];
  return candidates
    .map(routeFor)
    .find((points) => points.slice(0, -1).every((point, index) => segmentClear(
      point,
      points[index + 1]!,
      input.obstacles.filter((rect) => rect.id === input.sourceNodeId || rect.id === input.targetNodeId ? rect : {
        ...rect,
        x: rect.x - 14,
        y: rect.y - 14,
        width: rect.width + 28,
        height: rect.height + 28,
      }),
      index === 0 ? input.source : index === points.length - 2 ? input.target : undefined,
    ))) ?? routeFor(candidates[1]!);
}

export function routeTrafficEdge(input: TrafficRouteInput): TrafficRoute {
  const points = input.sourceNodeId === input.targetNodeId ? selfRoute(input) : gridRoute(input);
  const rendered = pathFor(points);
  return {
    path: rendered.path,
    label: rendered.label,
    points,
  };
}
