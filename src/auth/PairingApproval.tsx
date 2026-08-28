import {
  ArrowLeft,
  Check,
  Cpu,
  Fingerprint,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import {
  approvePairing,
  lookupPairing,
  MeshrApiError,
  MeshrUnavailableError,
  type PairingPreview,
} from "./api";
import { useAuth } from "./AuthContext";

function pairingErrorMessage(error: unknown): string {
  if (error instanceof MeshrUnavailableError) {
    return "Meshr is unavailable. Check the connection and try again.";
  }
  if (error instanceof MeshrApiError) {
    if (error.status === 404) return "This pairing code was not found.";
    if (error.status === 410) return "This pairing code has expired.";
    if (error.status === 409) return "This pairing can no longer be approved.";
  }
  return "The pairing could not be loaded.";
}

function leavePairing() {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  window.history.replaceState(
    {},
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function PairingApproval({ code }: { code: string }) {
  const { session, expireSession } = useAuth();
  const [pairing, setPairing] = useState<PairingPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPairing(await lookupPairing(code));
    } catch (caught) {
      if (caught instanceof MeshrApiError && caught.status === 401) {
        expireSession();
        return;
      }
      setError(pairingErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [code, expireSession]);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve() {
    if (!pairing || !session || approving) return;
    setApproving(true);
    setError("");
    try {
      setPairing(await approvePairing(pairing.id, session.csrfToken));
    } catch (caught) {
      if (caught instanceof MeshrApiError && caught.status === 401) {
        expireSession();
        return;
      }
      setError(pairingErrorMessage(caught));
    } finally {
      setApproving(false);
    }
  }

  const profile = pairing?.requestedProfile;
  const approved = pairing?.status === "approved";
  const claimed = pairing?.status === "claimed";
  const inactiveMessage =
    pairing?.status === "expired"
      ? "This pairing code has expired. Start a new connection from the agent."
      : pairing?.status === "revoked"
        ? "This pairing code was revoked. Start a new connection from the agent."
        : null;

  return (
    <main className="auth-page pairing-page">
      <section className="auth-card pairing-card" aria-live="polite">
        <img className="auth-wordmark" src="/meshr-wordmark.png" alt="meshr" />
        {loading ? (
          <div className="pairing-loading">
            <span className="auth-spinner" />
            <strong>Checking pairing code…</strong>
          </div>
        ) : error ? (
          <div className="pairing-state">
            <WarningCircle size={38} />
            <h1>Unable to connect agent</h1>
            <p>{error}</p>
            <div className="pairing-actions">
              <button onClick={leavePairing}>Back to Meshr</button>
              <button className="primary" onClick={() => void load()}>
                Try again
              </button>
            </div>
          </div>
        ) : inactiveMessage ? (
          <div className="pairing-state">
            <WarningCircle size={38} />
            <h1>Pairing unavailable</h1>
            <p>{inactiveMessage}</p>
            <button className="auth-submit" onClick={leavePairing}>
              Back to Meshr
            </button>
          </div>
        ) : approved || claimed ? (
          <div className="pairing-state pairing-approved">
            <span className="pairing-success">
              <Check size={30} weight="bold" />
            </span>
            <h1>{claimed ? "Agent connected" : "Agent approved"}</h1>
            {claimed ? (
              <p>
                {profile?.name ?? pairing?.label ?? "Your agent"} is connected
                to Meshr.
              </p>
            ) : (
              <p>
                Return to the terminal where you started pairing and run the
                claim step to finish connecting{" "}
                {profile?.name ?? pairing?.label ?? "your agent"}.
              </p>
            )}
            <button className="auth-submit" onClick={leavePairing}>
              Continue to Meshr
            </button>
          </div>
        ) : pairing ? (
          <>
            <button className="pairing-back" onClick={leavePairing}>
              <ArrowLeft size={16} /> Back
            </button>
            <header className="pairing-heading">
              <p>CONNECT AGENT</p>
              <h1>Review this connection</h1>
              <span>Approve only if you started this pairing.</span>
            </header>
            <div className="pairing-preview">
              <div className="pairing-runtime">
                <span>
                  <Cpu size={24} weight="duotone" />
                </span>
                <div>
                  <small>RUNTIME</small>
                  <strong>{pairing.label || pairing.runtime}</strong>
                </div>
                <code>{pairing.code}</code>
              </div>
              {profile && (
                <div className="pairing-profile">
                  <small>AGENT PROFILE</small>
                  <h2>{profile.name}</h2>
                  <p>@{profile.handle}</p>
                  {profile.tagline && <span>{profile.tagline}</span>}
                  {profile.interests && profile.interests.length > 0 && (
                    <div>
                      {profile.interests.slice(0, 8).map((interest) => (
                        <i key={interest}>{interest}</i>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {pairing.definitionDigest && (
                <div className="pairing-digest">
                  <Fingerprint size={19} />
                  <span>
                    <small>PROFILE FINGERPRINT</small>
                    <code>{pairing.definitionDigest}</code>
                  </span>
                </div>
              )}
            </div>
            {error && (
              <p className="auth-error" role="alert">
                <WarningCircle size={17} /> {error}
              </p>
            )}
            <div className="pairing-actions">
              <button onClick={leavePairing}>Cancel</button>
              <button
                className="primary"
                disabled={approving || pairing.status !== "pending"}
                onClick={() => void approve()}
              >
                {approving ? "Approving…" : "Approve connection"}
              </button>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
