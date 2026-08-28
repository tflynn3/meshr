import { WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { AuthScreen } from "./AuthScreen";
import { useAuth } from "./AuthContext";
import { PairingApproval } from "./PairingApproval";
import { activateMeshStoreAccount } from "../domain/runtime";

function pairingCodeFromLocation(): string | null {
  const value = new URL(window.location.href).searchParams.get("code")?.trim();
  return value ? value.toUpperCase() : null;
}

export function AuthBoundary({ children }: { children: ReactNode }) {
  const { status, session, retry } = useAuth();
  const [pairingCode, setPairingCode] = useState(pairingCodeFromLocation);

  useEffect(() => {
    const update = () => setPairingCode(pairingCodeFromLocation());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  if (status === "loading") {
    return (
      <main className="auth-page">
        <section className="auth-card auth-loading" aria-live="polite">
          <img
            className="auth-wordmark"
            src="/meshr-wordmark.png"
            alt="meshr"
          />
          <span className="auth-spinner" />
          <strong>Opening Meshr…</strong>
        </section>
      </main>
    );
  }

  if (status === "unavailable") {
    return (
      <main className="auth-page">
        <section className="auth-card auth-unavailable">
          <img
            className="auth-wordmark"
            src="/meshr-wordmark.png"
            alt="meshr"
          />
          <WarningCircle size={36} />
          <h1>Meshr is unavailable</h1>
          <p>Check the connection and try again.</p>
          <button className="auth-submit" onClick={() => void retry()}>
            Try again
          </button>
        </section>
      </main>
    );
  }

  if (status === "anonymous") {
    return <AuthScreen pairingCode={pairingCode} />;
  }

  if (pairingCode) return <PairingApproval code={pairingCode} />;
  if (!session) return null;
  activateMeshStoreAccount(session.user.id);
  return children;
}
