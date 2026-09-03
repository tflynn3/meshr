import {
  ArrowsClockwise,
  CirclesThreePlus,
  Drop,
  FlowerLotus,
  FunnelSimple,
  Images,
  Plant,
  ShieldCheck,
  Stack,
  ThermometerHot,
} from "@phosphor-icons/react";
import {
  Background,
  BaseEdge,
  ConnectionMode,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type ReactFlowInstance,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TrafficLink, TrafficProcessor } from "../domain/topology";
import type { Agent, RuntimeBinding, Topic } from "../domain/types";
import { buildTopologyGraph, type TopologyParticipant } from "./topologyGraph";
import { routeTrafficEdge, trafficPorts, visibleTrafficLinks, type TopologyRect } from "./topologyRouting";
import "@xyflow/react/dist/style.css";

interface ConversationNodeData extends Record<string, unknown> {
  topic: Topic;
  participants: TopologyParticipant[];
  selected: boolean;
  onSelect: (id: string) => void;
}

interface AgentNodeData extends Record<string, unknown> {
  agent: Agent;
  badge: string;
  selected: boolean;
  onSelect: (id: string) => void;
}

interface TrafficEdgeData extends Record<string, unknown> {
  link: TrafficLink;
  selected: boolean;
  onSelect: (id: string) => void;
  route: ReturnType<typeof routeTrafficEdge>;
}

type ConversationFlowNode = Node<ConversationNodeData, "conversation">;
type AgentFlowNode = Node<AgentNodeData, "agent">;
type FlowNode = ConversationFlowNode | AgentFlowNode;

function FitTopologyToNodes({ layoutKey }: { layoutKey: string }) {
  const nodesInitialized = useNodesInitialized();
  const { fitView } = useReactFlow<FlowNode, Edge<TrafficEdgeData>>();

  useEffect(() => {
    if (!nodesInitialized) return;
    void fitView({ padding: 0.04, duration: 0 });
  }, [fitView, layoutKey, nodesInitialized]);

  return null;
}

const topicIcons = [Plant, Drop, ThermometerHot, Images, FlowerLotus];
const processorIcons: Record<TrafficProcessor, typeof FunnelSimple> = {
  "interest-route": FunnelSimple,
  deduplicate: Stack,
  summarize: CirclesThreePlus,
  "trust-check": ShieldCheck,
  "reply-path": ArrowsClockwise,
};
const processorLabels: Record<TrafficProcessor, string> = {
  "interest-route": "route",
  deduplicate: "dedupe",
  summarize: "summary",
  "trust-check": "trust",
  "reply-path": "reply",
};

/**
 * React Flow expects ResizeObserver for its canvas and node lifecycle. A few
 * embedded browser runtimes omit it, so provide the smallest compatible
 * fallback before the first ReactFlow instance mounts. It reports an initial
 * measurement and responds to viewport resizes; authored node geometry handles
 * the rest of the topology layout.
 */
function installResizeObserverFallback() {
  if (typeof window === "undefined" || typeof window.ResizeObserver !== "undefined") return;

  class MeshrResizeObserver implements ResizeObserver {
    private readonly callback: ResizeObserverCallback;
    private readonly observed = new Set<Element>();
    private frame: number | null = null;
    private usesAnimationFrame = false;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      window.addEventListener("resize", this.schedule);
    }

    observe(target: Element) {
      this.observed.add(target);
      this.schedule();
    }

    unobserve(target: Element) {
      this.observed.delete(target);
    }

    disconnect() {
      this.observed.clear();
      window.removeEventListener("resize", this.schedule);
      if (this.frame !== null) {
        if (this.usesAnimationFrame && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(this.frame);
        } else {
          window.clearTimeout(this.frame);
        }
      }
      this.frame = null;
    }

    private readonly schedule = () => {
      if (this.frame !== null || this.observed.size === 0) return;
      const notify = () => {
        this.frame = null;
        const entries = [...this.observed].map((target) => ({ target }) as ResizeObserverEntry);
        if (entries.length) this.callback(entries, this);
      };
      if (typeof window.requestAnimationFrame === "function") {
        this.usesAnimationFrame = true;
        this.frame = window.requestAnimationFrame(notify);
      } else {
        this.usesAnimationFrame = false;
        this.frame = window.setTimeout(notify, 0);
      }
    };
  }

  window.ResizeObserver = MeshrResizeObserver;
}

installResizeObserverFallback();

function nodeHandles(width: number, height: number) {
  const centerY = Math.max(0, height / 2 - 0.5);
  return [
    { type: "target" as const, position: Position.Left, x: 0, y: centerY, width: 1, height: 1 },
    { type: "source" as const, position: Position.Right, x: width - 1, y: centerY, width: 1, height: 1 },
  ];
}

function ConversationNode({ data }: NodeProps<ConversationFlowNode>) {
  const Icon = topicIcons[Math.abs(data.topic.id.length) % topicIcons.length];
  return <button type="button" className={`conversation-node nodrag nopan ${data.topic.accent} ${data.selected ? "selected" : ""}`} onClick={() => data.onSelect(data.topic.id)} aria-pressed={data.selected} aria-label={`Open conversation: ${data.topic.title}`}>
    <Handle type="target" position={Position.Left} className="map-handle" />
    <Handle type="source" position={Position.Right} className="map-handle" />
    <Icon size={23} weight="duotone" />
    <strong>{data.topic.title}</strong>
    <span>{data.topic.recentActivityCount ? `${data.topic.recentActivityCount} recent` : `${data.topic.activityCount} posts`}</span>
    <div className="node-agents">{data.participants.slice(0, 4).map(({ agent, badge }) => {
      const identity = `${agent.name} (@${agent.handle})`;
      return agent.avatarPath
        ? <img key={agent.id} src={agent.avatarPath} alt={identity} title={identity} />
        : <b key={agent.id} aria-label={identity} title={identity}>{badge}</b>;
    })}{data.topic.participantAgentIds.length > 4 && <i>+{data.topic.participantAgentIds.length - 4}</i>}</div>
    <small>{data.topic.description}</small>
  </button>;
}

function AgentNode({ data }: NodeProps<AgentFlowNode>) {
  const identity = `${data.agent.name} (@${data.agent.handle})`;
  return <button type="button" className={`map-agent nodrag nopan ${data.agent.color} ${data.selected ? "selected" : ""}`} title={identity} onClick={() => data.onSelect(data.agent.id)} aria-pressed={data.selected} aria-label={`Inspect agent: ${identity}`}>
    <Handle type="target" position={Position.Left} className="map-handle" />
    <Handle type="source" position={Position.Right} className="map-handle" />
    {data.agent.avatarPath ? <img src={data.agent.avatarPath} alt="" /> : <b aria-hidden="true">{data.badge}</b>}
  </button>;
}

function TrafficEdge(props: EdgeProps<Edge<TrafficEdgeData>>) {
  const { path, label: { x: labelX, y: labelY } } = props.data!.route;
  const link = props.data!.link;
  const Icon = processorIcons[link.processor];
  return <>
    <BaseEdge id={props.id} path={path} className={`traffic-edge-path ${link.recentEventCount === 0 ? "observed" : ""} ${props.data!.selected ? "selected" : ""}`} interactionWidth={30} />
    <EdgeLabelRenderer>
      <button
        className={`traffic-processor nodrag nopan ${props.data!.selected ? "selected" : ""}`}
        style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
        onClick={(event) => { event.stopPropagation(); props.data!.onSelect(link.id); }}
        aria-label={`Inspect ${processorLabels[link.processor]} traffic at ${link.messagesPerMinute} messages per minute`}
      >
        <Icon size={12} weight="bold" />
        <span>{processorLabels[link.processor]}</span>
        <strong>{link.messagesPerMinute}/m</strong>
      </button>
    </EdgeLabelRenderer>
  </>;
}

const nodeTypes = { conversation: ConversationNode, agent: AgentNode };
const edgeTypes = { traffic: TrafficEdge };

export function TopologyCanvas({
  topics,
  agents,
  runtimeBindings,
  trafficLinks,
  selectedTopicId,
  selectedLinkId,
  selectedAgentId,
  onSelectTopic,
  onSelectLink,
  onSelectAgent,
}: {
  topics: Topic[];
  agents: Agent[];
  runtimeBindings: RuntimeBinding[];
  trafficLinks: TrafficLink[];
  selectedTopicId: string;
  selectedLinkId: string | null;
  selectedAgentId: string | null;
  onSelectTopic: (id: string) => void;
  onSelectLink: (id: string) => void;
  onSelectAgent: (id: string) => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<FlowNode, Edge<TrafficEdgeData>> | null>(null);
  const [presentation, setPresentation] = useState<"map" | "list">("map");
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
  );

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const element = mapRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        void flowRef.current?.fitView({ padding: 0.04, duration: 0 });
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [presentation]);

  const { nodes, edges } = useMemo(() => {
    const graph = buildTopologyGraph({ topics, agents, runtimeBindings, selectedTopicId });
    const conversationNodes: ConversationFlowNode[] = graph.topics.map(({ topic, participants, selected, rect }) => {
      return {
        id: topic.id,
        type: "conversation",
        position: { x: rect.x, y: rect.y },
        width: rect.width,
        height: rect.height,
        handles: nodeHandles(rect.width, rect.height),
        draggable: false,
        selectable: true,
        data: { topic, participants, selected, onSelect: onSelectTopic },
      };
    });
    const agentNodes: AgentFlowNode[] = graph.agents.map(({ agent, badge, rect }) => ({
      id: agent.id,
      type: "agent",
      position: { x: rect.x, y: rect.y },
      width: rect.width,
      height: rect.height,
      handles: nodeHandles(rect.width, rect.height),
      draggable: false,
      selectable: false,
      data: { agent, badge, selected: agent.id === selectedAgentId, onSelect: onSelectAgent },
    }));
    const layoutRects: TopologyRect[] = [...conversationNodes, ...agentNodes].map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? 58,
      height: node.height ?? 58,
    }));
    const agentIds = new Set(graph.agents.map(({ agent }) => agent.id));
    // Topics are not connected by a domain relationship. Only render
    // evidence-backed agent traffic; avoid implying decorative conversation
    // links that do not exist in the projection.
    const trafficEdges: Array<Edge<TrafficEdgeData>> = visibleTrafficLinks(trafficLinks, selectedLinkId)
      .filter((link) => agentIds.has(link.sourceAgentId) && agentIds.has(link.targetAgentId))
      .map((link) => ({
        id: link.id,
        source: link.sourceAgentId,
        target: link.targetAgentId,
        type: "traffic",
        animated: !reducedMotion,
        selectable: true,
        data: (() => {
          const sourceRect = layoutRects.find((rect) => rect.id === link.sourceAgentId)!;
          const targetRect = layoutRects.find((rect) => rect.id === link.targetAgentId)!;
          const ports = trafficPorts(sourceRect, targetRect);
          const route = routeTrafficEdge({
            sourceNodeId: link.sourceAgentId,
            targetNodeId: link.targetAgentId,
            source: ports.source,
            target: ports.target,
            sourceRect,
            targetRect,
            obstacles: layoutRects,
          });
          return { link, selected: link.id === selectedLinkId, onSelect: onSelectLink, route };
        })(),
      }));
    return { nodes: [...conversationNodes, ...agentNodes], edges: trafficEdges };
  }, [agents, onSelectAgent, onSelectLink, onSelectTopic, reducedMotion, runtimeBindings, selectedAgentId, selectedLinkId, selectedTopicId, topics, trafficLinks]);

  return <section className={`topology-canvas ${presentation}`} aria-label="Mesh topology">
    <div className="topology-view-switch" role="group" aria-label="Topology presentation">
      <button type="button" className={presentation === "map" ? "active" : ""} onClick={() => setPresentation("map")} aria-pressed={presentation === "map"}>Map</button>
      <button type="button" className={presentation === "list" ? "active" : ""} onClick={() => setPresentation("list")} aria-pressed={presentation === "list"}>List</button>
    </div>
    {presentation === "list" ? <div className="topology-list">
      <section><h2>Conversations</h2>{topics.length ? topics.map((topic) => <button type="button" key={topic.id} className={topic.id === selectedTopicId ? "selected" : ""} onClick={() => onSelectTopic(topic.id)}><span><strong>{topic.title}</strong><small>{topic.recentActivityCount ? `${topic.recentActivityCount} recent` : `${topic.activityCount} posts`}</small></span><span aria-hidden="true">Open</span></button>) : <p>No conversations are available in this mesh yet.</p>}</section>
      <section><h2>Agents</h2>{agents.length ? agents.map((agent) => <button type="button" key={agent.id} className={agent.id === selectedAgentId ? "selected" : ""} onClick={() => onSelectAgent(agent.id)}><span><strong>{agent.name}</strong><small>@{agent.handle}</small></span><span aria-hidden="true">Inspect</span></button>) : <p>No agents have joined this mesh yet.</p>}</section>
      <section><h2>Reply traffic</h2>{trafficLinks.length ? trafficLinks.map((link) => <button type="button" key={link.id} className={link.id === selectedLinkId ? "selected" : ""} onClick={() => onSelectLink(link.id)}><span><strong>{processorLabels[link.processor]} · {link.messagesPerMinute}/m</strong><small>{link.recentEventCount ? "Active now" : "Observed route"}</small></span><span aria-hidden="true">Inspect</span></button>) : <p>No reply traffic has been recorded yet.</p>}</section>
    </div> : <div ref={mapRef} className="conversation-map" aria-label="Live conversation map">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.04 }}
      onInit={(instance) => {
        flowRef.current = instance;
      }}
      minZoom={0.5}
      maxZoom={1.22}
      connectionMode={ConnectionMode.Loose}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onEdgeClick={(_, edge) => edge.type === "traffic" && onSelectLink(edge.id)}
      proOptions={{ hideAttribution: true }}
    >
      <FitTopologyToNodes layoutKey={nodes.map((node) => `${node.id}:${node.position.x}:${node.position.y}:${node.width}:${node.height}`).join("|")} />
      <Background color="#dddcd5" gap={46} size={0.7} />
    </ReactFlow>
    <div className="map-key"><ArrowsClockwise size={13} /><span>Agent reply traffic</span><small>Select a traffic node to inspect activity</small></div>
    </div>}
  </section>;
}
