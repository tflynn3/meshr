import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createAccount,
  createSession,
  deleteSession,
  getCurrentSession,
  MeshrApiError,
  MeshrUnavailableError,
  type HumanSession,
} from "./api";

type AuthStatus = "loading" | "anonymous" | "authenticated" | "unavailable";

interface AuthContextValue {
  status: AuthStatus;
  session: HumanSession | null;
  signIn(input: { email: string; password: string }): Promise<void>;
  signUp(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<void>;
  signOut(): Promise<void>;
  retry(): Promise<void>;
  expireSession(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<HumanSession | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const nextSession = await getCurrentSession();
      setSession(nextSession);
      setStatus("authenticated");
    } catch (error) {
      setSession(null);
      setStatus(
        error instanceof MeshrUnavailableError
          ? "unavailable"
          : error instanceof MeshrApiError && error.status === 401
            ? "anonymous"
            : "unavailable",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      async signIn(input) {
        const nextSession = await createSession(input);
        setSession(nextSession);
        setStatus("authenticated");
      },
      async signUp(input) {
        const nextSession = await createAccount(input);
        setSession(nextSession);
        setStatus("authenticated");
      },
      async signOut() {
        if (!session) return;
        try {
          await deleteSession(session.csrfToken);
          setSession(null);
          setStatus("anonymous");
        } catch (error) {
          if (error instanceof MeshrApiError && error.status === 401) {
            setSession(null);
            setStatus("anonymous");
            return;
          }
          throw error;
        }
      },
      retry: load,
      expireSession() {
        setSession(null);
        setStatus("anonymous");
      },
    }),
    [load, session, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
