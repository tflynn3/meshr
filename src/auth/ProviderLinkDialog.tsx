import { GithubLogo, GoogleLogo, LinkSimple, X } from "@phosphor-icons/react";
import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
} from "firebase/auth";
import { useEffect, useState } from "react";
import {
  getAuthConfig,
  getLinkedProviders,
  linkSocialProvider,
  type LinkedProvider,
} from "./api";
import { socialAuthProof, socialAuthProvider } from "./socialAuthProvider";

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

export function ProviderLinkDialog({
  csrfToken,
  onClose,
  onSaved,
}: {
  csrfToken: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [providers, setProviders] = useState<LinkedProvider[]>([]);
  const [firebaseConfig, setFirebaseConfig] = useState<{
    apiKey: string;
    authDomain: string;
    projectId: string;
  } | null>(null);
  const [busy, setBusy] = useState<"google" | "github" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([getLinkedProviders(), getAuthConfig()])
      .then(([linked, config]) => {
        if (!active) return;
        setProviders(linked.providers);
        setFirebaseConfig(config.firebase ?? null);
      })
      .catch(() => {
        if (active) setError("Could not load linked providers.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function link(provider: "google" | "github") {
    if (busy) return;
    setBusy(provider);
    setError("");
    try {
      if (!firebaseConfig) throw new Error("Social sign-in is not configured yet.");
      const existing = providers[0]?.provider;
      if (!existing) {
        throw new Error("Sign in with an existing provider before linking another one.");
      }
      if (existing === provider) {
        throw new Error("Choose the provider that is not already linked.");
      }
      const auth = authForFirebase(firebaseConfig);
      const tokenFor = async (selected: "google" | "github") => {
        const oauthProvider = socialAuthProvider(selected);
        try {
          const result = await signInWithPopup(auth, oauthProvider);
          return await socialAuthProof(selected, result);
        } finally {
          await firebaseSignOut(auth).catch(() => undefined);
        }
      };
      // Linking is a two-key operation: prove the identity already attached
      // to this account, then prove the new provider. The server also checks
      // both subjects transactionally before writing the link.
      const currentProof = await tokenFor(existing);
      const proof = await tokenFor(provider);
      const linked = await linkSocialProvider({
        provider,
        ...proof,
        currentProvider: existing,
        currentIdToken: currentProof.idToken,
        currentProviderAccessToken: currentProof.providerAccessToken,
        csrfToken,
      });
      setProviders((current) => [
        ...current.filter((item) => item.provider !== provider),
        linked.identity,
      ].sort((left, right) => left.provider.localeCompare(right.provider)));
      onSaved?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not link provider.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-dialog-title">
        <header>
          <div>
            <p>ACCOUNT ACCESS</p>
            <h2 id="provider-dialog-title">Linked providers</h2>
          </div>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        <p className="account-dialog-copy">
          Link a second sign-in method so you can get back to this account from either provider.
          You’ll authenticate with the provider before it is attached.
        </p>
        <div className="linked-provider-list">
          {(["google", "github"] as const).map((provider) => {
            const linked = providers.find((item) => item.provider === provider);
            const Icon = provider === "google" ? GoogleLogo : GithubLogo;
            return (
              <div className="linked-provider" key={provider}>
                <span className="linked-provider-icon"><Icon size={21} weight="fill" /></span>
                <div>
                  <strong>{provider === "google" ? "Google" : "GitHub"}</strong>
                  <small>{linked ? linked.email : "Not linked"}</small>
                </div>
                {linked ? (
                  <span className="linked-provider-state">Linked</span>
                ) : (
                  <button className="secondary" onClick={() => void link(provider)} disabled={busy !== null}>
                    {busy === provider ? "Linking…" : <><LinkSimple size={15} /> Link</>}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <footer>
          <button className="secondary" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
