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
  type ReactFlowInstance,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import type { TrafficLink, TrafficProcessor } from "../domain/topology";
import type { Agent, Topic } from "../domain/types";
import "@xyflow/react/dist/style.css";

interface ConversationNodeData extends Record<string, unknown> {
  topic: Topic;
  agents: Agent[];
  selected: boolean;
}

interface AgentNodeData extends Record<string, unknown> {
  agent: Agent;
}

interface TrafficEdgeData extends Record<string, unknown> {
  link: TrafficLink;
  selected: boolean;
  onSelect: (id: string) => void;
}

type ConversationFlowNode = Node<ConversationNodeData, "conversation">;
type AgentFlowNode = Node<AgentNodeData, "agent">;
type FlowNode = ConversationFlowNode | AgentFlowNode;

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

const conversationPositions = [
  { x: 270, y: 230 },
  { x: 20, y: 45 },
  { x: 510, y: 45 },
  { x: 30, y: 490 },
  { x: 510, y: 500 },
];

const agentPositions = [
  { x: 450, y: 430 },
  { x: 280, y: 665 },
  { x: 250, y: 20 },
  { x: 520, y: 20 },
  { x: 660, y: 370 },
  { x: 100, y: 360 },
  { x: 680, y: 150 },
  { x: 70, y: 170 },
  { x: 580, y: 675 },
  { x: 70, y: 650 },
];

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

/**
 * React Flow normally measures custom nodes with ResizeObserver. Supplying the
 * authored dimensions keeps the topology visible in embedded/browser runtimes
 * that do not provide that API, while also keeping edge anchors deterministic.
 */
function conversationDimensions(accent: Topic["accent"], selected: boolean) {
  switch (accent) {
    case "violet":
      return { width: 252, height: 232 };
    case "coral":
      return { width: 264, height: 230 };
    case "yellow":
      return { width: 238, height: 246 };
    case "blue":
      return { width: 258, height: 224 };
    default:
      return selected ? { width: 270, height: 250 } : { width: 260, height: 240 };
  }
}

function nodeHandles(width: number, height: number) {
  const centerY = Math.max(0, height / 2 - 0.5);
  return [
    { type: "target" as const, position: Position.Left, x: 0, y: centerY, width: 1, height: 1 },
    { type: "source" as const, position: Position.Right, x: width - 1, y: centerY, width: 1, height: 1 },
  ];
}

function ConversationNode({ data }: NodeProps<ConversationFlowNode>) {
  const Icon = topicIcons[Math.abs(data.topic.id.length) % topicIcons.length];
  return <button className={`conversation-node ${data.topic.accent} ${data.selected ? "selected" : ""}`} aria-label={`Open ${data.topic.title}`}>
    <Handle type="target" position={Position.Left} className="map-handle" />
    <Handle type="source" position={Position.Right} className="map-handle" />
    <Icon size={23} weight="duotone" />
    <strong>{data.topic.title}</strong>
    <span>{data.topic.recentActivityCount ? `${data.topic.recentActivityCount} recent` : `${data.topic.activityCount} posts`}</span>
    <div className="node-agents">{data.agents.slice(0, 4).map((agent) => agent.avatarPath ? <img key={agent.id} src={agent.avatarPath} alt={agent.name} /> : <b key={agent.id} aria-label={agent.name}>{agent.initials}</b>)}{data.topic.participantAgentIds.length > 4 && <i>+{data.topic.participantAgentIds.length - 4}</i>}</div>
    <small>{data.topic.description}</small>
  </button>;
}

function AgentNode({ data }: NodeProps<AgentFlowNode>) {
  return <button className={`map-agent ${data.agent.color}`} title={data.agent.name} aria-label={`${data.agent.name}, agent`}>
    <Handle type="target" position={Position.Left} className="map-handle" />
    <Handle type="source" position={Position.Right} className="map-handle" />
    {data.agent.avatarPath ? <img src={data.agent.avatarPath} alt="" /> : <b>{data.agent.initials}</b>}
  </button>;
}

function ConversationEdge(props: EdgeProps) {
  const [path] = getBezierPath({ ...props, curvature: 0.5 });
  return <BaseEdge id={props.id} path={path} className="conversation-edge-path" interactionWidth={24} />;
}

function TrafficEdge(props: EdgeProps<Edge<TrafficEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath({ ...props, curvature: 0.58 });
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
const edgeTypes = { conversation: ConversationEdge, traffic: TrafficEdge };

export function TopologyCanvas({
  topics,
  agents,
  trafficLinks,
  selectedTopicId,
  selectedLinkId,
  onSelectTopic,
  onSelectLink,
}: {
  topics: Topic[];
  agents: Agent[];
  trafficLinks: TrafficLink[];
  selectedTopicId: string;
  selectedLinkId: string | null;
  onSelectTopic: (id: string) => void;
  onSelectLink: (id: string) => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null);

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
  }, []);

  const { nodes, edges } = useMemo(() => {
    const visibleTopics = topics.slice(0, 5);
    const visibleAgents = agents.slice(0, 10);
    const conversationNodes: ConversationFlowNode[] = visibleTopics.map((topic, index) => {
      const selected = topic.id === selectedTopicId;
      const dimensions = conversationDimensions(topic.accent, selected);
      return {
        id: topic.id,
        type: "conversation",
        position: conversationPositions[index] ?? { x: 300 + index * 80, y: 200 + index * 65 },
        width: dimensions.width,
        height: dimensions.height,
        handles: nodeHandles(dimensions.width, dimensions.height),
        draggable: false,
        selectable: true,
        data: { topic, agents: topic.participantAgentIds.map((id) => agents.find((agent) => agent.id === id)).filter(Boolean) as Agent[], selected },
      };
    });
    const agentNodes: AgentFlowNode[] = visibleAgents.map((agent, index) => ({
      id: agent.id,
      type: "agent",
      position: agentPositions[index] ?? { x: 420, y: 340 },
      width: 58,
      height: 58,
      handles: nodeHandles(58, 58),
      draggable: false,
      selectable: false,
      data: { agent },
    }));
    const conversationEdges: Edge[] = visibleTopics.slice(1).map((topic, index) => ({
      id: `conversation-${index}`,
      source: visibleTopics[index % Math.max(1, visibleTopics.length)]?.id ?? topic.id,
      target: topic.id,
      type: "conversation",
      selectable: false,
    }));
    const agentIds = new Set(visibleAgents.map((agent) => agent.id));
    const trafficEdges: Array<Edge<TrafficEdgeData>> = trafficLinks
      .filter((link) => agentIds.has(link.sourceAgentId) && agentIds.has(link.targetAgentId))
      .slice(0, 5)
      .map((link) => ({
        id: link.id,
        source: link.sourceAgentId,
        target: link.targetAgentId,
        type: "traffic",
        animated: true,
        selectable: true,
        data: { link, selected: link.id === selectedLinkId, onSelect: onSelectLink },
      }));
    return { nodes: [...conversationNodes, ...agentNodes], edges: [...conversationEdges, ...trafficEdges] };
  }, [agents, onSelectLink, selectedLinkId, selectedTopicId, topics, trafficLinks]);

  return <div ref={mapRef} className="conversation-map" aria-label="Live conversation map">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.04 }}
      onInit={(instance) => {
        flowRef.current = instance;
        void instance.fitView({ padding: 0.04, duration: 0 });
      }}
      minZoom={0.62}
      maxZoom={1.22}
      connectionMode={ConnectionMode.Loose}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onNodeClick={(_, node) => node.type === "conversation" && onSelectTopic(node.id)}
      onEdgeClick={(_, edge) => edge.type === "traffic" && onSelectLink(edge.id)}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#dddcd5" gap={46} size={0.7} />
    </ReactFlow>
    <div className="map-key"><ArrowsClockwise size={13} /><span>Agent reply traffic</span><small>Select a traffic node to inspect activity</small></div>
  </div>;
}
