export interface LoadAgentFixture {
  agentId: string;
  token: string;
  /**
   * Signed-renewal material is required for rehearsals longer than the
   * fifteen-minute runtime-session lifetime. Keep this fixture mode-0600.
   */
  pairingId?: string;
  pairingSecret?: string;
  privateKeyPem?: string;
  sessionId?: string;
  tokenExpiresAt?: string;
  meshId?: string;
  topicId?: string;
}

export interface LoadViewerFixture {
  /** A complete cookie header, normally `meshr_session=<opaque-value>`. */
  cookie: string;
  /** Optional agent grant/authorization for a non-human observer. */
  authorization?: string;
}

export interface LoadFixture {
  contractVersion?: 1;
  baseUrl: string;
  liveUrl?: string;
  meshId: string;
  topicId: string;
  agents: LoadAgentFixture[];
  viewers: LoadViewerFixture[];
}

export interface LoadRehearsalOptions {
  fixturePath: string;
  evidencePath?: string;
  runId?: string;
  /** Shared mode-0600 accepted-event feed for distributed viewer workers. */
  eventFeedPath?: string;
  workerRole: "combined" | "writer" | "viewer";
  /** Total agent target represented by the writer/combined run. */
  totalAgentCount: number;
  durationSeconds: number;
  postRate: number;
  viewerCount: number;
  viewerOffset: number;
  totalViewerCount: number;
  strictTarget: boolean;
  maxInflightWrites: number;
  requestTimeoutMs: number;
  reconnect: boolean;
  reconnectMaxDelayMs: number;
  dryRun: boolean;
}

export interface HistogramSummary {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface LoadRehearsalEvidence {
  contractVersion: 1;
  runId: string;
  fixturePath: string;
  startedAt: string;
  finishedAt: string;
  target: {
    agentCount: number;
    totalAgentCount: number;
    viewerCount: number;
    viewerOffset: number;
    totalViewerCount: number;
    workerRole: "combined" | "writer" | "viewer" | "distributed";
    postRatePerSecond: number;
    durationSeconds: number;
  };
  observed: {
    writeAttempts: number;
    acceptedPosts: number;
    writeErrors: number;
    achievedPostRatePerSecond: number;
    runDurationSeconds: number;
    statusCounts: Record<string, number>;
    sessionHeartbeats: number;
    sessionRenewals: number;
    sessionErrors: number;
    viewerConnectAttempts: number;
    viewerConnections: number;
    viewerInitialConnections: number;
    viewerConnectionErrors: number;
    viewerFrames: number;
    viewerSnapshotReceipts: number;
    viewerTopologyObservations: number;
    topologyLatencyObservations: number;
    viewerPostUpdateReceipts: number;
    /** Per-global-viewer minute buckets with at least one correlated update. */
    viewerPostUpdateBuckets: Record<string, number[]>;
    viewerProcessingErrors: number;
    reconnectAttempts: number;
    reconnects: number;
    viewerReconnectReceipts: number;
    reconnectErrors: number;
    /** Difference between the runner clock and the HTTP server Date header. */
    clockOffsetMs: number | null;
  };
  latencyMs: {
    writes: HistogramSummary;
    topologyUpdates: HistogramSummary;
    reconnectRecovery: HistogramSummary;
  };
  gates: {
    strictTarget: boolean;
    targetShapePassed: boolean;
    achievedPostRatePassed: boolean;
    durationPassed: boolean;
    viewerCoveragePassed: boolean;
    topologyTemporalCoveragePassed: boolean;
    sessionContinuityPassed: boolean;
    writeP95Below750Ms: boolean;
    topologyP95Below2s: boolean;
    reconnectP95Below5s: boolean;
    unexpectedErrorRateBelow1Percent: boolean;
    clockSkewBelow1s: boolean;
    qualified: boolean;
  };
  limitations: string[];
}
