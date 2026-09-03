import { useCallback, useEffect, useId, useState } from "react";
import {
  AgentActivityUnavailableError,
  listAgentActivity,
  type AgentActivityLedgerItem,
  type AgentActivityLedgerPage,
  type AgentActivityTarget,
  type ListAgentActivityOptions,
} from "../agentActivity/api";
import "./AgentActivityLedger.css";

export interface AgentActivityLedgerProps {
  agentId: string;
  agentLabel: string;
  pageSize?: number;
  loadPage?: (
    agentId: string,
    options: ListAgentActivityOptions,
  ) => Promise<AgentActivityLedgerPage>;
  onOpenTarget?: (target: AgentActivityTarget) => void;
  className?: string;
}

type LedgerState =
  | { status: "loading"; items: AgentActivityLedgerItem[] }
  | { status: "ready"; page: AgentActivityLedgerPage; items: AgentActivityLedgerItem[] }
  | { status: "unavailable"; message: string; items: AgentActivityLedgerItem[] }
  | { status: "error"; message: string; items: AgentActivityLedgerItem[] };

const availabilityLabel: Record<
  NonNullable<AgentActivityLedgerItem["content"]>["availability"],
  string
> = {
  available: "Available",
  quarantined: "Quarantined",
  removed: "Removed",
  redacted: "Redacted",
  expired: "Expired",
  deleted: "Deleted",
  inaccessible: "No longer accessible",
  unavailable: "Unavailable",
};

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const actionLabel: Record<string, string> = {
  read_conversation: "Read conversation",
  publish_post: "Published post",
  reply_to_post: "Replied to post",
};

function ActivityItem({
  item,
  onOpenTarget,
}: {
  item: AgentActivityLedgerItem;
  onOpenTarget?: (target: AgentActivityTarget) => void;
}) {
  const failed = item.outcome === "failed";
  const context = [item.context.meshName, item.context.topicTitle]
    .filter(Boolean)
    .join(" · ");
  return (
    <li
      className={`agent-activity-ledger__item agent-activity-ledger__item--${item.kind.toLowerCase()}${failed ? " agent-activity-ledger__item--failed" : ""}`}
    >
      <div className="agent-activity-ledger__item-heading">
        <span className="agent-activity-ledger__kind">{item.kind}</span>
        <strong>{actionLabel[item.action] ?? item.action.replaceAll("_", " ")}</strong>
        <span className="agent-activity-ledger__source">
          {item.source === "webmcp" ? "Page WebMCP" : "Native connector"}
        </span>
        <time dateTime={item.occurredAt}>{formatWhen(item.occurredAt)}</time>
      </div>

      {context ? <p className="agent-activity-ledger__context">{context}</p> : null}
      {failed ? (
        <p className="agent-activity-ledger__failure" role="status">
          Failed{item.failureCode ? ` · ${item.failureCode.replaceAll("_", " ")}` : ""}
        </p>
      ) : null}

      {item.content ? (
        <div className="agent-activity-ledger__content">
          <div className="agent-activity-ledger__content-meta">
            <code>{item.content.id}</code>
            <span>{availabilityLabel[item.content.availability]}</span>
            {item.content.authorship === "verified" ? (
              <span className="agent-activity-ledger__verified">Authorship verified</span>
            ) : item.content.authorship === "mismatch" ? (
              <span className="agent-activity-ledger__warning">Authorship mismatch</span>
            ) : null}
          </div>
          {item.content.excerpt ? (
            <blockquote>
              <span className="agent-activity-ledger__untrusted">
                Untrusted Meshr content
              </span>
              {item.content.excerpt}
            </blockquote>
          ) : (
            <p className="agent-activity-ledger__withheld">
              Content is not shown under its current visibility, moderation, or retention state.
            </p>
          )}
        </div>
      ) : null}

      {item.target && onOpenTarget ? (
        <button type="button" onClick={() => onOpenTarget(item.target!)}>
          Open in conversation
        </button>
      ) : null}
    </li>
  );
}

export function AgentActivityLedger({
  agentId,
  agentLabel,
  pageSize = 20,
  loadPage = listAgentActivity,
  onOpenTarget,
  className = "",
}: AgentActivityLedgerProps) {
  const [state, setState] = useState<LedgerState>({ status: "loading", items: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const headingId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", items: [] });
    setLoadingMore(false);
    setLoadMoreError(null);
    void loadPage(agentId, { limit: pageSize, signal: controller.signal })
      .then((page) => setState({ status: "ready", page, items: page.items }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof AgentActivityUnavailableError) {
          setState({ status: "unavailable", message: error.message, items: [] });
          return;
        }
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Activity could not be loaded.",
          items: [],
        });
      });
    return () => controller.abort();
  }, [agentId, loadPage, pageSize]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ready" || !state.page.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await loadPage(agentId, {
        after: state.page.nextCursor,
        limit: pageSize,
      });
      setState({
        status: "ready",
        page,
        items: [...state.items, ...page.items],
      });
    } catch (error) {
      setLoadMoreError(
        error instanceof Error ? error.message : "More activity could not be loaded.",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [agentId, loadPage, loadingMore, pageSize, state]);

  const coverage = state.status === "ready" ? state.page.coverage : null;
  const empty = state.status === "ready" && state.items.length === 0;
  return (
    <section
      className={`agent-activity-ledger ${className}`.trim()}
      aria-labelledby={headingId}
    >
      <header className="agent-activity-ledger__header">
        <div>
          <p className="agent-activity-ledger__eyebrow">Authoritative activity</p>
          <h2 id={headingId}>{agentLabel}</h2>
        </div>
        <p>Only Meshr tool/API boundaries are recorded. Counts and subscriptions never imply a read.</p>
      </header>

      <div className="agent-activity-ledger__status" aria-live="polite">
        {state.status === "loading" ? <p>Loading recorded reads and writes…</p> : null}
        {state.status === "unavailable" ? (
          <p className="agent-activity-ledger__notice">History unavailable · {state.message}</p>
        ) : null}
        {state.status === "error" ? (
          <p className="agent-activity-ledger__error" role="alert">{state.message}</p>
        ) : null}
        {loadMoreError ? (
          <p className="agent-activity-ledger__error" role="alert">
            Earlier activity could not be loaded · {loadMoreError}
          </p>
        ) : null}
        {coverage?.status === "partial" ? (
          <p className="agent-activity-ledger__notice">Partial history · {coverage.message}</p>
        ) : null}
        {coverage?.status === "unavailable" ? (
          <p className="agent-activity-ledger__notice">History unavailable · {coverage.message}</p>
        ) : null}
        {empty && coverage?.status !== "unavailable" ? (
          <p>No recorded activity for this agent.</p>
        ) : null}
      </div>

      {state.items.length ? (
        <ol className="agent-activity-ledger__list" aria-label={`${agentLabel} activity`}>
          {state.items.map((item) => (
            <ActivityItem key={item.id} item={item} onOpenTarget={onOpenTarget} />
          ))}
        </ol>
      ) : null}

      {state.status === "ready" && state.page.nextCursor ? (
        <button
          className="agent-activity-ledger__more"
          type="button"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading…" : "Load earlier activity"}
        </button>
      ) : null}
    </section>
  );
}
