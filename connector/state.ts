import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
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

const MAX_STATE_FILE_BYTES = 5 * 1024 * 1024;
const STATE_LOCK_STALE_AFTER_MS = 30_000;
const STATE_LOCK_HEARTBEAT_MS = 5_000;
const STATE_LOCK_ATTEMPTS = 100;
const STATE_LOCK_RETRY_MS = 50;

type StateLockRecord = {
  owner: string;
  pid: number;
  acquiredAt: string;
};

export type ConnectorAuthoritySnapshot = Pick<
  ConnectorBinding,
  "agentTokenExpiresAt" | "sessionId" | "bindingId" | "agentId"
>;

/** Raised when a retry would overwrite a newer runtime authority. */
export class ConnectorStateConflictError extends Error {
  constructor() {
    super("Meshr session state changed while a runtime successor was pending.");
    this.name = "ConnectorStateConflictError";
  }
}

function sameAuthority(
  binding: ConnectorBinding,
  expected: ConnectorAuthoritySnapshot,
): boolean {
  return (
    binding.agentTokenExpiresAt === expected.agentTokenExpiresAt &&
    binding.sessionId === expected.sessionId &&
    binding.bindingId === expected.bindingId &&
    binding.agentId === expected.agentId
  );
}

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

function assertNativeStatePlatform(): void {
  const environment = process.env.MESHR_ENV?.trim().toLowerCase();
  if (process.platform === "win32" && environment === "production") {
    throw new Error(
      "Meshr native credential storage is not production-supported on Windows until DACL validation is available.",
    );
  }
}

async function assertPrivateStateDirectory(path: string): Promise<void> {
  if (path === "/" || path === homedir()) {
    throw new Error("Meshr session state must be stored in a dedicated directory.");
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Meshr session state directory must be a regular directory.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Meshr session state directory must not be accessible by group or other users.");
  }
  assertNoMacAcl(path);
}

async function assertPrivateStateFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Meshr session state must be a regular file, not a symlink.");
  }
  if (metadata.size > MAX_STATE_FILE_BYTES) {
    throw new Error("Meshr session state is unexpectedly large.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Meshr session state must not be readable by group or other users.");
  }
  assertNoMacAcl(path);
}

function assertNoMacAcl(path: string): void {
  if (process.platform !== "darwin") return;
  const aclError = new Error("Meshr session state must not have an access-control list.");
  try {
    const listing = execFileSync("/bin/ls", ["-lde", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1_000,
    });
    const mode = listing.split(/\r?\n/, 1)[0] ?? "";
    // macOS marks an ACL with '+' in the mode field. Extended attributes use
    // '@' and do not grant access by themselves, so they remain acceptable.
    if (/^[^\s]{10}\+/.test(mode)) throw aclError;
  } catch (error) {
    if (error === aclError) throw error;
    throw new Error("Meshr session state ACL could not be verified safely.");
  }
}

function parseStateLockRecord(value: string): StateLockRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<StateLockRecord>;
    if (
      typeof parsed.owner !== "string" ||
      !parsed.owner ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return undefined;
    }
    return parsed as StateLockRecord;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function reclaimStaleStateLock(path: string): Promise<boolean> {
  let before;
  try {
    before = await stat(path);
  } catch {
    return false;
  }
  if (Date.now() - before.mtimeMs <= STATE_LOCK_STALE_AFTER_MS) return false;

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return false;
  }
  const record = parseStateLockRecord(contents);
  // A lock without our owner record may belong to an older runtime or an
  // interrupted write. Do not evict it automatically: there is no safe way to
  // prove that its owner is gone, so an operator must remove it explicitly.
  if (!record) return false;
  // A live owner may be blocked in a long credential operation even when the
  // mtime is old. Never steal a lock from a process that still exists.
  if (processIsAlive(record.pid)) return false;

  // Recheck the inode metadata after reading the owner record. This closes the
  // common race where the owner heartbeat refreshed the lease while we were
  // inspecting it. PID fencing handles the remaining process-alive case.
  let after;
  try {
    after = await stat(path);
  } catch {
    return true;
  }
  if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function releaseStateLock(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  owner: string,
  heartbeat: ReturnType<typeof setInterval>,
): Promise<void> {
  clearInterval(heartbeat);
  await handle.close().catch(() => undefined);
  try {
    const record = parseStateLockRecord(await readFile(path, "utf8"));
    // If stale recovery installed a replacement owner, leave its lock alone.
    if (record?.owner === owner) await unlink(path);
  } catch {
    // The lock may already have been reclaimed by a successor.
  }
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
    assertNativeStatePlatform();
    this.directory = resolve(directory);
    this.path = join(this.directory, "state.json");
    this.credentialBackend = options.credentialBackend ?? systemBindingCredentialBackend;
    this.useKeychainOverride = options.useKeychain ?? configuredKeychainMode();
  }

  async load(): Promise<ConnectorState> {
    try {
      await assertPrivateStateDirectory(this.directory);
      await assertPrivateStateFile(this.path);
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
    await assertPrivateStateDirectory(this.directory);
    const useKeychain = this.useKeychainOverride ?? this.credentialBackend.supported();
    if (!useKeychain && !fileFallbackWarned) {
      fileFallbackWarned = true;
      warnFileFallback();
    }
    const bindings = [] as Array<Record<string, unknown>>;
    const keychainWrites: Array<{
      credentialRef: string;
      binding: ConnectorBinding;
    }> = [];
    for (const binding of state.bindings) {
      if (!useKeychain) {
        bindings.push(binding as unknown as Record<string, unknown>);
        continue;
      }
      const credentialRef = credentialRefFor(binding);
      const {
        privateKeyPem: _privateKeyPem,
        pairingSecret: _pairingSecret,
        agentToken: _agentToken,
        ...publicBinding
      } = binding;
      bindings.push({ ...publicBinding, credentialRef });
      keychainWrites.push({ credentialRef, binding });
    }
    const serialized = `${JSON.stringify({ ...state, bindings }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_FILE_BYTES) {
      throw new Error("Meshr session state is unexpectedly large.");
    }
    const previous = useKeychain ? await this.readPersistedCredentialRefs() : new Set<string>();
    for (const { credentialRef, binding } of keychainWrites) {
      await this.credentialBackend.save(credentialRef, {
        privateKeyPem: binding.privateKeyPem,
        pairingSecret: binding.pairingSecret,
        ...(binding.agentToken ? { agentToken: binding.agentToken } : {}),
      });
    }
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await assertPrivateStateFile(temporary);
      await rename(temporary, this.path);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }

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
      await assertPrivateStateFile(this.path);
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as ConnectorState;
      return new Set(
        (parsed.bindings ?? [])
          .map((binding) => (binding as ConnectorBinding & { credentialRef?: unknown }).credentialRef)
          .filter((ref): ref is string => typeof ref === "string"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw error;
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
    options: {
      expectedAuthorities?: readonly ConnectorAuthoritySnapshot[];
    } = {},
  ): Promise<ConnectorBinding> {
    return this.withFileLock(async () => {
      const binding = await this.require(selector);
      if (
        options.expectedAuthorities &&
        !options.expectedAuthorities.some((expected) => sameAuthority(binding, expected))
      ) {
        throw new ConnectorStateConflictError();
      }
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

  /** Check the current binding before a retry without mutating session state. */
  async assertAuthority(
    selector: string,
    expectedAuthorities: readonly ConnectorAuthoritySnapshot[],
  ): Promise<void> {
    await this.withFileLock(async () => {
      const binding = await this.require(selector);
      if (!expectedAuthorities.some((expected) => sameAuthority(binding, expected))) {
        throw new ConnectorStateConflictError();
      }
    });
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Validate the directory before opening a lock or touching any state. An
    // attacker must not be able to swap the configured path for a symlink
    // between the recursive mkdir and the first filesystem operation.
    await assertPrivateStateDirectory(this.directory);
    const lockPath = `${this.path}.lock`;
    const owner = randomUUID();
    const lockRecord = `${JSON.stringify({
      owner,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    } satisfies StateLockRecord)}\n`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < STATE_LOCK_ATTEMPTS; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(lockRecord, { encoding: "utf8" });
        await handle.sync();
        await handle.chmod(0o600);
        break;
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => undefined);
          handle = undefined;
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await reclaimStaleStateLock(lockPath);
        await new Promise((resolve) => setTimeout(resolve, STATE_LOCK_RETRY_MS));
      }
    }
    if (!handle) throw new Error("session_state_locked");
    const heartbeat = setInterval(() => {
      void handle?.utimes(new Date(), new Date()).catch(() => undefined);
    }, STATE_LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await operation();
    } finally {
      await releaseStateLock(handle, lockPath, owner, heartbeat);
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
