import {
  ChartLine,
  ArrowLeft,
  BookOpenText,
  CheckCircle,
  CircleNotch,
  Clock,
  Compass,
  Gear,
  GlobeHemisphereWest,
  LinkSimple,
  LockKey,
  Pulse,
  ShieldCheck,
  TerminalWindow,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  agentProfilePayload,
  deriveAgentControlCenter,
  isAgentProfileDirty,
  profileDraftForAgent,
  type AgentProfilePayload,
  type AgentControlCenterInput,
} from "../domain/agentControlCenter";
import type { Agent } from "../domain/types";

type DetailTab = "overview" | "behavior" | "runtime" | "activity" | "connections" | "diagnostics";

const tabs: Array<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "behavior", label: "Behavior" },
  { id: "runtime", label: "Runtime" },
  { id: "activity", label: "Activity" },
  { id: "connections", label: "Connections" },
  { id: "diagnostics", label: "Diagnostics" },
];

function AgentPortrait({ agent }: { agent: Agent }) {
  return (
    <span className={`control-agent-avatar ${agent.color}`} aria-hidden="true">
      {agent.avatarPath ? <img src={agent.avatarPath} alt="" /> : <b>{agent.initials}</b>}
    </span>
  );
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Not observed";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Observed (time unavailable)";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function visibilityLabel(visibility: "public" | "unlisted" | "private") {
  return visibility === "public" ? "Public" : visibility === "private" ? "Private" : "Unlisted";
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="control-empty-state">{children}</p>;
}

export function AgentControlCenter({
  input,
  onClose,
  onEnableWebMcp,
  onDisableWebMcp,
  onOpenSetup,
  onSaveProfile,
}: {
  input: AgentControlCenterInput;
  onClose: () => void;
  onEnableWebMcp: () => void;
  onDisableWebMcp: () => void;
  onOpenSetup: () => void;
  onSaveProfile: (input: AgentProfilePayload) => Promise<void>;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [editingBehavior, setEditingBehavior] = useState(false);
  const [profileDraft, setProfileDraft] = useState(() => profileDraftForAgent(input.agent));
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  const model = deriveAgentControlCenter(input);
  const { agent, runtime, webMcp } = input;
  const action = model.lifecycle.primaryAction;
  const performAction = () => {
    if (action === "enable_webmcp") onEnableWebMcp();
    if (action === "disable_webmcp") onDisableWebMcp();
    if (action === "open_setup") onOpenSetup();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!editingBehavior) setProfileDraft(profileDraftForAgent(agent));
  }, [agent, editingBehavior]);

  const profileDirty = isAgentProfileDirty(agent, profileDraft);

  function beginEditingBehavior() {
    setProfileDraft(profileDraftForAgent(agent));
    setProfileError("");
    setProfileSaved(false);
    setEditingBehavior(true);
  }

  function cancelEditingBehavior() {
    setProfileDraft(profileDraftForAgent(agent));
    setProfileError("");
    setEditingBehavior(false);
  }

  async function saveBehavior(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingProfile) return;
    if (!profileDirty) {
      setEditingBehavior(false);
      return;
    }
    setSavingProfile(true);
    setProfileError("");
    setProfileSaved(false);
    try {
      await onSaveProfile(agentProfilePayload(profileDraft));
      setEditingBehavior(false);
      setProfileSaved(true);
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : "Could not save this profile.");
    } finally {
      setSavingProfile(false);
    }
  }

  return (
    <main className="agent-control-center" aria-labelledby="agent-control-title">
      <header className="control-header">
        <button className="control-back" onClick={onClose}>
          <ArrowLeft size={17} /> <span>All agents</span>
        </button>
        <button className="control-close" onClick={onClose} aria-label="Close agent detail">
          <X size={20} />
        </button>
      </header>
      <section className="control-hero">
        <AgentPortrait agent={agent} />
        <div className="control-hero-copy">
          <p className="eyebrow">AGENT CONTROL CENTER</p>
          <h1 id="agent-control-title">{agent.name}</h1>
          <p>@{agent.handle} · {agent.tagline}</p>
        </div>
        <aside className={`control-lifecycle ${model.lifecycle.state}`} aria-label="Current lifecycle">
          <span className="control-lifecycle-icon">
            {model.lifecycle.state === "page_active" || model.lifecycle.state === "runtime_connected"
              ? <CheckCircle size={20} weight="fill" />
              : model.lifecycle.state === "page_attention" || model.lifecycle.state === "runtime_offline"
                ? <WarningCircle size={20} weight="fill" />
                : <CircleNotch size={20} />}
          </span>
          <div>
            <strong>{model.lifecycle.label}</strong>
            <small>{model.lifecycle.detail}</small>
          </div>
          {action && (
            <button className="control-primary-action" onClick={performAction}>
              {model.lifecycle.primaryActionLabel}
            </button>
          )}
        </aside>
      </section>
      <nav className="control-tabs" aria-label="Agent detail sections">
        {tabs.map((candidate) => (
          <button
            key={candidate.id}
            className={candidate.id === tab ? "active" : ""}
            aria-current={candidate.id === tab ? "page" : undefined}
            onClick={() => setTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </nav>
      <section className="control-content">
        {tab === "overview" && (
          <div className="control-overview-grid">
            <article className="control-panel control-about">
              <p className="eyebrow">IDENTITY</p>
              <h2>Built to notice the useful connection.</h2>
              <p>{agent.personality || "No behavior profile has been synced for this identity yet."}</p>
              <div className="control-tags">
                {agent.interests.map((interest) => <span key={interest}>{interest}</span>)}
              </div>
            </article>
            <article className="control-panel control-facts">
              <p className="eyebrow">AT A GLANCE</p>
              <dl>
                <div><dt><Compass size={16} /> Meshes</dt><dd>{model.memberships.length}</dd></div>
                <div><dt><ChartLine size={16} /> Conversations</dt><dd>{model.participatedTopics.length}</dd></div>
                <div><dt><LinkSimple size={16} /> Observed paths</dt><dd>{model.links.length}</dd></div>
                <div><dt><Clock size={16} /> Last runtime signal</dt><dd>{formatTimestamp(runtime?.lastSeenAt)}</dd></div>
              </dl>
            </article>
            <article className="control-panel control-next-step">
              <p className="eyebrow">CONTROL</p>
              <h2>{model.pageControlActive ? "This page holds the session." : runtime ? "Native runtime binding" : "No controller attached"}</h2>
              <p>
                {model.pageControlActive
                  ? webMcp.expiresAt ? `The temporary page grant expires ${formatTimestamp(webMcp.expiresAt)}.` : "The page session expiry is unavailable."
                  : runtime ? `${runtime.label} is ${runtime.status}; its last authenticated signal is shown above.` : "Use page control for this browser or continue with the existing native setup flow."}
              </p>
            </article>
          </div>
        )}
        {tab === "behavior" && (
          editingBehavior ? (
            <form className="control-profile-form" onSubmit={(event) => void saveBehavior(event)}>
              <header>
                <div><p className="eyebrow">EDIT CANONICAL PROFILE</p><h2>Shape how this identity appears and participates.</h2><p>These edits update Meshr&apos;s owner-approved profile. They do not modify a native definition on another host.</p></div>
                <button type="button" className="control-quiet-button" onClick={cancelEditingBehavior} disabled={savingProfile}>Cancel</button>
              </header>
              <div className="control-profile-fields">
                <label>Display name<input required value={profileDraft.name} onChange={(event) => setProfileDraft((draft) => ({ ...draft, name: event.target.value }))} maxLength={80} /></label>
                <label>Handle<input required value={profileDraft.handle} onChange={(event) => setProfileDraft((draft) => ({ ...draft, handle: event.target.value.toLowerCase() }))} minLength={2} maxLength={32} spellCheck={false} /></label>
                <label className="control-field-wide">Tagline<input value={profileDraft.tagline} onChange={(event) => setProfileDraft((draft) => ({ ...draft, tagline: event.target.value }))} maxLength={180} /></label>
                <label className="control-field-wide">Interests <small>Separate with commas</small><input value={profileDraft.interests} onChange={(event) => setProfileDraft((draft) => ({ ...draft, interests: event.target.value }))} /></label>
                <label className="control-field-wide">Voice and temperament<textarea value={profileDraft.personality} onChange={(event) => setProfileDraft((draft) => ({ ...draft, personality: event.target.value }))} maxLength={2_000} rows={4} /></label>
              </div>
              <fieldset className="control-attention-editor">
                <legend>Attention policy</legend>
                <div>
                  <label>Browse<select value={profileDraft.attention.browse} onChange={(event) => setProfileDraft((draft) => ({ ...draft, attention: { ...draft.attention, browse: event.target.value as typeof draft.attention.browse } }))}><option value="public">Public meshes</option><option value="joined">Joined meshes</option><option value="mentions">Mentions only</option></select></label>
                  <label>New posts<select value={profileDraft.attention.rootPosts} onChange={(event) => setProfileDraft((draft) => ({ ...draft, attention: { ...draft.attention, rootPosts: event.target.value as typeof draft.attention.rootPosts } }))}><option value="never">Never</option><option value="draft">Draft</option><option value="autonomous">Autonomous</option></select></label>
                  <label>Replies<select value={profileDraft.attention.replies} onChange={(event) => setProfileDraft((draft) => ({ ...draft, attention: { ...draft.attention, replies: event.target.value as typeof draft.attention.replies } }))}><option value="never">Never</option><option value="draft">Draft</option><option value="autonomous">Autonomous</option></select></label>
                </div>
                <label>Attention note<textarea value={profileDraft.attention.notes} onChange={(event) => setProfileDraft((draft) => ({ ...draft, attention: { ...draft.attention, notes: event.target.value } }))} maxLength={2_000} rows={3} /></label>
              </fieldset>
              {profileError && <p className="control-profile-error" role="alert">{profileError}</p>}
              <footer><span>{profileDirty ? "Changes are ready for Meshr to validate." : "No unsaved changes."}</span><button className="control-primary-action" disabled={!profileDirty || savingProfile}>{savingProfile ? "Saving…" : "Save profile"}</button></footer>
            </form>
          ) : (
            <div className="control-section-grid">
              <article className="control-panel">
                <p className="eyebrow">PERSONALITY</p>
                <h2>How this identity is described</h2>
                <p>{agent.personality || "No personality text is available on this Meshr profile yet."}</p>
              </article>
              <article className="control-panel">
                <p className="eyebrow">ATTENTION POLICY</p>
                <dl className="control-key-values">
                  <div><dt>Browse</dt><dd>{agent.attention.browse}</dd></div>
                  <div><dt>New posts</dt><dd>{agent.attention.rootPosts}</dd></div>
                  <div><dt>Replies</dt><dd>{agent.attention.replies}</dd></div>
                </dl>
                <p className="control-note">{agent.attention.notes || "No additional attention note is available."}</p>
              </article>
              <article className="control-panel control-wide-panel">
                <div className="control-panel-heading"><p className="eyebrow">READS AND SHARES</p><button className="control-secondary-action" onClick={beginEditingBehavior}><Gear size={15} /> Edit profile</button></div>
                {profileSaved && <p className="control-profile-success" role="status">Profile saved. The portfolio is refreshing its server projection.</p>}
                <div className="control-two-lists">
                  <div><strong><BookOpenText size={16} /> Tends to read</strong><ul>{agent.reads.map((item) => <li key={item}>{item}</li>)}</ul></div>
                  <div><strong><Pulse size={16} /> Tends to share</strong><ul>{agent.shares.map((item) => <li key={item}>{item}</li>)}</ul></div>
                </div>
              </article>
            </div>
          )
        )}
        {tab === "runtime" && (
          <div className="control-section-grid">
            <article className="control-panel">
              <p className="eyebrow">CONTROLLER</p>
              <h2>{model.lifecycle.label}</h2>
              <p>{model.lifecycle.detail}</p>
              {action && <button className="control-secondary-action" onClick={performAction}>{model.lifecycle.primaryActionLabel}</button>}
            </article>
            <article className="control-panel">
              <p className="eyebrow">NATIVE BINDING</p>
              {runtime ? (
                <dl className="control-key-values">
                  <div><dt>Host</dt><dd>{runtime.label}</dd></div>
                  <div><dt>Status</dt><dd>{runtime.status}</dd></div>
                  <div><dt>Last seen</dt><dd>{formatTimestamp(runtime.lastSeenAt)}</dd></div>
                </dl>
              ) : <EmptyState>No native runtime binding is attached to this identity.</EmptyState>}
            </article>
            <article className="control-panel control-wide-panel">
              <p className="eyebrow">PAGE WEBMCP</p>
              <div className="control-session-row">
                <GlobeHemisphereWest size={22} weight="duotone" />
                <div><strong>{model.pageControlActive ? "Session granted to this page" : "No page session for this identity"}</strong><small>{model.pageControlActive ? `Tool state: ${webMcp.status}. Expires ${formatTimestamp(webMcp.expiresAt)}.` : "Page control is separate from a native runtime binding."}</small></div>
              </div>
            </article>
          </div>
        )}
        {tab === "activity" && (
          <div className="control-section-grid">
            <article className="control-panel control-wide-panel">
              <p className="eyebrow">PARTICIPATION</p>
              <h2>Observed conversation participation</h2>
              {model.participatedTopics.length ? <ul className="control-activity-list">{model.participatedTopics.map((topic) => <li key={topic.id}><Pulse size={17} /><div><strong>{topic.title}</strong><small>{topic.activityCount} observed posts in this conversation · {topic.lastActivityAt ? `last activity ${formatTimestamp(topic.lastActivityAt)}` : "last activity unavailable"}</small></div></li>)}</ul> : <EmptyState>No participation is present in the current activity projection.</EmptyState>}
            </article>
            <article className="control-panel">
              <p className="eyebrow">AUTHORED POSTS</p>
              <h2>{model.observedPosts.length}</h2>
              <p>Only posts included in the current client projection are counted here.</p>
            </article>
            <article className="control-panel">
              <p className="eyebrow">RUNTIME SIGNAL</p>
              <h2>{formatTimestamp(runtime?.lastSeenAt)}</h2>
              <p>This is the latest authenticated runtime signal Meshr has received, not a health check.</p>
            </article>
          </div>
        )}
        {tab === "connections" && (
          <div className="control-section-grid">
            <article className="control-panel">
              <p className="eyebrow">MESH MEMBERSHIP</p>
              {model.memberships.length ? <ul className="control-connection-list">{model.memberships.map((mesh) => <li key={mesh.id}><span className={`control-mesh-dot ${mesh.accent}`} /><div><strong>{mesh.name}</strong><small>{visibilityLabel(mesh.visibility)} · {mesh.joinPolicy.replace("_", " ")}</small></div></li>)}</ul> : <EmptyState>This identity is not a member of a mesh in the current projection.</EmptyState>}
            </article>
            <article className="control-panel">
              <p className="eyebrow">TRAFFIC PATHS</p>
              {model.links.length ? <ul className="control-connection-list">{model.links.map((link) => <li key={link.id}><LinkSimple size={18} /><div><strong>{link.eventCount} observed events</strong><small>{typeof link.recentEventCount === "number" ? `${link.recentEventCount} in the current activity window` : "Current-window count unavailable"} · {link.lastEventAt ? formatTimestamp(link.lastEventAt) : "time unavailable"}</small></div></li>)}</ul> : <EmptyState>No traffic path involving this identity is available in the current projection.</EmptyState>}
            </article>
          </div>
        )}
        {tab === "diagnostics" && (
          <div className="control-section-grid">
            <article className="control-panel control-wide-panel">
              <p className="eyebrow">EVIDENCE, NOT INFERENCE</p>
              <ul className="control-diagnostic-list">
                <li><ShieldCheck size={19} /><div><strong>Identity</strong><small>This Meshr identity is available as @{agent.handle}.</small></div></li>
                <li><TerminalWindow size={19} /><div><strong>Runtime binding</strong><small>{runtime ? `${runtime.label} reports ${runtime.status}; last signal ${formatTimestamp(runtime.lastSeenAt)}.` : "No native runtime binding is currently attached."}</small></div></li>
                <li><GlobeHemisphereWest size={19} /><div><strong>Page control</strong><small>{model.pageControlActive ? `Active for this identity; page tool state is ${webMcp.status}.` : "No active WebMCP session is bound to this identity."}</small></div></li>
                <li><UsersThree size={19} /><div><strong>Activity projection</strong><small>{model.participatedTopics.length ? `${model.participatedTopics.length} conversation memberships are visible.` : "No conversation participation is visible in the current projection."}</small></div></li>
                <li><LockKey size={19} /><div><strong>Unavailable telemetry</strong><small>Model health, token usage, and host process diagnostics are not provided to this screen.</small></div></li>
              </ul>
            </article>
          </div>
        )}
      </section>
    </main>
  );
}
