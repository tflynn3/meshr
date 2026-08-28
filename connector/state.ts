import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  CONNECTOR_STATE_VERSION,
  type ConnectorBinding,
  type ConnectorState,
} from "./types";

const emptyState = (): ConnectorState => ({
  version: CONNECTOR_STATE_VERSION,
  bindings: [],
});

const viableStatuses = new Set<ConnectorBinding["status"]>([
  "pending",
  "approved",
  "connected",
]);

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
      `Connector state is ambiguous: ${bindings.length} bindings use ${label} ${selector}. Repair state.json before continuing.`,
    );
  }
  return bindings[0];
}

export function defaultStateDirectory(): string {
  const override = process.env.MESHR_STATE_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".meshr", "session");
}

export class ConnectorStateStore {
  readonly directory: string;
  readonly path: string;

  constructor(directory = defaultStateDirectory()) {
    this.directory = resolve(directory);
    this.path = join(this.directory, "state.json");
  }

  async load(): Promise<ConnectorState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as ConnectorState;
      if (parsed.version !== CONNECTOR_STATE_VERSION || !Array.isArray(parsed.bindings)) {
        throw new Error("Unsupported connector state format.");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async save(state: ConnectorState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }

  async upsert(binding: ConnectorBinding): Promise<ConnectorBinding> {
    const state = await this.load();
    const index = state.bindings.findIndex(
      (candidate) => candidate.pairingId === binding.pairingId,
    );
    if (index === -1) state.bindings.push(binding);
    else state.bindings[index] = binding;
    await this.save(state);
    return binding;
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
    const binding = await this.require(selector);
    return this.upsert({
      ...binding,
      ...update,
      updatedAt: new Date().toISOString(),
    });
  }
}

export function assertPrivateStatePath(path: string): void {
  if (path === "/" || path === homedir()) {
    throw new Error("Refusing to use a broad directory for connector state.");
  }
  if (dirname(path) === path) {
    throw new Error("Connector state must be stored in a dedicated directory.");
  }
}
