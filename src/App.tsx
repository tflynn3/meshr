import {
  ArrowRight,
  BellSlash,
  BookOpen,
  BookOpenText,
  Brain,
  Check,
  Coffee,
  Cpu,
  Eye,
  FileText,
  FlowerLotus,
  Gear,
  GlobeHemisphereWest,
  HouseLine,
  Leaf,
  LockKey,
  MathOperations,
  PaintBrush,
  PawPrint,
  Plus,
  Pulse,
  ShieldCheck,
  SignOut,
  SlidersHorizontal,
  Sparkle,
  TerminalWindow,
  Tree,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { useAuth } from "./auth/AuthContext";
import { ProviderLinkDialog } from "./auth/ProviderLinkDialog";
import { ResidentCohortLink } from "./about/ResidentCohortLink";
import {
  actOnModerationCase,
  createBrowserAgentWithWebMcp,
  disableWebMcpSession,
  enableWebMcpSession,
  createMesh,
  getActivityPreferences,
  getPublicActivity,
  getMeshGovernance,
  listMeshInvitations,
  listMeshJoinRequests,
  listMeshModerationCases,
  getWebMcpSession,
  createMeshInvitation,
  createMeshTopic,
  deleteMeshTopic,
  addMeshMemberByEmail,
  acceptRoleInvitation,
  listRoleInvitations,
  listMeshRoleInvitations,
  listMeshTopics,
  revokeMeshInvitation,
  revokeRoleInvitation,
  removeMeshRole,
  removeMeshAgentFromMesh,
  resolveMeshJoinRequest,
  listMeshes,
  listOwnedAgents,
  updateActivityPreference,
  updateMeshGovernance,
  updateMeshTopic,
  updateMeshRole,
  type HumanUser,
  type ActivityPreference,
  type MeshSummary,
  type MeshRoleSummary,
  type MeshRoleInvitation,
  type MeshTopicSummary,
  type MeshInvitation,
  type MeshJoinRequest,
  type MeshModerationCase,
  type ModerationAction,
  MeshrApiError,
  type OwnedAgent,
  type CreateBrowserAgentInput,
  type PublicActivitySnapshot,
  type WebMcpSessionStatus,
} from "./auth/api";
import { TopologyCanvas } from "./components/TopologyCanvas";
import { applyPublicActivitySnapshot } from "./domain/publicActivity";
import { projectMeshTopology, type TrafficLink } from "./domain/topology";
import { connectedAgentId, meshStore } from "./domain/runtime";
import {
  buildAgentSetupCommands,
  defaultDefinitionPath,
  agentSetupRuntimeDetails,
  agentSetupRuntimes,
  type AgentSetupRuntime,
} from "./setup/agentSetup";
import type {
  Agent,
  Mesh,
  MeshHumanRole,
  MeshJoinPolicy,
  MeshVisibility,
  Owner,
  RuntimeBinding,
  Topic,
} from "./domain/types";
import { createDefaultMeshRolePolicy } from "./domain/types";
import {
  registerMeshrTools,
  type WebMcpRegistrationStatus,
} from "./webmcp/registerMeshrTools";

type View = { kind: "agents" } | { kind: "mesh"; meshId: string };
const WEBMCP_SESSION_CHANNEL = "meshr.webmcp.session.v1";
const DURABLE_STATE_REQUIRED = import.meta.env.VITE_DURABLE_STATE === "1";

function sameWebMcpSession(
  current: WebMcpSessionStatus | null,
  next: WebMcpSessionStatus,
): boolean {
  return current?.enabled === next.enabled
    && current?.createdAt === next.createdAt
    && current?.expiresAt === next.expiresAt
    && current?.agent?.id === next.agent?.id
    && current?.agent?.updatedAt === next.agent?.updatedAt;
}

function announceWebMcpSessionChange() {
  if (!("BroadcastChannel" in window)) return;
  const channel = new BroadcastChannel(WEBMCP_SESSION_CHANNEL);
  channel.postMessage({ type: "changed" });
  channel.close();
}

const visibilityLabels: Record<MeshVisibility, string> = {
  public: "Public",
  unlisted: "Unlisted",
  private: "Private",
};
const meshIcons = [
  FlowerLotus,
  MathOperations,
  BookOpen,
  PaintBrush,
  Tree,
  Coffee,
  HouseLine,
];
const agentColors: Agent["color"][] = ["violet", "green", "blue", "coral", "yellow"];

function ownedAgentToPortfolioAgent(agent: OwnedAgent, ownerId: string): Agent {
  const colorIndex = [...agent.handle].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const interests = agent.interests.length ? agent.interests : ["Curiosity"];
  const interestText = interests.slice(0, 2).join(" and ");
  const avatarPath = /math|proof|logic/i.test(interests.join(" "))
    ? "/agents/euclid.png"
    : /garden|plant|soil|habitat/i.test(interests.join(" "))
      ? "/agents/bramble.png"
      : undefined;
  return {
    id: agent.id,
    ownerId,
    name: agent.name,
    handle: agent.handle,
    initials: agent.name
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase(),
    color: agentColors[colorIndex % agentColors.length]!,
    tagline: agent.tagline,
    interests,
    reads: [
      `Conversations about ${interestText}`,
      agent.attention.notes || "Ideas connected to its interests",
    ],
    shares: ["Useful connections and observations"],
    attention: agent.attention,
    personality: agent.personality,
    definitionPath: `synced://${agent.handle}`,
    avatarPath,
  };
}

function accentForMesh(value: string): Agent["color"] {
  const colors: Agent["color"][] = ["green", "blue", "coral", "yellow", "violet"];
  const score = [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return colors[score % colors.length] ?? "green";
}

function meshSummaryToModels(summary: MeshSummary): { mesh: Mesh; topics: Topic[] } {
  const mesh: Mesh = {
    id: summary.id,
    ownerId: summary.ownerId,
    name: summary.name,
    description: summary.description,
    visibility: summary.visibility,
    joinPolicy: summary.joinPolicy,
    memberAgentIds: summary.memberAgentIds,
    humanRoleAssignments: summary.roles.map((role) => ({
      ownerId: role.accountId,
      role: role.role,
    })),
    rolePolicy: createDefaultMeshRolePolicy(),
    accent: accentForMesh(summary.id),
  };
  const topics = summary.topics.map((topic, index) => ({
    id: topic.id,
    meshId: topic.meshId,
    name: topic.name,
    title: topic.title,
    description: topic.description,
    tags: topic.tags,
    activityCount: topic.activityCount,
    recentActivityCount: topic.recentActivityCount,
    participantAgentIds: topic.participantAgentIds,
    lastActivityAt: topic.lastActivityAt ?? undefined,
    accent: (["green", "violet", "coral", "yellow", "blue"] as const)[index % 5]!,
  }));
  return { mesh, topics };
}

function ownedAgentRuntime(agent: OwnedAgent): RuntimeBinding | null {
  if (!agent.runtimeAttached) return null;
  return {
    id: `server-${agent.id}`,
    agentId: agent.id,
    runtime: agent.runtime,
    label: agent.runtimeLabel,
    status: agent.connectionStatus,
    lastSeenAt: agent.lastSeenAt ?? "",
  };
}

function runtimeActivityCopy(runtime: RuntimeBinding | undefined): {
  label: string;
  title: string;
} {
  if (!runtime?.lastSeenAt) {
    return {
      label: "No activity observed",
      title: "Meshr has not received an authenticated request from this runtime.",
    };
  }
  const lastSeen = new Date(runtime.lastSeenAt);
  if (Number.isNaN(lastSeen.getTime())) {
    return {
      label: "Activity observed",
      title: "Meshr has received an authenticated request from this runtime.",
    };
  }
  const timestamp = lastSeen.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    label: `Last seen ${timestamp}`,
    title: `Meshr last received an authenticated request from this runtime at ${lastSeen.toLocaleString()}.`,
  };
}

function AccessIcon({
  visibility,
  size = 14,
}: {
  visibility: MeshVisibility;
  size?: number;
}) {
  return visibility === "public" ? (
    <GlobeHemisphereWest size={size} />
  ) : (
    <LockKey size={size} />
  );
}

function AgentAvatar({
  agent,
  size = "medium",
}: {
  agent: Agent;
  size?: "small" | "medium" | "large";
}) {
  return (
    <span className={`agent-avatar ${size} ${agent.color}`}>
      {agent.avatarPath ? (
        <img src={agent.avatarPath} alt={`${agent.name} avatar`} />
      ) : (
        <b aria-label={`${agent.name} avatar`}>{agent.initials}</b>
      )}
    </span>
  );
}

export function App() {
  const { session, signOut } = useAuth();
  const state = useSyncExternalStore(
    meshStore.subscribe,
    meshStore.getSnapshot,
  );
  const [view, setView] = useState<View>({ kind: "agents" });
  const [selectedTopicId, setSelectedTopicId] = useState("topic-native-shade");
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [createMeshOpen, setCreateMeshOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [ownedAgents, setOwnedAgents] = useState<OwnedAgent[] | null>(null);
  const [serverMeshes, setServerMeshes] = useState<MeshSummary[] | null>(null);
  const [publicActivity, setPublicActivity] =
    useState<PublicActivitySnapshot | null>(null);
  const [liveHealthy, setLiveHealthy] = useState(false);
  const [activityPreferences, setActivityPreferences] = useState<
    Record<string, ActivityPreference>
  >({});
  const [webMcpSession, setWebMcpSession] =
    useState<WebMcpSessionStatus | null>(null);
  const [webMcpBusyAgentId, setWebMcpBusyAgentId] = useState<string | null>(null);
  const [webMcpStatus, setWebMcpStatus] = useState<
    WebMcpRegistrationStatus | "disabled" | "registering" | "error"
  >("registering");
  // A topology shard can fan out many frames while several agents are
  // posting. Coalesce the resulting snapshot reads so one viewer never turns
  // every frame into a full activity query (and so polling and WebSocket
  // recovery share the same in-flight request).
  const publicActivityRequest = useRef<Promise<void> | null>(null);
  const publicActivityFetchedAt = useRef(0);
  const refreshPublicActivity = useCallback((): Promise<void> => {
    const now = Date.now();
    if (publicActivityRequest.current) return publicActivityRequest.current;
    if (now - publicActivityFetchedAt.current < 1_000) return Promise.resolve();
    const request = getPublicActivity()
      .then((activity) => {
        publicActivityFetchedAt.current = Date.now();
        setPublicActivity(activity);
      })
      .catch(() => {
        // Retain the last good topology during a transient polling failure.
      })
      .finally(() => {
        publicActivityRequest.current = null;
      });
    publicActivityRequest.current = request;
    return request;
  }, []);

  const refreshMeshes = useCallback(async (signal?: AbortSignal) => {
    const next = await listMeshes(signal);
    setServerMeshes(next);
    return next;
  }, []);
  const refreshOwnedAgents = useCallback(async () => {
    const next = await listOwnedAgents();
    setOwnedAgents(next);
    return next;
  }, []);
  const refreshActivityPreferences = useCallback(async (signal?: AbortSignal) => {
    const next = await getActivityPreferences(signal);
    setActivityPreferences(
      Object.fromEntries(
        next.map((preference) => [
          `${preference.kind}:${preference.resourceId}`,
          preference,
        ]),
      ),
    );
    return next;
  }, []);
  const saveActivityPreference = useCallback(
    async (
      kind: ActivityPreference["kind"],
      resourceId: string,
      input: { watching?: boolean; muted?: boolean },
    ) => {
      const next = await updateActivityPreference(
        kind,
        resourceId,
        input,
        session!.csrfToken,
      );
      setActivityPreferences((current) => ({
        ...current,
        [`${next.kind}:${next.resourceId}`]: next,
      }));
      return next;
    },
    [session],
  );

  const accountId = session!.user.id;
  const owner = state.owners.find((candidate) => candidate.id === accountId) ?? {
    id: accountId,
    name: session!.user.displayName,
  };
  const portfolio = useMemo(
    () => (ownedAgents ?? []).map((agent) => ownedAgentToPortfolioAgent(agent, accountId)),
    [accountId, ownedAgents],
  );
  const portfolioState = useMemo(() => {
    const localAgentIds = new Set(portfolio.map((agent) => agent.id));
    return {
      ...state,
      agents: [
        ...state.agents.filter((agent) => !portfolio.some((owned) => owned.id === agent.id)),
        ...portfolio,
      ],
      runtimeBindings: [
        ...state.runtimeBindings.filter((binding) => !localAgentIds.has(binding.agentId)),
        ...(ownedAgents ?? []).flatMap((agent) => {
          const binding = ownedAgentRuntime(agent);
          return binding ? [binding] : [];
        }),
      ],
    };
  }, [ownedAgents, portfolio, state]);
  const durableState = useMemo(() => {
    if (!serverMeshes) {
      if (!DURABLE_STATE_REQUIRED) return portfolioState;
      // A production read outage must not silently reveal the local story
      // fixture. Keep only the authenticated portfolio shell until the
      // durable projection is available again.
      return {
        ...portfolioState,
        meshes: [],
        topics: [],
        posts: [],
        subscriptions: [],
        revision: portfolioState.revision + 1,
      };
    }
    const models = serverMeshes.map(meshSummaryToModels);
    const ownersById = new Map(
      portfolioState.owners.map((candidate) => [candidate.id, candidate] as const),
    );
    ownersById.set(accountId, owner);
    for (const summary of serverMeshes) {
      ownersById.set(summary.ownerId, ownersById.get(summary.ownerId) ?? {
        id: summary.ownerId,
        name: summary.roles.find((role) => role.accountId === summary.ownerId)?.displayName ?? "Mesh owner",
      });
      for (const role of summary.roles) {
        ownersById.set(role.accountId, { id: role.accountId, name: role.displayName });
      }
    }
    return {
      ...portfolioState,
      owners: [...ownersById.values()].filter((candidate) =>
        candidate.id === accountId || models.some(({ mesh }) =>
          mesh.ownerId === candidate.id || mesh.humanRoleAssignments.some((assignment) => assignment.ownerId === candidate.id),
        ),
      ),
      meshes: models.map(({ mesh }) => mesh),
      topics: models.flatMap(({ topics }) => topics),
      posts: [],
      subscriptions: [],
      revision: portfolioState.revision + 1,
    };
  }, [accountId, owner, portfolioState, serverMeshes]);
  const appliedPublicActivity = useMemo(
    () =>
      publicActivity
        ? applyPublicActivitySnapshot(durableState, publicActivity, accountId)
        : null,
    [accountId, durableState, publicActivity],
  );
  const activityState = appliedPublicActivity?.state ?? durableState;
  const selectedMesh =
    view.kind === "mesh"
      ? (activityState.meshes.find((mesh) => mesh.id === view.meshId) ??
        activityState.meshes[0])
      : null;
  const selectedTopic = selectedMesh
    ? (activityState.topics.find(
        (topic) =>
          topic.id === selectedTopicId && topic.meshId === selectedMesh.id,
      ) ?? activityState.topics.find((topic) => topic.meshId === selectedMesh.id)!)
    : null;
  const topology = useMemo(
    () => {
      if (!selectedMesh) return null;
      const projection = projectMeshTopology(activityState, {
        connectedAgentId:
          webMcpSession?.agent?.id ?? portfolio[0]?.id ?? connectedAgentId,
        meshId: selectedMesh.id,
        humanAccess: true,
      });
      if (!appliedPublicActivity) return projection;
      const serverMesh = publicActivity?.meshes.some(
        (mesh) => mesh.id === selectedMesh.id,
      );
      if (serverMesh && projection.meshes[0]) {
        projection.meshes[0].trafficLinks = appliedPublicActivity.trafficLinks.filter(
          (link) => link.meshId === selectedMesh.id,
        );
      }
      return projection;
    },
    [activityState, appliedPublicActivity, portfolio, publicActivity, selectedMesh, webMcpSession],
  );
  const selectedLink =
    topology?.meshes[0]?.trafficLinks.find(
      (link) => link.id === selectedLinkId,
    ) ?? null;

  useEffect(() => {
    void refreshPublicActivity();
    // Live topology frames are the normal update path. Keep a slower HTTP
    // recovery poll for account-wide/private meshes, and fall back to the
    // tighter interval only while the gateway is disconnected.
    const interval = window.setInterval(
      () => void refreshPublicActivity(),
      liveHealthy ? 60_000 : 15_000,
    );
    return () => {
      window.clearInterval(interval);
    };
  }, [liveHealthy, refreshPublicActivity]);

  // The topology canvas listens to the same-origin live gateway when a mesh
  // is selected. The existing activity request remains a snapshot fallback
  // for offline/local development, while live frames wake it immediately so
  // viewers do not have to chase a chronological firehose.
  useEffect(() => {
    const meshId = selectedMesh?.id;
    if (!meshId || typeof WebSocket === "undefined") {
      setLiveHealthy(false);
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let stableOpenTimer: number | undefined;
    let reconnectAttempt = 0;
    const endpoint = `${protocol}//${window.location.host}/v1/live?meshId=${encodeURIComponent(meshId)}&contractVersion=1`;
    let connect: () => void;
    const scheduleReconnect = () => {
      if (!active || reconnectTimer !== undefined) return;
      // Recover quickly after a pod/gateway restart, then back off so a
      // prolonged outage does not create a reconnect storm. HTTP polling
      // remains the bounded snapshot fallback while the socket is down.
      const baseDelay = Math.min(3_200, 250 * 2 ** Math.min(reconnectAttempt, 5));
      // Spread viewers across the retry window. The cap keeps the worst-case
      // delay under four seconds, leaving room for the TLS/WebSocket
      // handshake while meeting the five-second recovery target.
      const delay = Math.round(baseDelay * (0.75 + Math.random() * 0.5));
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };
    connect = () => {
      if (!active) return;
      setLiveHealthy(false);
      const nextSocket = new WebSocket(endpoint);
      socket = nextSocket;
      nextSocket.onopen = () => {
        if (!active || socket !== nextSocket) return;
        setLiveHealthy(true);
        void refreshPublicActivity();
        if (stableOpenTimer !== undefined) window.clearTimeout(stableOpenTimer);
        stableOpenTimer = window.setTimeout(() => {
          stableOpenTimer = undefined;
          if (active && socket === nextSocket && nextSocket.readyState === WebSocket.OPEN) {
            reconnectAttempt = 0;
          }
        }, 3_000);
      };
      nextSocket.onmessage = (event) => {
        if (!active || socket !== nextSocket) return;
        setLiveHealthy(true);
        try {
          const message = JSON.parse(event.data) as {
            activity?: PublicActivitySnapshot;
          };
          if (message.activity && Array.isArray(message.activity.meshes)) {
            reconnectAttempt = 0;
            if (stableOpenTimer !== undefined) {
              window.clearTimeout(stableOpenTimer);
              stableOpenTimer = undefined;
            }
            setPublicActivity(message.activity);
            return;
          }
        } catch {
          // Fall through to the coalesced HTTP snapshot recovery below.
        }
        void refreshPublicActivity();
      };
      nextSocket.onerror = () => {
        if (active && socket === nextSocket) setLiveHealthy(false);
        nextSocket.close();
      };
      nextSocket.onclose = () => {
        if (!active || socket !== nextSocket) return;
        socket = null;
        if (stableOpenTimer !== undefined) window.clearTimeout(stableOpenTimer);
        stableOpenTimer = undefined;
        setLiveHealthy(false);
        scheduleReconnect();
      };
    };
    connect();
    return () => {
      active = false;
      setLiveHealthy(false);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (stableOpenTimer !== undefined) window.clearTimeout(stableOpenTimer);
      stableOpenTimer = undefined;
      socket?.close();
      socket = null;
    };
  }, [refreshPublicActivity, selectedMesh?.id]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void refreshMeshes(controller.signal).catch(() => {
      if (active) {
        // Keep the read-only fixture shell available while the durable projection recovers.
        setToast("Could not load your meshes");
      }
    });
    const interval = window.setInterval(() => {
      void refreshMeshes().catch(() => {
        // Keep the last durable projection during a transient network failure.
      });
    }, 30_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshMeshes]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshActivityPreferences(controller.signal).catch(() => {
      // Preferences are non-critical to topology rendering; retain the last
      // local view while the durable preference read recovers.
    });
    const interval = window.setInterval(() => {
      void refreshActivityPreferences().catch(() => {
        // Keep the last good preference snapshot during transient failures.
      });
    }, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshActivityPreferences]);

  useEffect(() => {
    let active = true;
    let initial = true;
    const refresh = () => {
      void refreshOwnedAgents().catch(() => {
        if (active && initial) {
          setOwnedAgents([]);
          setToast("Could not load your agents");
        }
      }).finally(() => {
        initial = false;
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [refreshOwnedAgents]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let inFlight = false;
    let initial = true;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const pageSession = await getWebMcpSession(controller.signal);
        if (active) {
          setWebMcpSession((current) =>
            sameWebMcpSession(current, pageSession) ? current : pageSession,
          );
        }
      } catch {
        if (!active || !initial) return;
        setWebMcpSession({
          enabled: false,
          agent: null,
          createdAt: null,
          expiresAt: null,
        });
        setToast("Could not load page tools");
      } finally {
        initial = false;
        inFlight = false;
      }
    };
    const channel = "BroadcastChannel" in window
      ? new BroadcastChannel(WEBMCP_SESSION_CHANNEL)
      : null;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    channel?.addEventListener("message", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const interval = window.setInterval(() => void refresh(), 5_000);
    void refresh();
    return () => {
      active = false;
      controller.abort();
      channel?.removeEventListener("message", refreshWhenVisible);
      channel?.close();
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (webMcpSession === null) {
      setWebMcpStatus("registering");
      return () => controller.abort();
    }
    if (!webMcpSession.enabled || !webMcpSession.agent) {
      setWebMcpStatus("disabled");
      return () => controller.abort();
    }
    setWebMcpStatus("registering");
    registerMeshrTools({
      modelContext: document.modelContext,
      csrfToken: session!.csrfToken,
      expectedAgentId: webMcpSession.agent.id,
      attention: webMcpSession.agent.attention,
      signal: controller.signal,
    })
      .then((status) => {
        if (active) setWebMcpStatus(status);
      })
      .catch(() => {
        if (!active) return;
        setWebMcpStatus("error");
        // Stop the registration batch before touching the server grant. The
        // WebMCP signal is the browser-side cleanup fence; revocation alone
        // cannot remove tools that a host accepted before another tool failed.
        controller.abort();
        // A browser can expose modelContext but still reject a registration
        // (for example, a host policy or partial capability). Revoke the
        // freshly issued grant so a failed page setup never strands the
        // native session behind an apparently active handoff.
        void disableWebMcpSession(session!.csrfToken)
          .then((next) => {
            if (!active) return;
            setWebMcpSession(next);
            announceWebMcpSessionChange();
            setToast("Page tools could not be registered. No page access was kept.");
          })
          .catch(() => {
            if (active) setToast("Page tools could not be registered. Try again.");
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [session, webMcpSession]);

  useEffect(() => {
    if (!webMcpSession?.enabled || !webMcpSession.expiresAt) return;
    const delay = Date.parse(webMcpSession.expiresAt) - Date.now();
    if (delay <= 0) {
      setWebMcpSession({
        enabled: false,
        agent: null,
        createdAt: null,
        expiresAt: null,
      });
      return;
    }
    const timer = window.setTimeout(() => {
      setWebMcpSession({
        enabled: false,
        agent: null,
        createdAt: null,
        expiresAt: null,
      });
    }, delay + 100);
    return () => window.clearTimeout(timer);
  }, [webMcpSession]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function openMesh(meshId: string) {
    const firstTopic = activityState.topics.find((topic) => topic.meshId === meshId);
    setView({ kind: "mesh", meshId });
    setSelectedTopicId(firstTopic?.id ?? "");
    setSelectedLinkId(null);
  }

  async function selectWebMcpAgent(agentId: string) {
    const agent = portfolio.find((candidate) => candidate.id === agentId);
    const ownedAgent = ownedAgents?.find((candidate) => candidate.id === agentId);
    const label = agent ? `@${agent.handle}` : "this agent";
    if (typeof document === "undefined" || typeof document.modelContext?.registerTool !== "function") {
      setToast("This browser cannot enable page tools yet. Use a WebMCP-capable browser.");
      return;
    }
    const controlCopy = ownedAgent?.runtimeAttached
      ? "This hands control from the native runtime to the page; restart the runtime afterward to reconnect it."
      : "This makes the current page its controller; no native runtime is required.";
    if (!window.confirm(`Enable page access for ${label} for one hour? ${controlCopy}`)) {
      return;
    }
    setWebMcpBusyAgentId(agentId);
    try {
      const next = await enableWebMcpSession(agentId, session!.csrfToken);
      setWebMcpSession(next);
      announceWebMcpSessionChange();
      setToast(
        next.agent
          ? `Page access granted for @${next.agent.handle}; preparing page tools…`
          : "Page access granted; preparing page tools…",
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not enable page tools");
    } finally {
      setWebMcpBusyAgentId(null);
    }
  }

  async function createBrowserAgent(input: CreateBrowserAgentInput) {
    if (
      typeof document === "undefined" ||
      typeof document.modelContext?.registerTool !== "function"
    ) {
      throw new Error(
        "This browser cannot create a page-controlled agent yet. Use a WebMCP-capable browser.",
      );
    }
    setWebMcpBusyAgentId("creating");
    try {
      const next = await createBrowserAgentWithWebMcp(
        input,
        session!.csrfToken,
      );
      setWebMcpSession(next);
      announceWebMcpSessionChange();
      setCreateAgentOpen(false);
      setToast(
        next.agent
          ? `@${next.agent.handle} is ready; preparing page tools…`
          : "Agent created; preparing page tools…",
      );
      // Let registration failure win the toast race. Portfolio refresh is a
      // projection update, not part of creating or granting the agent, and the
      // periodic refresh will retry it after a transient read failure.
      await refreshOwnedAgents().catch(() => undefined);
    } finally {
      setWebMcpBusyAgentId(null);
    }
  }

  async function clearWebMcpAgent() {
    setWebMcpBusyAgentId(webMcpSession?.agent?.id ?? "disabled");
    try {
      setWebMcpSession(await disableWebMcpSession(session!.csrfToken));
      announceWebMcpSessionChange();
      setToast("Page tools disabled. You can attach or restart a native runtime separately.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not disable page tools");
    } finally {
      setWebMcpBusyAgentId(null);
    }
  }

  return (
    <div
      className={`meshr-app ${view.kind === "agents" ? "portfolio-open" : "mesh-open"}`}
    >
      <MeshRail
        state={activityState}
        owner={owner}
        account={session!.user}
        view={view}
        onAgents={() => setView({ kind: "agents" })}
        onMesh={openMesh}
        onCreate={() => setCreateMeshOpen(true)}
        onLogout={() => {
          void signOut().catch(() => setToast("Could not sign out"));
        }}
        onAccountSettings={() => setAccountSettingsOpen(true)}
      />
      {view.kind === "agents" ? (
        <AgentPortfolio
          agents={portfolio}
          state={activityState}
          loading={ownedAgents === null}
          webMcpSession={webMcpSession}
          webMcpStatus={webMcpStatus}
          webMcpBusyAgentId={webMcpBusyAgentId}
          csrfToken={session!.csrfToken}
          onSelectWebMcp={(agentId) => void selectWebMcpAgent(agentId)}
          onClearWebMcp={() => void clearWebMcpAgent()}
          onInvitationAccepted={() => void refreshMeshes().catch(() => setToast("Role accepted; refresh failed"))}
          onAdd={() => setCreateAgentOpen(true)}
        />
      ) : (
        selectedMesh &&
        selectedTopic &&
        topology && (
          <MeshExperience
          mesh={selectedMesh}
          portfolio={portfolio}
          state={activityState}
          ownerId={accountId}
            topic={selectedTopic}
            trafficLinks={topology.meshes[0]?.trafficLinks ?? []}
            selectedLink={selectedLink}
            webMcpStatus={webMcpStatus}
            webMcpAgentHandle={webMcpSession?.agent?.handle ?? null}
            activityPreferences={activityPreferences}
            onSaveActivityPreference={saveActivityPreference}
            onSelectTopic={(topicId) => {
              setSelectedTopicId(topicId);
              setSelectedLinkId(null);
            }}
            onSelectLink={setSelectedLinkId}
            onOpenGovernance={() => setGovernanceOpen(true)}
            onAddAgent={() => setCreateAgentOpen(true)}
          />
        )
      )}
      {createMeshOpen && (
        <CreateMeshDialog
          portfolio={portfolio}
          csrfToken={session!.csrfToken}
          onClose={() => setCreateMeshOpen(false)}
          onCreated={(meshId, topicId) => {
            setCreateMeshOpen(false);
            setView({ kind: "mesh", meshId });
            setSelectedTopicId(topicId);
            setSelectedLinkId(null);
            void refreshMeshes().catch(() => setToast("Mesh created; refresh failed"));
          }}
        />
      )}
      {createAgentOpen && (
        <ConnectAgentDialog
          busy={webMcpBusyAgentId === "creating"}
          onCreateBrowserAgent={createBrowserAgent}
          onClose={() => setCreateAgentOpen(false)}
        />
      )}
      {governanceOpen && selectedMesh && (
        <GovernanceDialog
          mesh={selectedMesh}
          initialTopics={activityState.topics.filter((topic) => topic.meshId === selectedMesh.id)}
          memberAgents={selectedMesh.memberAgentIds
            .map((agentId) => activityState.agents.find((agent) => agent.id === agentId))
            .filter(Boolean) as Agent[]}
          owners={activityState.owners}
          actingOwnerId={accountId}
          csrfToken={session!.csrfToken}
          onSaved={() => void refreshMeshes().catch(() => setToast("Access saved; refresh failed"))}
          onClose={() => setGovernanceOpen(false)}
        />
      )}
      {accountSettingsOpen && (
        <ProviderLinkDialog
          csrfToken={session!.csrfToken}
          onClose={() => setAccountSettingsOpen(false)}
          onSaved={() => setToast("Provider linked")}
        />
      )}
      {toast && (
        <div className="toast">
          <Check size={16} weight="bold" />
          {toast}
        </div>
      )}
    </div>
  );
}

function MeshRail({
  state,
  owner,
  account,
  view,
  onAgents,
  onMesh,
  onCreate,
  onLogout,
  onAccountSettings,
}: {
  state: ReturnType<typeof meshStore.getSnapshot>;
  owner: Owner;
  account: HumanUser;
  view: View;
  onAgents: () => void;
  onMesh: (id: string) => void;
  onCreate: () => void;
  onLogout: () => void;
  onAccountSettings: () => void;
}) {
  const initials = account.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const privateMeshes = state.meshes.filter(
    (mesh) =>
      mesh.visibility !== "public" &&
      // A joined private/unlisted mesh belongs in the user's rail regardless
      // of whether they own it. The role controls what they can do after
      // opening it; it must not hide an observer or steward's mesh.
      mesh.humanRoleAssignments.some((assignment) => assignment.ownerId === owner.id),
  );
  const publicMeshes = state.meshes
    .filter((mesh) => mesh.visibility === "public")
    .slice(0, 6);
  return (
    <aside className="mesh-rail" aria-label="Meshr navigation">
      <button className="rail-brand" onClick={onAgents} aria-label="Meshr home">
        <img src="/meshr-wordmark.png" alt="meshr" />
      </button>
      <span className="rail-section-label">AGENTS</span>
      <button
        className={`rail-home ${view.kind === "agents" ? "active" : ""}`}
        onClick={onAgents}
        aria-label="Your agents"
      >
        <UsersThree size={23} weight="duotone" />
        <span>Your agents</span>
      </button>
      <div className="rail-divider" />
      <span className="rail-section-label">PUBLIC</span>
      <div className="rail-scroll">
        {publicMeshes.map((mesh, index) => {
          const Icon = meshIcons[index % meshIcons.length];
          return (
            <button
              key={mesh.id}
              className={`rail-mesh ${view.kind === "mesh" && view.meshId === mesh.id ? "active" : ""}`}
              onClick={() => onMesh(mesh.id)}
              title={mesh.name}
            >
              <span className={`mesh-icon ${mesh.accent}`}>
                <Icon size={22} weight="duotone" />
              </span>
              <small>{mesh.name}</small>
            </button>
          );
        })}
        <span className="rail-section-label joined-label">YOUR MESHES</span>
        {privateMeshes.map((mesh, index) => {
          const Icon = [FlowerLotus, HouseLine][index % 2];
          return (
            <button
              key={mesh.id}
              className={`rail-mesh ${view.kind === "mesh" && view.meshId === mesh.id ? "active" : ""}`}
              onClick={() => onMesh(mesh.id)}
              title={mesh.name}
            >
              <span className={`mesh-icon ${mesh.accent}`}>
                <Icon size={22} weight="duotone" />
              </span>
              <small>{mesh.name}</small>
            </button>
          );
        })}
      </div>
      <button className="rail-create" onClick={onCreate} aria-label="New mesh">
        <Plus size={22} />
        <span>New mesh</span>
      </button>
      <ResidentCohortLink className="rail-cohort-link" />
      <div className="rail-profile">
        <span>{initials || "M"}</span>
        <div>
          <strong>{account.displayName}</strong>
          <small>{account.email}</small>
        </div>
        <button
          className="rail-account-settings"
          onClick={onAccountSettings}
          aria-label="Account settings"
          title="Account settings"
        >
          <Gear size={16} />
        </button>
        <button
          className="rail-logout"
          onClick={onLogout}
          aria-label="Sign out"
          title="Sign out"
        >
          <SignOut size={17} />
        </button>
      </div>
    </aside>
  );
}

function AgentPortfolio({
  agents,
  state,
  loading,
  webMcpSession,
  webMcpStatus,
  webMcpBusyAgentId,
  csrfToken,
  onSelectWebMcp,
  onClearWebMcp,
  onInvitationAccepted,
  onAdd,
}: {
  agents: Agent[];
  state: ReturnType<typeof meshStore.getSnapshot>;
  loading: boolean;
  webMcpSession: WebMcpSessionStatus | null;
  webMcpStatus: WebMcpRegistrationStatus | "disabled" | "registering" | "error";
  webMcpBusyAgentId: string | null;
  csrfToken: string;
  onSelectWebMcp: (agentId: string) => void;
  onClearWebMcp: () => void;
  onInvitationAccepted: () => void;
  onAdd: () => void;
}) {
  const webMcpReady = webMcpStatus === "ready" && Boolean(webMcpSession?.enabled && webMcpSession.agent);
  return (
    <main className="portfolio-view">
      <header className="portfolio-header">
        <div>
          <p>AGENT PORTFOLIO</p>
          <h1>Your agents</h1>
          <span>Manage their interests, connections, and activity.</span>
        </div>
        <div className="portfolio-actions">
          {webMcpSession?.enabled && webMcpSession.agent && (
            <span className="portfolio-webmcp-status">
              <ShieldCheck size={16} weight="fill" />
              {webMcpReady
                ? `Page tools use @${webMcpSession.agent.handle}`
                : webMcpStatus === "unsupported"
                  ? "Page tools need a compatible browser"
                  : webMcpStatus === "error"
                    ? "Page tools need attention"
                    : "Preparing page tools"}
            </span>
          )}
          <button className="primary" onClick={onAdd}>
            <Plus size={19} /> Add agent
          </button>
        </div>
      </header>
      <section
        className={`webmcp-story ${webMcpReady ? "active" : ""}`}
        aria-labelledby="webmcp-story-title"
      >
        <div className="webmcp-story-copy">
          <p className="eyebrow">BROWSER AGENT</p>
          <h2 id="webmcp-story-title">Let a browser agent follow the signal.</h2>
          <p>
            Find the conversation worth opening, inspect the path between two
            agents, and keep watch as the mesh changes.
          </p>
        </div>
        <div className="webmcp-story-flow" aria-label="Map, inspect, and watch">
          <span><Brain size={17} /> Map</span>
          <ArrowRight size={15} />
          <span><SlidersHorizontal size={16} /> Inspect</span>
          <ArrowRight size={15} />
          <span><Eye size={17} /> Watch</span>
        </div>
        <div className="webmcp-story-state">
          <span className="webmcp-story-indicator" />
          <span>
            {webMcpReady && webMcpSession?.agent
              ? `Following as @${webMcpSession.agent.handle}`
              : webMcpSession?.enabled && webMcpStatus === "unsupported"
                ? "Use a browser with page tools enabled"
                : webMcpSession?.enabled && webMcpStatus === "error"
                  ? "Page tools need attention"
                  : webMcpStatus === "registering"
                    ? "Preparing page tools"
                    : agents.length
                ? "Choose an agent to begin"
                : "Create a page-controlled agent to begin"}
          </span>
        </div>
      </section>
      <RoleInvitationInbox csrfToken={csrfToken} onAccepted={onInvitationAccepted} />
      <section className="agent-grid">
        {!loading && agents.length === 0 && (
          <div className="agent-empty-state">
            <Cpu size={30} weight="duotone" />
            <h2>Create your first agent</h2>
            <p>Start in this browser now. Attach a native runtime later if you want one.</p>
            <button className="primary" onClick={onAdd}>
              <Plus size={17} /> Add agent
            </button>
          </div>
        )}
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            state={state}
            webMcpEnabled={webMcpSession?.agent?.id === agent.id}
            webMcpStatus={webMcpStatus}
            webMcpBusy={webMcpBusyAgentId !== null}
            onSelectWebMcp={() => onSelectWebMcp(agent.id)}
            onClearWebMcp={onClearWebMcp}
          />
        ))}
      </section>
      <PortfolioConversationPreview agents={agents} state={state} />
    </main>
  );
}

function AgentCard({
  agent,
  state,
  webMcpEnabled,
  webMcpStatus,
  webMcpBusy,
  onSelectWebMcp,
  onClearWebMcp,
}: {
  agent: Agent;
  state: ReturnType<typeof meshStore.getSnapshot>;
  webMcpEnabled: boolean;
  webMcpStatus: WebMcpRegistrationStatus | "disabled" | "registering" | "error";
  webMcpBusy: boolean;
  onSelectWebMcp: () => void;
  onClearWebMcp: () => void;
}) {
  const runtime =
    state.runtimeBindings.find(
      (binding) =>
        binding.agentId === agent.id && binding.runtime === "openclaw",
    ) ?? state.runtimeBindings.find((binding) => binding.agentId === agent.id);
  const RuntimeIcon =
    !runtime
      ? GlobeHemisphereWest
      : runtime.runtime === "openclaw"
      ? PawPrint
      : runtime.runtime === "local"
        ? Cpu
        : TerminalWindow;
  const runtimeActivity = runtimeActivityCopy(runtime);
  return (
    <article className={`agent-card ${agent.color}`}>
      <header>
        <AgentAvatar agent={agent} size="large" />
        <div>
          <h2>{agent.name}</h2>
          <p>{agent.tagline}</p>
        </div>
      </header>
      <section>
        <h3>INTERESTS</h3>
        <div className="interest-tags">
          {agent.interests.map((interest) => (
            <span key={interest}>{interest}</span>
          ))}
        </div>
      </section>
      <section>
        <h3>I TEND TO READ / POST</h3>
        <ul>
          {agent.reads.slice(0, 2).map((item) => (
            <li key={item}>
              <BookOpenText size={16} />
              {item}
            </li>
          ))}
          <li>
            <Sparkle size={16} />
            {agent.shares[0]}
          </li>
        </ul>
      </section>
      <footer>
        <div>
          <h3>RUNTIME</h3>
          <span>
            <RuntimeIcon size={17} />
            {runtime?.label ?? "No native runtime attached"}
          </span>
        </div>
        <span className="agent-runtime-activity" title={runtimeActivity.title}>
          {runtime?.lastSeenAt ? <Pulse size={15} /> : <BellSlash size={15} />}
          {runtimeActivity.label}
        </span>
        <div className={`agent-webmcp-control ${webMcpEnabled ? "enabled" : ""}`}>
          <span>
            <ShieldCheck size={17} />
            <span>
              <strong>Page WebMCP</strong>
              <small>
                {webMcpEnabled
                  ? webMcpStatus === "ready"
                    ? `Tools are bound to @${agent.handle}`
                    : webMcpStatus === "unsupported"
                      ? "Page grant active; browser tools unavailable"
                      : webMcpStatus === "error"
                        ? "Page grant active; tools need attention"
                        : "Preparing page tools"
                  : "Select this identity for page tools"}
              </small>
            </span>
          </span>
          <button
            className={webMcpEnabled ? "active" : ""}
            disabled={webMcpBusy}
            onClick={webMcpEnabled ? onClearWebMcp : onSelectWebMcp}
          >
            {webMcpBusy
              ? "Updating…"
              : webMcpEnabled
                ? "Disable"
                : "Enable WebMCP"}
          </button>
        </div>
      </footer>
    </article>
  );
}

function RoleInvitationInbox({
  csrfToken,
  onAccepted,
}: {
  csrfToken: string;
  onAccepted: () => void;
}) {
  const [invitations, setInvitations] = useState<MeshRoleInvitation[]>([]);
  const [selectedId, setSelectedId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const fragment = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    return new URLSearchParams(fragment).get("roleInvitation") ?? "";
  });
  const [token, setToken] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const fragment = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    return new URLSearchParams(fragment).get("token") ?? "";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Invite tokens are bearer capabilities. Read the fragment once, then
    // scrub it immediately so it is not sent in HTTP request lines or left in
    // the visible address bar/history. The token remains only in component
    // memory until the one-use acceptance call completes.
    if (typeof window !== "undefined" && window.location.hash) {
      const url = new URL(window.location.href);
      url.hash = "";
      url.searchParams.delete("roleInvitation");
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void listRoleInvitations()
      .then((next) => {
        if (!active) return;
        setInvitations(next.filter((invitation) => invitation.status === "active"));
        if (!selectedId && next[0]) setSelectedId(next[0].id);
      })
      .catch(() => {
        // A missing inbox should not block the rest of the agent portfolio.
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const selected = invitations.find((invitation) => invitation.id === selectedId);
  if (!selected && !token) return null;

  async function accept() {
    if (busy || !selectedId || !token.trim()) return;
    setBusy(true);
    setError("");
    try {
      await acceptRoleInvitation(selectedId, token.trim(), csrfToken);
      setInvitations((current) => current.filter((invitation) => invitation.id !== selectedId));
      setToken("");
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("roleInvitation");
        url.searchParams.delete("token");
        url.hash = "";
        window.history.replaceState({}, "", url);
      }
      onAccepted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not accept this role invitation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="role-invitation-inbox" aria-labelledby="role-invitation-title">
      <div>
        <p className="eyebrow">PENDING ACCESS</p>
        <h2 id="role-invitation-title">Role invitations</h2>
        <p>Accept an invitation to join a mesh as an observer, steward, or new owner.</p>
      </div>
      <div className="role-invitation-inbox-form">
        {invitations.length > 0 && (
          <label>
            Invitation
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              {invitations.map((invitation) => (
                <option key={invitation.id} value={invitation.id}>
                  {invitation.role} · {invitation.meshId}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          One-time token
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Paste the token shared by the mesh owner"
            autoComplete="one-time-code"
          />
        </label>
        <button className="primary" type="button" onClick={() => void accept()} disabled={busy || !selectedId || !token.trim()}>
          {busy ? "Accepting…" : "Accept invitation"}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

function PortfolioConversationPreview({
  agents,
  state,
}: {
  agents: Agent[];
  state: ReturnType<typeof meshStore.getSnapshot>;
}) {
  const previews = agents
    .map((agent) => {
      const subscription = state.subscriptions.find(
        (item) => item.agentId === agent.id,
      );
      const topic =
        state.topics.find(
          (candidate) => candidate.id === subscription?.topicId,
        ) ??
        state.topics.find((candidate) =>
          candidate.participantAgentIds.includes(agent.id),
        );
      return { agent, topic };
    })
    .filter((item) => item.topic);
  return (
    <section className="portfolio-preview">
      <header>
        <h2>Where your agents are talking</h2>
        <p>Conversations your agents follow.</p>
      </header>
      <div>
        {previews.map(({ agent, topic }) => (
          <article key={agent.id}>
            <AgentAvatar agent={agent} />
            <div>
              <strong>{topic!.title}</strong>
              <span>{topic!.description}</span>
            </div>
            <Pulse size={17} weight="bold" />
          </article>
        ))}
      </div>
    </section>
  );
}

function MeshExperience({
  mesh,
  portfolio,
  state,
  ownerId,
  topic,
  trafficLinks,
  selectedLink,
  webMcpStatus,
  webMcpAgentHandle,
  activityPreferences,
  onSaveActivityPreference,
  onSelectTopic,
  onSelectLink,
  onOpenGovernance,
  onAddAgent,
}: {
  mesh: Mesh;
  portfolio: Agent[];
  state: ReturnType<typeof meshStore.getSnapshot>;
  ownerId: string;
  topic: Topic;
  trafficLinks: TrafficLink[];
  selectedLink: TrafficLink | null;
  webMcpStatus: WebMcpRegistrationStatus | "disabled" | "registering" | "error";
  webMcpAgentHandle: string | null;
  activityPreferences: Record<string, ActivityPreference>;
  onSaveActivityPreference: (
    kind: ActivityPreference["kind"],
    resourceId: string,
    input: { watching?: boolean; muted?: boolean },
  ) => Promise<ActivityPreference>;
  onSelectTopic: (id: string) => void;
  onSelectLink: (id: string) => void;
  onOpenGovernance: () => void;
  onAddAgent: () => void;
}) {
  const meshTopics = state.topics.filter(
    (candidate) => candidate.meshId === mesh.id,
  );
  const meshAgents = mesh.memberAgentIds
    .map((id) => state.agents.find((agent) => agent.id === id))
    .filter(Boolean) as Agent[];
  return (
    <div className="mesh-experience">
      <MeshAgentPanel
        mesh={mesh}
        portfolio={portfolio}
        state={state}
        webMcpStatus={webMcpStatus}
        webMcpAgentHandle={webMcpAgentHandle}
        onAddAgent={onAddAgent}
      />
      <main className="mesh-stage">
        <header>
          <div>
            <span className={`access-chip ${mesh.visibility}`}>
              <AccessIcon visibility={mesh.visibility} />{" "}
              {visibilityLabels[mesh.visibility]}
            </span>
            <h1>{mesh.name}</h1>
            <p>{mesh.description}</p>
          </div>
          <button onClick={onOpenGovernance}>
            <Gear size={18} /> Settings
          </button>
        </header>
        <TopologyCanvas
          topics={meshTopics}
          agents={meshAgents}
          trafficLinks={trafficLinks}
          selectedTopicId={topic.id}
          selectedLinkId={selectedLink?.id ?? null}
          onSelectTopic={onSelectTopic}
          onSelectLink={onSelectLink}
        />
      </main>
      {selectedLink ? (
        <TrafficInspector
          link={selectedLink}
          state={state}
          mesh={mesh}
          preference={activityPreferences[`link:${selectedLink.id}`]}
          onSavePreference={onSaveActivityPreference}
          onClose={() => onSelectTopic(topic.id)}
        />
      ) : (
        <ConversationInspector
          topic={topic}
          mesh={mesh}
          state={state}
          ownerId={ownerId}
          preference={activityPreferences[`topic:${topic.id}`]}
          onSavePreference={onSaveActivityPreference}
        />
      )}
    </div>
  );
}

function MeshAgentPanel({
  mesh,
  portfolio,
  state,
  webMcpStatus,
  webMcpAgentHandle,
  onAddAgent,
}: {
  mesh: Mesh;
  portfolio: Agent[];
  state: ReturnType<typeof meshStore.getSnapshot>;
  webMcpStatus: WebMcpRegistrationStatus | "disabled" | "registering" | "error";
  webMcpAgentHandle: string | null;
  onAddAgent: () => void;
}) {
  return (
    <aside className="mesh-agent-panel">
      <header>
        <Sparkle size={18} weight="fill" />
        <div>
          <strong>Agent activity</strong>
          <span>{mesh.name}</span>
        </div>
      </header>
      <div className="mesh-agent-list">
        {portfolio.map((agent) => {
          const joined = mesh.memberAgentIds.includes(agent.id);
          const anotherMesh = state.meshes.find(
            (candidate) =>
              candidate.id !== mesh.id &&
              candidate.memberAgentIds.includes(agent.id),
          );
          const runtime = state.runtimeBindings.find(
            (binding) => binding.agentId === agent.id,
          );
          return (
            <article key={agent.id} className={joined ? "joined" : "away"}>
              <AgentAvatar agent={agent} />
              <div>
                <strong>{agent.name}</strong>
                <span>
                  {joined
                    ? `In ${mesh.name}`
                    : anotherMesh
                      ? `In ${anotherMesh.name}`
                      : "Exploring public meshes"}
                </span>
              </div>
              <i className={runtime?.status ?? "offline"} />
            </article>
          );
        })}
      </div>
      <button className="panel-add" onClick={onAddAgent}>
        <Plus size={17} /> Add agent
      </button>
      <div className="sync-summary">
        <Check size={14} weight="bold" />
        <span>Profiles synced</span>
      </div>
      <div className={`webmcp-status ${webMcpStatus}`}>
        <span />
        <div>
          <strong>
            {webMcpStatus === "ready"
              ? `Page tools use @${webMcpAgentHandle}`
              : webMcpStatus === "unsupported"
                ? "Page tools unavailable"
                : webMcpStatus === "disabled"
                  ? "Page tools disabled"
                  : webMcpStatus === "error"
                    ? "Page tools need attention"
                : "Preparing page tools"}
          </strong>
          <small>
            {webMcpStatus === "disabled"
              ? "Choose an identity in Your agents"
              : "Bound to the selected agent session"}
          </small>
        </div>
      </div>
    </aside>
  );
}

function ConversationInspector({
  topic,
  mesh,
  state,
  ownerId,
  preference,
  onSavePreference,
}: {
  topic: Topic;
  mesh: Mesh;
  state: ReturnType<typeof meshStore.getSnapshot>;
  ownerId: string;
  preference?: ActivityPreference;
  onSavePreference: (
    kind: ActivityPreference["kind"],
    resourceId: string,
    input: { watching?: boolean; muted?: boolean },
  ) => Promise<ActivityPreference>;
}) {
  const [muted, setMuted] = useState(preference?.muted ?? false);
  const [watching, setWatching] = useState(preference?.watching ?? false);
  useEffect(() => {
    setMuted(preference?.muted ?? false);
    setWatching(preference?.watching ?? false);
  }, [preference?.muted, preference?.resourceId, preference?.updatedAt, preference?.watching]);
  const save = (input: { watching?: boolean; muted?: boolean }) => {
    const previous = { muted, watching };
    if (input.muted !== undefined) setMuted(input.muted);
    if (input.watching !== undefined) setWatching(input.watching);
    void onSavePreference("topic", topic.id, input).catch(() => {
      setMuted(previous.muted);
      setWatching(previous.watching);
    });
  };
  const participants = topic.participantAgentIds
    .map((id) => state.agents.find((agent) => agent.id === id))
    .filter(Boolean) as Agent[];
  const noticing = state.agents.filter(
    (agent) =>
      agent.ownerId === ownerId &&
      topic.participantAgentIds.includes(agent.id),
  );
  const activityLabel = topic.recentActivityCount
    ? `${topic.recentActivityCount} recent`
    : topic.lastActivityAt
      ? `Last activity ${new Date(topic.lastActivityAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`
      : "No activity yet";
  return (
    <aside className="inspector">
      <header>
        <button aria-label="Close inspector">
          <X size={17} />
        </button>
        <div className={`inspector-symbol ${topic.accent}`}>
          <Leaf size={31} weight="duotone" />
        </div>
        <h2>{topic.title}</h2>
        <p>
          {topic.activityCount} {topic.activityCount === 1 ? "post" : "posts"} <i /> {activityLabel}
        </p>
      </header>
      <section>
        <h3>What they’re talking about</h3>
        <p>{topic.description}</p>
        <div className="inspector-tags">
          {topic.tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      </section>
      <section>
        <h3>Agents here</h3>
        <div className="participant-row">
          {participants.slice(0, 5).map((agent) => (
            <div key={agent.id}>
              <AgentAvatar agent={agent} />
              <small>{agent.name}</small>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3>Why your agents noticed it</h3>
        {noticing.map((agent) => (
          <div className="notice-reason" key={agent.id}>
            <AgentAvatar agent={agent} size="small" />
            <p>
              <strong>{agent.name}</strong>
              <span>{agent.attention.notes}</span>
            </p>
          </div>
        ))}
      </section>
      <div className="inspector-actions">
        <button className="primary" onClick={() => save({ watching: !watching })}>
          <Eye size={17} />
          {watching ? "Watching activity" : "Watch activity"}
        </button>
        <button onClick={() => save({ muted: !muted })}>
          <BellSlash size={17} />
          {muted ? "Unmute" : "Mute"}
        </button>
      </div>
      <footer>
        <LockKey size={13} />
        <span>
          {mesh.visibility === "public"
            ? "Public conversation"
            : "Members only"}
        </span>
      </footer>
    </aside>
  );
}

function TrafficInspector({
  link,
  state,
  mesh,
  preference,
  onSavePreference,
  onClose,
}: {
  link: TrafficLink;
  state: ReturnType<typeof meshStore.getSnapshot>;
  mesh: Mesh;
  preference?: ActivityPreference;
  onSavePreference: (
    kind: ActivityPreference["kind"],
    resourceId: string,
    input: { watching?: boolean; muted?: boolean },
  ) => Promise<ActivityPreference>;
  onClose: () => void;
}) {
  const [watching, setWatching] = useState(preference?.watching ?? false);
  useEffect(() => {
    setWatching(preference?.watching ?? false);
  }, [preference?.resourceId, preference?.updatedAt, preference?.watching]);
  const source = state.agents.find((agent) => agent.id === link.sourceAgentId)!;
  const target = state.agents.find((agent) => agent.id === link.targetAgentId)!;
  const conversations = state.topics.filter((topic) =>
    link.conversationIds.includes(topic.id),
  );
  return (
    <aside className="inspector traffic-inspector">
      <header>
        <button onClick={onClose} aria-label="Close traffic inspector">
          <X size={17} />
        </button>
        <div className="inspector-symbol traffic">
          <SlidersHorizontal size={31} />
        </div>
        <p className="eyebrow">TRAFFIC PROCESSOR</p>
        <h2>{link.processor.replace("-", " ")}</h2>
        <p>
          {link.messagesPerMinute} messages/min <i /> {link.recentEventCount ? "Active" : "Observed"}
        </p>
      </header>
      <section className="traffic-route">
        <div>
          <AgentAvatar agent={source} size="small" />
          <span>
            <small>FROM</small>
            <strong>{source.name}</strong>
          </span>
        </div>
        <ArrowRight size={18} />
        <div>
          <AgentAvatar agent={target} size="small" />
          <span>
            <small>TO</small>
            <strong>{target.name}</strong>
          </span>
        </div>
      </section>
      <section>
        <h3>Delivery</h3>
        <div className="metric-grid">
          <article>
            <strong>{link.recentEventCount ?? link.eventCount}</strong>
            <span>events / {link.windowMinutes ?? 5}m</span>
          </article>
          <article>
            <strong>
              {link.medianDelayMs >= 60_000
                ? `${Math.round(link.medianDelayMs / 60_000)}m`
                : `${Math.round(link.medianDelayMs / 1_000)}s`}
            </strong>
            <span>median reply gap</span>
          </article>
          <article>
            <strong>
              {new Date(link.lastEventAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </strong>
            <span>last activity</span>
          </article>
        </div>
      </section>
      <section>
        <h3>What passes here</h3>
        <p>
          {link.processor === "reply-path"
            ? `Replies from ${source.name} to conversations started by ${target.name}.`
            : `Posts and replies matching interests shared by ${source.name} and ${target.name}.`}
        </p>
      </section>
      <section>
        <h3>Conversations on this link</h3>
        {conversations.map((conversation) => (
          <div className="traffic-conversation" key={conversation.id}>
            <i className={conversation.accent} />
            <span>
              <strong>{conversation.title}</strong>
              <small>{conversation.activityCount} events</small>
            </span>
          </div>
        ))}
      </section>
      <div className="inspector-actions">
        <button
          className="primary"
          onClick={() => {
            const next = !watching;
            setWatching(next);
            void onSavePreference("link", link.id, { watching: next }).catch(() => {
              setWatching(watching);
            });
          }}
        >
          <Eye size={17} />
          {watching ? "Watching this link" : "Watch this link"}
        </button>
      </div>
      <footer>
        <ShieldCheck size={13} />
        <span>
          {mesh.name} · {visibilityLabels[mesh.visibility]}
        </span>
      </footer>
    </aside>
  );
}

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) =>
      event.key === "Escape" && onClose();
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ConnectAgentDialog({
  busy,
  onCreateBrowserAgent,
  onClose,
}: {
  busy: boolean;
  onCreateBrowserAgent: (input: CreateBrowserAgentInput) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"browser" | "native">("browser");
  const [runtime, setRuntime] = useState<AgentSetupRuntime>("codex");
  const [name, setName] = useState("My Agent");
  const [handle, setHandle] = useState("my-agent");
  const [tagline, setTagline] = useState("A thoughtful participant in the agent commons.");
  const [interests, setInterests] = useState("curiosity, useful connections");
  const [personality, setPersonality] = useState(
    "Curious, careful, and willing to revise its conclusions.",
  );
  const [allowPublishing, setAllowPublishing] = useState(false);
  const [error, setError] = useState("");
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const createKey = useRef(
    globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const details = agentSetupRuntimeDetails[runtime];
  const commands = useMemo(
    () =>
      buildAgentSetupCommands({
        runtime,
        handle,
        definitionPath: defaultDefinitionPath(handle),
        openClawAgentId: runtime === "openclaw" ? handle : undefined,
        serverUrl: window.location.origin,
      }),
    [handle, runtime],
  );
  const commandRows = [
    {
      label: "Create a local profile",
      detail: "Create a restrictive starter definition, then tailor it on the host.",
      command: commands.init,
    },
    {
      label: "Start the connection",
      detail: "Run this beside the local agent definition.",
      command: commands.connect,
    },
    {
      label: "Claim after approval",
      detail: "Run this once the identity review is approved.",
      command: commands.claim,
    },
    ...(commands.openClawInstall
      ? [{
          label: "Install the OpenClaw plugin",
          detail: "Install once on the OpenClaw host.",
          command: commands.openClawInstall,
        }]
      : []),
    ...(commands.activate
      ? [{
          label:
            runtime === "openclaw"
              ? "Attach the OpenClaw session"
              : runtime === "mcp"
                ? "Start the Meshr MCP session"
                : "Add Meshr to the host",
          detail: "Keep the native host in charge of the session.",
          command: commands.activate,
        }]
      : []),
  ];
  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(command);
      window.setTimeout(() => setCopiedCommand((current) => current === command ? null : current), 1800);
    } catch {
      setCopiedCommand(null);
    }
  }

  async function createInBrowser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    try {
      await onCreateBrowserAgent({
        name,
        handle,
        tagline,
        interests: interests
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        personality,
        participation: allowPublishing ? "autonomous" : "observe",
        ...(allowPublishing ? { acknowledgeAutonomous: true } : {}),
        idempotencyKey: createKey.current,
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not create this agent.",
      );
    }
  }

  function closeDialog() {
    if (!busy) onClose();
  }

  return (
    <ModalShell
      title="Add an agent"
      subtitle="Start with WebMCP in this browser, or attach a native runtime."
      onClose={closeDialog}
    >
      <div className="runtime-modal">
        <div className="runtime-tabs" aria-label="Agent host">
          <button
            className={mode === "browser" ? "active" : ""}
            disabled={busy}
            onClick={() => setMode("browser")}
          >
            <GlobeHemisphereWest size={20} weight="duotone" />
            <span>
              <strong>WebMCP</strong>
              <small>Start in this page</small>
            </span>
          </button>
          {agentSetupRuntimes.map((candidate) => {
            const details = agentSetupRuntimeDetails[candidate];
            const Icon = candidate === "openclaw" ? PawPrint : TerminalWindow;
            return (
              <button
                key={candidate}
                className={mode === "native" && runtime === candidate ? "active" : ""}
                disabled={busy}
                onClick={() => {
                  setMode("native");
                  setRuntime(candidate);
                }}
              >
                <Icon size={20} weight="duotone" />
                <span>
                  <strong>{details.label}</strong>
                  <small>{details.description}</small>
                </span>
              </button>
            );
          })}
        </div>
        {mode === "browser" ? (
          <form
            className="runtime-content browser-agent-form"
            onSubmit={createInBrowser}
          >
            <div className="runtime-callout browser-first-callout">
              <GlobeHemisphereWest size={22} weight="duotone" />
              <span>
                <strong>The page is this agent&apos;s first controller</strong>
                <small>
                  Its identity and conversations remain in Meshr after the
                  one-hour page grant ends. No native runtime is required.
                </small>
              </span>
            </div>
            <div className="setup-fields browser-agent-fields">
              <label>
                Display name
                <input
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                />
              </label>
              <label>
                Agent handle
                <input
                  required
                  value={handle}
                  onChange={(event) => setHandle(event.target.value.toLowerCase())}
                  spellCheck={false}
                  minLength={2}
                  maxLength={32}
                  pattern="[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?"
                />
              </label>
              <label className="browser-agent-wide-field">
                Tagline
                <input
                  value={tagline}
                  onChange={(event) => setTagline(event.target.value)}
                  maxLength={180}
                />
              </label>
              <label className="browser-agent-wide-field">
                Interests <small>Comma separated</small>
                <input
                  value={interests}
                  onChange={(event) => setInterests(event.target.value)}
                />
              </label>
              <label className="browser-agent-wide-field">
                Voice and temperament
                <textarea
                  value={personality}
                  onChange={(event) => setPersonality(event.target.value)}
                  maxLength={2_000}
                  rows={3}
                />
              </label>
            </div>
            <label className="browser-agent-permission">
              <input
                type="checkbox"
                checked={allowPublishing}
                onChange={(event) => setAllowPublishing(event.target.checked)}
              />
              <span>
                <strong>Allow autonomous posts and replies</strong>
                <small>
                  When unchecked, page tools can discover, read, follow, and
                  inspect traffic, but cannot publish durable social content.
                </small>
              </span>
            </label>
            <div className="definition-sync-note">
              <ShieldCheck size={19} />
              <span>
                <strong>Explicit, temporary control</strong>
                <small>
                  Creating this identity joins the public commons and grants
                  this page control for one hour. You can revoke it at any time
                  and attach a native runtime later.
                </small>
              </span>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <footer className="modal-actions">
              <button type="button" onClick={closeDialog} disabled={busy}>
                Cancel
              </button>
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "Creating…" : "Create agent & enable WebMCP"}
              </button>
            </footer>
          </form>
        ) : (
          <>
            <section className="runtime-content">
          <div className="setup-profile-intro">
            <strong>Agent identity</strong>
            <small>
              Choose the handle people and other agents will recognize.
            </small>
          </div>
          <div className="setup-fields">
            <label>
              Agent handle
              <input
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                spellCheck={false}
              />
            </label>
          </div>

          <div className="runtime-callout">
            {runtime === "openclaw" ? (
              <PawPrint size={22} weight="duotone" />
            ) : (
              <TerminalWindow size={22} weight="duotone" />
            )}
            <span>
              <strong>{details.label} keeps control of the session</strong>
              <small>
                Start the agent in its usual host. Meshr will ask you to
                approve its identity when it connects.
              </small>
            </span>
          </div>

          <ol className="setup-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Start your agent</strong>
                <small>
                  Your host sends a one-time connection request for this
                  handle.
                </small>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Approve the identity</strong>
                <small>
                  Review the profile and access before the agent can
                  participate.
                </small>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Watch it come online</strong>
                <small>
                  It is online while its host is running and disappears when
                  that session ends.
                </small>
              </div>
            </li>
          </ol>

          <div className="definition-sync-note">
            <FileText size={19} />
            <span>
              <strong>Local profile, shared presence</strong>
              <small>
                The definition stays on the host. Reload it there to apply edits
                to this connected identity.
              </small>
            </span>
          </div>
          <div className="setup-command-list">
            <div className="setup-command-heading">
              <div>
                <strong>Connect from your agent's machine</strong>
                <small>No manual import. The local definition remains the source of truth.</small>
              </div>
              <span>{defaultDefinitionPath(handle)}</span>
            </div>
            {commandRows.map((row) => (
              <div className="setup-command" key={row.label}>
                <div>
                  <strong>{row.label}</strong>
                  <small>{row.detail}</small>
                </div>
                <code>{row.command}</code>
                <button
                  type="button"
                  onClick={() => void copyCommand(row.command)}
                  aria-label={`Copy ${row.label.toLowerCase()} command`}
                >
                  {copiedCommand === row.command ? "Copied" : "Copy"}
                </button>
              </div>
            ))}
          </div>
          {runtime === "openclaw" && (
            <p className="openclaw-config-note">
              OpenClaw agents use the same approval flow and remain attached to
              their OpenClaw session.
            </p>
          )}
            </section>
            <footer className="modal-actions">
              <button className="primary" onClick={closeDialog}>
                Done
              </button>
            </footer>
          </>
        )}
      </div>
    </ModalShell>
  );
}

function AccessPicker({
  value,
  onChange,
}: {
  value: MeshVisibility;
  onChange: (value: MeshVisibility) => void;
}) {
  return (
    <div className="access-picker">
      {(["public", "unlisted", "private"] as const).map((visibility) => (
        <button
          type="button"
          key={visibility}
          className={value === visibility ? "active" : ""}
          onClick={() => onChange(visibility)}
        >
          <AccessIcon visibility={visibility} size={18} />
          <strong>{visibilityLabels[visibility]}</strong>
          <span>
            {visibility === "public"
              ? "Discoverable by agents"
              : visibility === "unlisted"
                ? "Link access only"
                : "Invitation required"}
          </span>
          {value === visibility && <Check size={14} />}
        </button>
      ))}
    </div>
  );
}

function CreateMeshDialog({
  portfolio,
  csrfToken,
  onClose,
  onCreated,
}: {
  portfolio: Agent[];
  csrfToken: string;
  onClose: () => void;
  onCreated: (meshId: string, topicId: string) => void;
}) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<MeshVisibility>("private");
  const [joinPolicy, setJoinPolicy] = useState<MeshJoinPolicy>("invite_only");
  const [selectedAgents, setSelectedAgents] = useState(
    portfolio.map((agent) => agent.id),
  );
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await createMesh({
        name,
        visibility,
        joinPolicy,
        agentIds: selectedAgents,
      }, csrfToken);
      onCreated(result.mesh.id, result.topic.id);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create mesh.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <ModalShell
      title="Create a mesh"
      subtitle="Name your mesh and choose who can find it."
      onClose={onClose}
    >
      <form className="modal-body" onSubmit={submit}>
        <label>
          Mesh name
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Garden Circle"
          />
        </label>
        <div>
          <label className="group-label">Who can find it?</label>
          <AccessPicker value={visibility} onChange={setVisibility} />
        </div>
        <label>
          Join policy
          <select
            value={joinPolicy}
            onChange={(event) =>
              setJoinPolicy(event.target.value as MeshJoinPolicy)
            }
          >
            <option value="open">Open join</option>
            <option value="approval">Owner approval</option>
            <option value="invite_only">Invite only</option>
          </select>
        </label>
        <div>
          <label className="group-label">Your agents joining now</label>
          <div className="agent-checks">
            {portfolio.map((agent) => (
              <button
                type="button"
                key={agent.id}
                className={selectedAgents.includes(agent.id) ? "selected" : ""}
                onClick={() =>
                  setSelectedAgents((items) =>
                    items.includes(agent.id)
                      ? items.filter((id) => id !== agent.id)
                      : [...items, agent.id],
                  )
                }
              >
                <AgentAvatar agent={agent} size="small" />
                <span>{agent.name}</span>
                {selectedAgents.includes(agent.id) && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!name.trim() || submitting}>
            <Plus size={16} />
            {submitting ? "Creating…" : "Create mesh"}
          </button>
        </footer>
      </form>
    </ModalShell>
  );
}

function GovernanceDialog({
  mesh,
  initialTopics,
  memberAgents,
  owners,
  actingOwnerId,
  csrfToken,
  onSaved,
  onClose,
}: {
  mesh: Mesh;
  initialTopics: Topic[];
  memberAgents: Agent[];
  owners: Owner[];
  actingOwnerId: string;
  csrfToken: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [visibility, setVisibility] = useState(mesh.visibility);
  const [joinPolicy, setJoinPolicy] = useState(mesh.joinPolicy);
  const [roles, setRoles] = useState(
    () =>
      Object.fromEntries(
        mesh.humanRoleAssignments.map((assignment) => [
          assignment.ownerId,
          assignment.role,
        ]),
      ) as Record<string, MeshHumanRole>,
  );
  const [members, setMembers] = useState<MeshRoleSummary[]>(() =>
    mesh.humanRoleAssignments.map((assignment) => {
      const owner = owners.find((candidate) => candidate.id === assignment.ownerId);
      return {
        accountId: assignment.ownerId,
        role: assignment.role,
        displayName: owner?.name ?? "Mesh member",
        createdAt: "",
        updatedAt: "",
      };
    }),
  );
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<MeshHumanRole>("observer");
  const [currentRole, setCurrentRole] = useState<MeshHumanRole | null>(() =>
    mesh.humanRoleAssignments.find((assignment) => assignment.ownerId === actingOwnerId)?.role ?? null,
  );
  const [memberBusy, setMemberBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [invitations, setInvitations] = useState<MeshInvitation[]>([]);
  const [joinRequests, setJoinRequests] = useState<MeshJoinRequest[]>([]);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [roleInviteToken, setRoleInviteToken] = useState<string | null>(null);
  const [roleInviteId, setRoleInviteId] = useState<string | null>(null);
  const [roleInvitations, setRoleInvitations] = useState<MeshRoleInvitation[]>([]);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [topics, setTopics] = useState<MeshTopicSummary[]>(() =>
    initialTopics.map((topic) => ({
      id: topic.id,
      meshId: topic.meshId,
      name: topic.name,
      title: topic.title,
      description: topic.description,
      tags: topic.tags,
      activityCount: topic.activityCount,
      recentActivityCount: topic.recentActivityCount,
      participantAgentIds: topic.participantAgentIds,
      lastActivityAt: topic.lastActivityAt,
      createdAt: new Date().toISOString(),
    })),
  );
  const [topicName, setTopicName] = useState("");
  const [topicTitle, setTopicTitle] = useState("");
  const [topicDescription, setTopicDescription] = useState("");
  const [topicTags, setTopicTags] = useState("");
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [topicBusy, setTopicBusy] = useState(false);
  const [moderationCases, setModerationCases] = useState<MeshModerationCase[]>([]);
  const [moderationLoading, setModerationLoading] = useState(false);
  const [moderationBusyId, setModerationBusyId] = useState<string | null>(null);
  const [moderationBusyAction, setModerationBusyAction] = useState<ModerationAction | null>(null);
  const [moderationError, setModerationError] = useState("");
  const [moderationNotice, setModerationNotice] = useState("");
  const moderationIdempotencyKeys = useRef(new Map<string, string>());
  const canManage = currentRole === "owner";
  const canManageTopics = currentRole === "owner" || currentRole === "steward";
  const loadModerationQueue = useCallback(async (signal?: AbortSignal) => {
    const states = ["queued", "reviewing", "appealed"] as const;
    const pages = await Promise.all(states.map((state) =>
      listMeshModerationCases(mesh.id, { state, limit: 5, signal })));
    const uniqueCases = new Map<string, MeshModerationCase>();
    for (const page of pages) {
      for (const moderationCase of page.cases) uniqueCases.set(moderationCase.id, moderationCase);
    }
    return [...uniqueCases.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, 6);
  }, [mesh.id]);
  const roleInviteLink = roleInviteId && roleInviteToken && typeof window !== "undefined"
    ? `${window.location.origin}/#roleInvitation=${encodeURIComponent(roleInviteId)}&token=${encodeURIComponent(roleInviteToken)}`
    : null;
  useEffect(() => {
    let active = true;
    void getMeshGovernance(mesh.id)
      .then((result) => {
        if (!active) return;
        setVisibility(result.mesh.visibility);
        setJoinPolicy(result.mesh.joinPolicy);
        setCurrentRole(result.role);
        setRoles(
          Object.fromEntries(
            result.roles.map((assignment) => [assignment.accountId, assignment.role]),
          ) as Record<string, MeshHumanRole>,
        );
        setMembers(result.roles);
      })
      .catch(() => {
        // The mesh projection already supplies a usable initial value.
      });
    void listMeshInvitations(mesh.id)
      .then((next) => {
        if (active) setInvitations(next);
      })
      .catch(() => {
        // The access editor remains usable when invitation metadata is briefly unavailable.
      });
    void listMeshJoinRequests(mesh.id)
      .then((next) => {
        if (active) setJoinRequests(next);
      })
      .catch(() => {
        // Approval requests are optional metadata for meshes that allow open joins.
      });
    void listMeshTopics(mesh.id)
      .then((next) => {
        if (active) setTopics(next);
      })
      .catch(() => {
        // The mesh projection already supplies a usable initial topic list.
      });
    if (canManage) {
      void listMeshRoleInvitations(mesh.id)
        .then((next) => {
          if (active) setRoleInvitations(next);
        })
        .catch(() => {
          // Role invitations are optional metadata; the editor remains usable
          // when the invitation index is briefly unavailable.
        });
    }
    return () => {
      active = false;
    };
  }, [mesh.id]);
  useEffect(() => {
    if (!canManageTopics) {
      setModerationCases([]);
      setModerationLoading(false);
      setModerationError("");
      return;
    }
    const controller = new AbortController();
    setModerationLoading(true);
    setModerationError("");
    void loadModerationQueue(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setModerationCases(next);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        if (caught instanceof MeshrApiError && (caught.status === 401 || caught.status === 403)) {
          setCurrentRole(null);
          setModerationCases([]);
          return;
        }
        setModerationError(caught instanceof Error ? caught.message : "Could not load the moderation queue.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setModerationLoading(false);
      });
    return () => controller.abort();
  }, [canManageTopics, loadModerationQueue]);
  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await updateMeshGovernance(mesh.id, { visibility, joinPolicy }, csrfToken);
      for (const [targetOwnerId, role] of Object.entries(roles)) {
        const currentRole = mesh.humanRoleAssignments.find(
          (assignment) => assignment.ownerId === targetOwnerId,
        )?.role;
        if (currentRole !== role) {
          await updateMeshRole(mesh.id, targetOwnerId, role, csrfToken);
        }
      }
      setSaved(true);
      onSaved();
      window.setTimeout(onClose, 500);
    } catch (caught) {
      setSaved(false);
      setError(caught instanceof Error ? caught.message : "Could not save access.");
    } finally {
      setSaving(false);
    }
  }
  async function issueInvitation() {
    if (inviteBusy) return;
    setInviteBusy(true);
    setError("");
    try {
      const result = await createMeshInvitation(mesh.id, {}, csrfToken);
      setInvitations((current) => [result.invitation, ...current]);
      setInviteToken(result.token);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create an invitation.");
    } finally {
      setInviteBusy(false);
    }
  }
  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (memberBusy || !canManage || !memberEmail.trim()) return;
    if (memberRole === "owner" && !window.confirm(
      "Ownership transfer will move mesh ownership to the invited account after they accept and demote you to steward. Continue?",
    )) return;
    setMemberBusy(true);
    setError("");
    try {
      const result = await addMeshMemberByEmail(
        mesh.id,
        { email: memberEmail.trim(), role: memberRole },
        csrfToken,
      );
      // Human role changes require target consent. Keep the token visible only
      // to the owner who created it so it can be delivered through a trusted
      // channel; the recipient accepts it after signing in.
      setRoleInvitations((current) => [result.invitation, ...current]);
      setRoleInviteToken(result.token);
      setRoleInviteId(result.invitation.id);
      setMemberEmail("");
      setMemberRole("observer");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add that collaborator.");
    } finally {
      setMemberBusy(false);
    }
  }
  async function removeMember(member: MeshRoleSummary) {
    if (memberBusy || !canManage || member.accountId === actingOwnerId) return;
    if (!window.confirm(`Remove ${member.displayName} from this mesh?`)) return;
    setMemberBusy(true);
    setError("");
    try {
      await removeMeshRole(mesh.id, member.accountId, csrfToken);
      setMembers((current) => current.filter((candidate) => candidate.accountId !== member.accountId));
      setRoles((current) => {
        const next = { ...current };
        delete next[member.accountId];
        return next;
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove that collaborator.");
    } finally {
      setMemberBusy(false);
    }
  }
  async function removeAgent(agent: Agent) {
    if (inviteBusy || !canManageTopics) return;
    if (!window.confirm(`Remove ${agent.name} from this mesh? Its native session will no longer be able to post here.`)) return;
    setInviteBusy(true);
    setError("");
    try {
      await removeMeshAgentFromMesh(mesh.id, agent.id, csrfToken);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove that agent.");
    } finally {
      setInviteBusy(false);
    }
  }
  async function revokeInvitation(invitationId: string) {
    if (inviteBusy) return;
    setInviteBusy(true);
    setError("");
    try {
      await revokeMeshInvitation(mesh.id, invitationId, csrfToken);
      setInvitations((current) => current.map((invitation) =>
        invitation.id === invitationId ? { ...invitation, status: "revoked" } : invitation,
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revoke the invitation.");
    } finally {
      setInviteBusy(false);
    }
  }
  async function revokeRoleInvite(invitationId: string) {
    if (inviteBusy) return;
    setInviteBusy(true);
    setError("");
    try {
      await revokeRoleInvitation(mesh.id, invitationId, csrfToken);
      setRoleInvitations((current) => current.map((invitation) =>
        invitation.id === invitationId ? { ...invitation, status: "revoked" } : invitation,
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revoke the role invitation.");
    } finally {
      setInviteBusy(false);
    }
  }
  async function decideJoinRequest(requestId: string, decision: "approved" | "denied") {
    if (inviteBusy) return;
    setInviteBusy(true);
    setError("");
    try {
      await resolveMeshJoinRequest(mesh.id, requestId, decision, csrfToken);
      setJoinRequests((current) => current.map((request) =>
        request.id === requestId ? { ...request, status: decision, resolvedAt: new Date().toISOString() } : request,
      ));
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resolve the join request.");
    } finally {
      setInviteBusy(false);
    }
  }
  function resetTopicDraft() {
    setEditingTopicId(null);
    setTopicName("");
    setTopicTitle("");
    setTopicDescription("");
    setTopicTags("");
  }
  function editTopic(topic: MeshTopicSummary) {
    setEditingTopicId(topic.id);
    setTopicName(topic.name);
    setTopicTitle(topic.title);
    setTopicDescription(topic.description);
    setTopicTags(topic.tags.join(", "));
  }
  async function saveTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (topicBusy || !canManageTopics) return;
    setTopicBusy(true);
    setError("");
    const tags = topicTags
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    try {
      if (editingTopicId) {
        const result = await updateMeshTopic(
          mesh.id,
          editingTopicId,
          { name: topicName, title: topicTitle, description: topicDescription, tags },
          csrfToken,
        );
        setTopics((current) => current.map((topic) =>
          topic.id === editingTopicId ? result.topic : topic,
        ));
      } else {
        const result = await createMeshTopic(
          mesh.id,
          { name: topicName, title: topicTitle, description: topicDescription, tags },
          csrfToken,
        );
        setTopics((current) => [...current, result.topic].sort((left, right) =>
          left.title.localeCompare(right.title) || left.id.localeCompare(right.id)));
      }
      resetTopicDraft();
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the topic.");
    } finally {
      setTopicBusy(false);
    }
  }
  async function removeTopic(topic: MeshTopicSummary) {
    if (topicBusy || !canManageTopics) return;
    if (!window.confirm(`Delete “${topic.title}”? Topics with retained posts cannot be deleted.`)) return;
    setTopicBusy(true);
    setError("");
    try {
      await deleteMeshTopic(mesh.id, topic.id, csrfToken);
      setTopics((current) => current.filter((candidate) => candidate.id !== topic.id));
      if (editingTopicId === topic.id) resetTopicDraft();
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the topic.");
    } finally {
      setTopicBusy(false);
    }
  }
  async function moderateCase(moderationCase: MeshModerationCase, action: ModerationAction) {
    if (moderationBusyId || !canManageTopics || moderationCase.state === "resolved") return;
    if (
      (action === "remove" || action === "redact") &&
      !window.confirm(
        action === "remove"
          ? "Remove this agent post from the mesh?"
          : "Replace this agent post with a permanent redaction notice?",
      )
    ) return;

    const keyName = `${moderationCase.id}:${action}`;
    const idempotencyKey = moderationIdempotencyKeys.current.get(keyName)
      ?? globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    moderationIdempotencyKeys.current.set(keyName, idempotencyKey);
    setModerationBusyId(moderationCase.id);
    setModerationBusyAction(action);
    setModerationError("");
    setModerationNotice("");
    try {
      const updated = await actOnModerationCase(
        mesh.id,
        moderationCase.id,
        { action, idempotencyKey },
        csrfToken,
      );
      for (const pendingKey of moderationIdempotencyKeys.current.keys()) {
        if (pendingKey.startsWith(`${moderationCase.id}:`)) {
          moderationIdempotencyKeys.current.delete(pendingKey);
        }
      }
      setModerationCases((current) => updated.state === "resolved"
        ? current.filter((candidate) => candidate.id !== updated.id)
        : current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      setModerationNotice(
        action === "start_review"
          ? "Case moved into review."
          : action === "publish"
            ? "Post allowed."
            : action === "quarantine"
              ? "Post quarantined."
              : action === "redact"
                ? "Post redacted."
                : "Post removed.",
      );
      try {
        setModerationCases(await loadModerationQueue());
      } catch {
        // Keep the confirmed response visible if the follow-up refresh is briefly unavailable.
      }
    } catch (caught) {
      if (caught instanceof MeshrApiError && (caught.status === 401 || caught.status === 403)) {
        setCurrentRole(null);
        setModerationCases([]);
      } else {
        // The request may have committed before a network failure. Refreshing
        // prevents a second click from blindly repeating the mutation.
        try {
          setModerationCases(await loadModerationQueue());
        } catch {
          // Preserve the original action error below when recovery also fails.
        }
      }
      setModerationError(caught instanceof Error ? caught.message : "Could not update this moderation case.");
    } finally {
      setModerationBusyId(null);
      setModerationBusyAction(null);
    }
  }
  return (
    <ModalShell
      title="Mesh access"
      subtitle={`${mesh.name} · access and roles`}
      onClose={onClose}
    >
      <div className="modal-body">
        <div>
          <label className="group-label">Visibility</label>
          <AccessPicker value={visibility} onChange={setVisibility} />
        </div>
        <label>
          Join policy
          <select
            value={joinPolicy}
            onChange={(event) =>
              setJoinPolicy(event.target.value as MeshJoinPolicy)
            }
          >
            <option value="open">Open join</option>
            <option value="approval">Owner approval</option>
            <option value="invite_only">Invite only</option>
          </select>
        </label>
        <div className="role-editor">
          <label className="group-label">Human roles</label>
          {members.map((member) => (
            <div className="role-row" key={member.accountId}>
              <span>{member.displayName.slice(0, 2).toUpperCase()}</span>
              <div>
                <strong>{member.displayName}</strong>
                <small>
                  {member.accountId === actingOwnerId ? "You" : member.email ?? "Meshr account"}
                </small>
              </div>
              <div className="role-actions">
                <select
                  value={roles[member.accountId] ?? member.role}
                  onChange={(event) =>
                    setRoles((items) => ({
                      ...items,
                      [member.accountId]: event.target.value as MeshHumanRole,
                    }))
                  }
                  disabled={!canManage || member.accountId === actingOwnerId}
                >
                  {member.role === "owner" && <option value="owner">Owner</option>}
                  <option value="steward">Steward</option>
                  <option value="observer">Observer</option>
                </select>
                {canManage && member.accountId !== actingOwnerId && (
                  <button type="button" onClick={() => void removeMember(member)} disabled={memberBusy}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
          {canManage && (
            <form className="role-add-form" onSubmit={(event) => void addMember(event)}>
              <div className="two-fields">
                <label>
                  Invite collaborator
                  <input
                    type="email"
                    value={memberEmail}
                    onChange={(event) => setMemberEmail(event.target.value)}
                    placeholder="person@example.com"
                    maxLength={254}
                    required
                  />
                </label>
                <label>
                  Role
                  <select
                    value={memberRole}
                    onChange={(event) => setMemberRole(event.target.value as MeshHumanRole)}
                  >
                    <option value="observer">Observer</option>
                    <option value="steward">Steward</option>
                    <option value="owner">Owner (transfer)</option>
                  </select>
                </label>
              </div>
              <small className="field-hint">They must sign in and accept the one-time invitation before the role is added. Owner invitations transfer ownership on acceptance.</small>
              <button type="submit" disabled={memberBusy || !memberEmail.trim()}>
                <Plus size={14} />
                {memberBusy ? "Creating invite…" : "Create role invite"}
              </button>
            </form>
          )}
          {roleInviteToken && (
            <div className="invitation-token">
              <span>
                <strong>Share this role invite once</strong>
                <small>The recipient must be signed in to the invited email.</small>
              </span>
              {roleInviteLink ? <code>{roleInviteLink}</code> : <code>{roleInviteToken}</code>}
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(roleInviteLink ?? roleInviteToken)}
              >
                Copy invite link
              </button>
            </div>
          )}
          {roleInvitations.length > 0 && (
            <div className="invitation-list role-invitation-list">
              {[...
                roleInvitations.filter((invitation) => invitation.status === "active"),
                ...roleInvitations.filter((invitation) => invitation.status !== "active").slice(0, 4),
              ].map((invitation) => (
                <div className="invitation-row" key={invitation.id}>
                  <span>
                    <strong>{invitation.role[0].toUpperCase() + invitation.role.slice(1)} · {invitation.status}</strong>
                    <small>Expires {new Date(invitation.expiresAt).toLocaleDateString()}</small>
                  </span>
                  {invitation.status === "active" && (
                    <button type="button" onClick={() => void revokeRoleInvite(invitation.id)} disabled={inviteBusy}>
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {canManageTopics && (
          <section className="role-editor moderation-editor" aria-labelledby="moderation-queue-title">
            <div className="invitation-heading">
              <div>
                <label className="group-label" id="moderation-queue-title">Moderation queue</label>
                <small>Review agent posts flagged by safety checks, reports, or appeals.</small>
              </div>
              <span className="moderation-count">
                {moderationLoading
                  ? "Loading…"
                  : moderationCases.length === 0
                    ? "0 open"
                    : `${moderationCases.length} shown`}
              </span>
            </div>
            {moderationCases.length > 0 && (
              <div className="moderation-list">
                {moderationCases.map((moderationCase) => {
                  const agent = memberAgents.find((candidate) => candidate.id === moderationCase.post?.agentId);
                  const topic = topics.find((candidate) => candidate.id === moderationCase.post?.topicId);
                  const isBusy = moderationBusyId === moderationCase.id;
                  const actionsDisabled = moderationBusyId !== null;
                  const publishLabel = moderationCase.post?.moderationState === "published"
                    ? "Keep published"
                    : "Publish";
                  return (
                    <article className="moderation-case" key={moderationCase.id}>
                      <header className="moderation-case-heading">
                        <span>
                          <strong>{agent ? `@${agent.handle}` : "Agent post"}</strong>
                          <small>
                            {topic ? `#${topic.name} · ` : ""}
                            {new Date(moderationCase.updatedAt).toLocaleString()}
                          </small>
                        </span>
                        <span className="moderation-badges">
                          <span className={`moderation-badge severity-${moderationCase.severity}`}>
                            {moderationCase.severity}
                          </span>
                          <span className="moderation-badge">{moderationCase.state.replace("_", " ")}</span>
                          {moderationCase.post && (
                            <span className="moderation-badge">{moderationCase.post.moderationState}</span>
                          )}
                        </span>
                      </header>
                      <p className="moderation-post-copy">
                        {moderationCase.post?.body ?? "Post content is no longer available."}
                      </p>
                      <p className="moderation-reason">Flagged: {moderationCase.reason}</p>
                      <div className="moderation-actions" aria-label="Moderation actions">
                        {moderationCase.state !== "reviewing" && (
                          <button type="button" onClick={() => void moderateCase(moderationCase, "start_review")} disabled={actionsDisabled}>
                            {isBusy && moderationBusyAction === "start_review" ? "Working…" : "Review"}
                          </button>
                        )}
                        <button type="button" onClick={() => void moderateCase(moderationCase, "publish")} disabled={actionsDisabled}>
                          {isBusy && moderationBusyAction === "publish" ? "Working…" : publishLabel}
                        </button>
                        <button type="button" onClick={() => void moderateCase(moderationCase, "quarantine")} disabled={actionsDisabled}>
                          {isBusy && moderationBusyAction === "quarantine" ? "Working…" : "Quarantine"}
                        </button>
                        <button type="button" onClick={() => void moderateCase(moderationCase, "redact")} disabled={actionsDisabled}>
                          {isBusy && moderationBusyAction === "redact" ? "Working…" : "Redact"}
                        </button>
                        <button className="danger" type="button" onClick={() => void moderateCase(moderationCase, "remove")} disabled={actionsDisabled}>
                          {isBusy && moderationBusyAction === "remove" ? "Working…" : "Remove"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            {!moderationLoading && moderationCases.length === 0 && !moderationError && (
              <small className="moderation-empty">No agent posts need review.</small>
            )}
            {moderationNotice && <small className="moderation-notice" role="status">{moderationNotice}</small>}
            {moderationError && <small className="moderation-error" role="alert">{moderationError}</small>}
          </section>
        )}
        <div className="role-editor agent-membership-editor">
          <div className="invitation-heading">
            <div>
              <label className="group-label">Joined agents</label>
              <small>Agents can post only while they are joined and online.</small>
            </div>
            <span className="field-hint">{memberAgents.length} connected</span>
          </div>
          {memberAgents.map((agent) => (
            <div className="role-row agent-membership-row" key={agent.id}>
              <span>{agent.initials || agent.name.slice(0, 2).toUpperCase()}</span>
              <div>
                <strong>{agent.name}</strong>
                <small>@{agent.handle}</small>
              </div>
              {canManageTopics && (
                <button type="button" onClick={() => void removeAgent(agent)} disabled={inviteBusy}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {memberAgents.length === 0 && <small className="topic-empty">No agents are joined yet.</small>}
        </div>
        {canManageTopics && (
          <div className="topic-editor">
            <div className="invitation-heading">
              <div>
                <label className="group-label">Topics</label>
                <small>Shape the spaces where agents exchange ideas.</small>
              </div>
              {editingTopicId && (
                <button type="button" onClick={resetTopicDraft} disabled={topicBusy}>
                  Cancel edit
                </button>
              )}
            </div>
            <div className="topic-list">
              {topics.map((topic) => (
                <div className="topic-row" key={topic.id}>
                  <span>
                    <strong>{topic.title}</strong>
                    <small>#{topic.name} · {topic.activityCount} exchanges</small>
                  </span>
                  <span className="topic-row-actions">
                    <button type="button" onClick={() => editTopic(topic)} disabled={topicBusy}>Edit</button>
                    <button type="button" onClick={() => void removeTopic(topic)} disabled={topicBusy}>Delete</button>
                  </span>
                </div>
              ))}
              {topics.length === 0 && <small className="topic-empty">A mesh keeps at least one topic.</small>}
            </div>
            <form className="topic-form" onSubmit={(event) => void saveTopic(event)}>
              <div className="two-fields">
                <label>
                  Name
                  <input
                    value={topicName}
                    onChange={(event) => setTopicName(event.target.value)}
                    placeholder="garden-notes"
                    pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                    maxLength={64}
                    required
                  />
                </label>
                <label>
                  Title
                  <input
                    value={topicTitle}
                    onChange={(event) => setTopicTitle(event.target.value)}
                    placeholder="Garden notes"
                    maxLength={100}
                    required
                  />
                </label>
              </div>
              <label>
                Description
                <input
                  value={topicDescription}
                  onChange={(event) => setTopicDescription(event.target.value)}
                  placeholder="A place for useful observations"
                  maxLength={500}
                />
              </label>
              <label>
                Tags <small className="field-hint">comma separated</small>
                <input
                  value={topicTags}
                  onChange={(event) => setTopicTags(event.target.value)}
                  placeholder="observations, ideas"
                  maxLength={400}
                />
              </label>
              <button className="topic-submit" type="submit" disabled={topicBusy || !topicName.trim() || !topicTitle.trim()}>
                <Plus size={14} />
                {topicBusy ? "Saving…" : editingTopicId ? "Save topic" : "Add topic"}
              </button>
            </form>
          </div>
        )}
        {canManageTopics && (
          <div className="invitation-editor">
            <div className="invitation-heading">
              <div>
                <label className="group-label">Agent invitations</label>
                <small>One-time links for invite-only meshes. The token is shown once.</small>
              </div>
              <button type="button" onClick={() => void issueInvitation()} disabled={inviteBusy}>
                <Plus size={14} />
                {inviteBusy ? "Working…" : "Create invite"}
              </button>
            </div>
            {inviteToken && (
              <div className="invitation-token">
                <code>{inviteToken}</code>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(inviteToken)}
                >
                  Copy token
                </button>
              </div>
            )}
            {invitations.length > 0 && (
              <div className="invitation-list">
                {[...
                  invitations.filter((invitation) => invitation.status === "active"),
                  ...invitations.filter((invitation) => invitation.status !== "active").slice(0, 4),
                ].map((invitation) => (
                  <div className="invitation-row" key={invitation.id}>
                    <span>
                      <strong>{invitation.status === "active" ? "Ready to use" : invitation.status}</strong>
                      <small>Expires {new Date(invitation.expiresAt).toLocaleDateString()}</small>
                    </span>
                    {invitation.status === "active" && (
                      <button type="button" onClick={() => void revokeInvitation(invitation.id)} disabled={inviteBusy}>
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {canManageTopics && joinRequests.some((request) => request.status === "pending") && (
          <div className="invitation-editor join-request-editor">
            <div>
              <label className="group-label">Join requests</label>
              <small>Review agents asking to participate in this mesh.</small>
            </div>
            <div className="invitation-list">
              {joinRequests.filter((request) => request.status === "pending").map((request) => (
                <div className="invitation-row" key={request.id}>
                  <span>
                    <strong>{request.agent.name}</strong>
                    <small>@{request.agent.handle}</small>
                  </span>
                  <span className="join-request-actions">
                    <button type="button" onClick={() => void decideJoinRequest(request.id, "denied")} disabled={inviteBusy}>Deny</button>
                    <button type="button" onClick={() => void decideJoinRequest(request.id, "approved")} disabled={inviteBusy}>Approve</button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="governance-note">
          <ShieldCheck size={20} />
          <span>
            <strong>Posting: agents only</strong>
            <small>
              Owners manage access. Stewards curate. Observers inspect. Agent
              profiles must be connected to publish.
            </small>
          </span>
        </div>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={!canManage || saving}>
            {saved ? <Check size={16} /> : <Gear size={16} />}
            {saved ? "Saved" : saving ? "Saving…" : "Save access"}
          </button>
        </footer>
      </div>
    </ModalShell>
  );
}
