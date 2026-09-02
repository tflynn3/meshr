import { ArrowRight, Check, WarningCircle } from "@phosphor-icons/react";
import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
} from "firebase/auth";
import { useEffect, useState, type FormEvent } from "react";
import { ResidentCohortLink } from "../about/ResidentCohortLink";
import {
  createSocialAuthState,
  getAuthConfig,
  MeshrApiError,
  MeshrUnavailableError,
} from "./api";
import { useAuth } from "./AuthContext";
import { socialAuthProof, socialAuthProvider } from "./socialAuthProvider";

type AuthMode = "sign-in" | "sign-up";

let firebaseAuth: Auth | null = null;

function authForFirebase(config: {
  apiKey: string;
  authDomain: string;
  projectId: string;
}): Auth {
  if (firebaseAuth) return firebaseAuth;
  const app: FirebaseApp = getApps()[0] ?? initializeApp(config);
  firebaseAuth = getAuth(app);
  return firebaseAuth;
}

function authErrorMessage(error: unknown, mode: AuthMode): string {
  if (error instanceof MeshrUnavailableError) {
    return "Meshr is unavailable. Check the connection and try again.";
  }
  if (error instanceof MeshrApiError) {
    if (error.code === "social_auth_unconfigured") {
      return "Google and GitHub sign-in are not configured on this local server. Use email below.";
    }
    if (error.status === 401) return "That email and password do not match.";
    if (error.code === "identity_link_required") {
      return "This identity is already registered. Sign in with its original provider, then link this provider from account settings.";
    }
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

export function AuthScreen({
  pairingCode,
  socialError,
}: {
  pairingCode: string | null;
  socialError?: string;
}) {
  const { signIn, signInWithSocial, signUp } = useAuth();
  const [socialAuthOnly, setSocialAuthOnly] = useState(
    import.meta.env.VITE_SOCIAL_AUTH_ONLY === "1",
  );
  const [firebaseConfig, setFirebaseConfig] = useState<{
    apiKey: string;
    authDomain: string;
    projectId: string;
  } | null>(null);
  const [residentDisclosure, setResidentDisclosure] = useState<{
    text: string;
    url: string;
  } | null>(null);
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void getAuthConfig()
      .then((config) => {
        if (active) {
          setSocialAuthOnly(config.socialOnly);
          setFirebaseConfig(config.firebase ?? null);
          setResidentDisclosure(config.residentCohortDisclosure ?? null);
        }
      })
      .catch(() => {
        // Keep the build-time default if the public config endpoint is unavailable.
      });
    return () => {
      active = false;
    };
  }, []);

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError("");
  }

  async function startSocial(provider: "google" | "github") {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      if (!firebaseConfig) {
        throw new MeshrApiError(
          503,
          "social_auth_unconfigured",
          "Social sign in is not configured yet. Try again shortly.",
        );
      }
      const state = await createSocialAuthState();
      const auth = authForFirebase(firebaseConfig);
      const oauthProvider = socialAuthProvider(provider);
      // The server-bound state cookie prevents login CSRF while Firebase
      // handles provider state, PKCE, and Identity Platform token exchange in
      // the browser. Do not pass our server state as an OAuth provider
      // parameter: Firebase owns that parameter and validates its own value.
      const result = await signInWithPopup(auth, oauthProvider);
      const proof = await socialAuthProof(provider, result);
      await signInWithSocial({ provider, ...proof, state: state.state });
      await firebaseSignOut(auth);
      window.location.reload();
    } catch (caught) {
      setError(authErrorMessage(caught, mode));
    } finally {
      setSubmitting(false);
    }
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
        <div className="social-auth-actions" aria-label="Social sign in">
          <button type="button" className="social-auth-button" onClick={() => void startSocial("google")} disabled={submitting}>
            Continue with Google
          </button>
          <button type="button" className="social-auth-button" onClick={() => void startSocial("github")} disabled={submitting}>
            Continue with GitHub
          </button>
        </div>
        {socialError && <p className="auth-error" role="alert">{socialError}</p>}
        {!socialAuthOnly && <p className="auth-divider"><span>or use email</span></p>}
        {!socialAuthOnly && <div className="auth-tabs" role="tablist" aria-label="Account access">
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
        </div>}
        <header>
          <h1 id="auth-heading">
            {socialAuthOnly ? "Enter Meshr" : mode === "sign-in" ? "Welcome back" : "Join Meshr"}
          </h1>
          <p>
            {socialAuthOnly
              ? "Sign in to observe and govern your agents and meshes."
              : mode === "sign-in"
              ? "Sign in to manage your agents and meshes."
              : "Create an account for your agents and meshes."}
          </p>
        </header>
        {!socialAuthOnly && <form onSubmit={submit}>
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
        </form>}
        {residentDisclosure && (
          <p className="resident-cohort-disclosure" id="resident-agent-disclosure">
            {residentDisclosure.text}{" "}
            <ResidentCohortLink
              href={residentDisclosure.url}
              label="How the resident cohort works"
            />
          </p>
        )}
      </section>
    </main>
  );
}
