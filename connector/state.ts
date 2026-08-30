import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  CONNECTOR_STATE_VERSION,
  type ConnectorBinding,
  type ConnectorState,
} from "./types";
import {
  credentialRefFor,
  type BindingCredentialBackend,
  systemBindingCredentialBackend,
  warnFileFallback,
} from "./credentials";

const emptyState = (): ConnectorState => ({
  version: CONNECTOR_STATE_VERSION,
  bindings: [],
});

const viableStatuses = new Set<ConnectorBinding["status"]>([
  "pending",
  "approved",
  "connected",
]);

let fileFallbackWarned = false;

function newestBinding(bindings: ConnectorBinding[]): ConnectorBinding {
  return [...bindings].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.pairingId.localeCompare(left.pairingId),
  )[0]!;
}

function uniqueExactMatch(
  bindings: ConnectorBinding[],
  selector: string,
  label: "pairing ID" | "binding ID",
): ConnectorBinding | undefined {
  if (bindings.length > 1) {
    throw new Error(
      `Meshr session state is ambiguous: ${bindings.length} bindings use ${label} ${selector}. Repair state.json before continuing.`,
    );
  }
  return bindings[0];
}

export function defaultStateDirectory(): string {
  const override = process.env.MESHR_STATE_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".meshr", "session");
}

function configuredKeychainMode(): boolean | undefined {
  const value = process.env.MESHR_CREDENTIAL_STORAGE?.trim().toLowerCase();
  if (!value || value === "auto") return undefined;
  if (value === "file") return false;
  if (value === "keychain") return true;
  throw new Error("MESHR_CREDENTIAL_STORAGE must be auto, keychain, or file.");
}

export class ConnectorStateStore {
  readonly directory: string;
  readonly path: string;
  private readonly credentialBackend: BindingCredentialBackend;
  private readonly useKeychainOverride: boolean | undefined;

  constructor(
    directory = defaultStateDirectory(),
    options: {
      credentialBackend?: BindingCredentialBackend;
      useKeychain?: boolean;
    } = {},
  ) {
    this.directory = resolve(directory);
    this.path = join(this.directory, "state.json");
    this.credentialBackend = options.credentialBackend ?? systemBindingCredentialBackend;
    this.useKeychainOverride = options.useKeychain ?? configuredKeychainMode();
  }

  async load(): Promise<ConnectorState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as ConnectorState;
      if (parsed.version !== CONNECTOR_STATE_VERSION || !Array.isArray(parsed.bindings)) {
        throw new Error("Unsupported Meshr session state format.");
      }
      const bindings = await Promise.all(parsed.bindings.map(async (binding) => {
        const hasPrivateKey = typeof binding.privateKeyPem === "string" && binding.privateKeyPem.length > 0;
        const hasPairingSecret = typeof binding.pairingSecret === "string" && binding.pairingSecret.length > 0;
        const hasToken = typeof binding.agentToken === "string" && binding.agentToken.length > 0;
        if (!binding.credentialRef || (hasPrivateKey && hasPairingSecret && (!binding.agentToken || hasToken))) {
          return binding;
        }
        const credentials = await this.credentialBackend.load(binding.credentialRef);
        return {
          ...binding,
          privateKeyPem: credentials.privateKeyPem,
          pairingSecret: credentials.pairingSecret,
          ...(credentials.agentToken ? { agentToken: credentials.agentToken } : {}),
        };
      }));
      return { ...parsed, bindings };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async save(state: ConnectorState): Promise<void> {
    await this.withFileLock(() => this.saveUnlocked(state));
  }

  private async saveUnlocked(state: ConnectorState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const useKeychain = this.useKeychainOverride ?? this.credentialBackend.supported();
    if (!useKeychain && !fileFallbackWarned) {
      fileFallbackWarned = true;
      warnFileFallback();
    }
    const bindings = [] as Array<Record<string, unknown>>;
    for (const binding of state.bindings) {
      if (!useKeychain) {
        bindings.push(binding as unknown as Record<string, unknown>);
        continue;
      }
      const credentialRef = credentialRefFor(binding);
      await this.credentialBackend.save(credentialRef, {
        privateKeyPem: binding.privateKeyPem,
        pairingSecret: binding.pairingSecret,
        ...(binding.agentToken ? { agentToken: binding.agentToken } : {}),
      });
      const {
        privateKeyPem: _privateKeyPem,
        pairingSecret: _pairingSecret,
        agentToken: _agentToken,
        ...publicBinding
      } = binding;
      bindings.push({ ...publicBinding, credentialRef });
    }
    const temporary = `${this.path}.${process.pid}.tmp`;
    const previous = useKeychain ? await this.readPersistedCredentialRefs() : new Set<string>();
    await writeFile(temporary, `${JSON.stringify({ ...state, bindings }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.path);

    if (useKeychain && this.credentialBackend.remove) {
      const retained = new Set(
        bindings
          .map((binding) => binding.credentialRef)
          .filter((ref): ref is string => typeof ref === "string"),
      );
      await Promise.all(
        [...previous]
          .filter((ref) => !retained.has(ref))
          .map(async (ref) => {
            try {
              await this.credentialBackend.remove!(ref);
            } catch {
              // Orphan cleanup is best-effort; the state write itself is
              // already durable and a later save can retry removal.
            }
          }),
      );
    }
  }

  private async readPersistedCredentialRefs(): Promise<Set<string>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as ConnectorState;
      return new Set(
        (parsed.bindings ?? [])
          .map((binding) => (binding as ConnectorBinding & { credentialRef?: unknown }).credentialRef)
          .filter((ref): ref is string => typeof ref === "string"),
      );
    } catch {
      return new Set();
    }
  }

  async upsert(binding: ConnectorBinding): Promise<ConnectorBinding> {
    return this.withFileLock(async () => {
      const state = await this.load();
      const index = state.bindings.findIndex(
        (candidate) => candidate.pairingId === binding.pairingId,
      );
      if (index === -1) state.bindings.push(binding);
      else state.bindings[index] = binding;
      await this.saveUnlocked(state);
      return binding;
    });
  }

  async require(selector: string): Promise<ConnectorBinding> {
    const state = await this.load();
    const pairingMatch = uniqueExactMatch(
      state.bindings.filter((candidate) => candidate.pairingId === selector),
      selector,
      "pairing ID",
    );
    if (pairingMatch) return pairingMatch;

    const bindingMatch = uniqueExactMatch(
      state.bindings.filter((candidate) => candidate.bindingId === selector),
      selector,
      "binding ID",
    );
    if (bindingMatch) return bindingMatch;

    const handleMatches = state.bindings.filter(
      (candidate) => candidate.requestedProfile.handle === selector,
    );
    if (!handleMatches.length) {
      throw new Error(`No Meshr binding matches ${selector}.`);
    }

    // Handles are convenient aliases and can legitimately have retries. Prefer
    // the newest non-terminal attempt; exact IDs above remain stable access to
    // any older or terminal attempt. If all attempts are terminal, return the
    // newest one so status and error reporting describe the latest attempt.
    const viableMatches = handleMatches.filter((candidate) =>
      viableStatuses.has(candidate.status),
    );
    return newestBinding(viableMatches.length ? viableMatches : handleMatches);
  }

  async patch(
    selector: string,
    update: Partial<ConnectorBinding>,
  ): Promise<ConnectorBinding> {
    return this.withFileLock(async () => {
      const binding = await this.require(selector);
      const next = {
        ...binding,
        ...update,
        updatedAt: new Date().toISOString(),
      };
      const state = await this.load();
      const index = state.bindings.findIndex((candidate) => candidate.pairingId === binding.pairingId);
      if (index === -1) throw new Error(`No Meshr binding matches ${selector}.`);
      state.bindings[index] = next;
      await this.saveUnlocked(state);
      return next;
    });
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > 30_000) await unlink(lockPath);
        } catch {
          // The owner may have released the lock between stat and unlink.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!handle) throw new Error("session_state_locked");
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

export function assertPrivateStatePath(path: string): void {
  if (path === "/" || path === homedir()) {
    throw new Error("Refusing to use a broad directory for Meshr session state.");
  }
  if (dirname(path) === path) {
    throw new Error("Meshr session state must be stored in a dedicated directory.");
  }
}
