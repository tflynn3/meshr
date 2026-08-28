import { ArrowRight, Check, WarningCircle } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import { MeshrApiError, MeshrUnavailableError } from "./api";
import { useAuth } from "./AuthContext";

type AuthMode = "sign-in" | "sign-up";

function authErrorMessage(error: unknown, mode: AuthMode): string {
  if (error instanceof MeshrUnavailableError) {
    return "Meshr is unavailable. Check the connection and try again.";
  }
  if (error instanceof MeshrApiError) {
    if (error.status === 401) return "That email and password do not match.";
    if (error.status === 409) return "An account already uses that email.";
    if (error.status === 429) return "Too many attempts. Try again shortly.";
    if (error.status >= 500) return "Meshr is unavailable. Try again shortly.";
    if (error.status === 400) {
      return mode === "sign-up"
        ? "Check your name, email, and password."
        : "Enter a valid email and password.";
    }
  }
  return "Something went wrong. Try again.";
}

export function AuthScreen({ pairingCode }: { pairingCode: string | null }) {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      if (mode === "sign-up") {
        await signUp({ displayName, email, password });
      } else {
        await signIn({ email, password });
      }
    } catch (caught) {
      setError(authErrorMessage(caught, mode));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-heading">
        <img className="auth-wordmark" src="/meshr-wordmark.png" alt="meshr" />
        {pairingCode && (
          <div className="pairing-intent">
            <Check size={17} weight="bold" />
            <span>
              <strong>Agent ready to connect</strong>
              <small>Sign in to review {pairingCode}</small>
            </span>
          </div>
        )}
        <div className="auth-tabs" role="tablist" aria-label="Account access">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "sign-in"}
            className={mode === "sign-in" ? "active" : ""}
            onClick={() => switchMode("sign-in")}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "sign-up"}
            className={mode === "sign-up" ? "active" : ""}
            onClick={() => switchMode("sign-up")}
          >
            Create account
          </button>
        </div>
        <header>
          <h1 id="auth-heading">
            {mode === "sign-in" ? "Welcome back" : "Join Meshr"}
          </h1>
          <p>
            {mode === "sign-in"
              ? "Sign in to manage your agents and meshes."
              : "Create an account for your agents and meshes."}
          </p>
        </header>
        <form onSubmit={submit}>
          {mode === "sign-up" && (
            <label>
              Name
              <input
                autoComplete="name"
                autoFocus
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                minLength={1}
                maxLength={80}
                required
              />
            </label>
          )}
          <label>
            Email
            <input
              autoComplete="email"
              autoFocus={mode === "sign-in"}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete={
                mode === "sign-up" ? "new-password" : "current-password"
              }
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={mode === "sign-up" ? 12 : 1}
              maxLength={256}
              required
            />
          </label>
          {error && (
            <p className="auth-error" role="alert">
              <WarningCircle size={17} />
              {error}
            </p>
          )}
          <button className="auth-submit" disabled={submitting}>
            {submitting
              ? mode === "sign-in"
                ? "Signing in…"
                : "Creating account…"
              : mode === "sign-in"
                ? "Sign in"
                : "Create account"}
            {!submitting && <ArrowRight size={17} weight="bold" />}
          </button>
        </form>
      </section>
    </main>
  );
}
