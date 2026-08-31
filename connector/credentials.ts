import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ConnectorBinding } from "./types";

const execFileAsync = promisify(execFile);
const KEYCHAIN_ACCOUNT = "meshr";
const KEYCHAIN_COMMAND_TIMEOUT_MS = 10_000;

export interface BindingCredentials {
  privateKeyPem: string;
  pairingSecret: string;
  agentToken?: string;
}

export interface BindingCredentialBackend {
  supported(): boolean;
  save(ref: string, credentials: BindingCredentials): Promise<void>;
  load(ref: string): Promise<BindingCredentials>;
  remove?(ref: string): Promise<void>;
}

export function credentialRefFor(binding: Pick<ConnectorBinding, "pairingId">): string {
  return `pairing:${binding.pairingId}`;
}

function serviceName(ref: string): string {
  return `Meshr/${ref}`;
}

const chunkServiceName = (ref: string, field: string, index: number): string =>
  `${serviceName(ref)}/${field}/${index}`;
const KEYCHAIN_CHUNK_SIZE = 100;

type KeychainManifest = {
  version: 1;
  fields: { privateKeyPem: number; pairingSecret: number; agentToken: number };
};

export function osKeychainSupported(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("security", ["help"], {
      stdio: "ignore",
      timeout: KEYCHAIN_COMMAND_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function saveBindingCredentials(
  ref: string,
  credentials: BindingCredentials,
): Promise<void> {
  if (!osKeychainSupported()) throw new Error("os_keychain_unavailable");
  const fields = {
    privateKeyPem: encodeChunks(credentials.privateKeyPem),
    pairingSecret: encodeChunks(credentials.pairingSecret),
    agentToken: encodeChunks(credentials.agentToken ?? ""),
  };
  const manifest: KeychainManifest = {
    version: 1,
    fields: {
      privateKeyPem: fields.privateKeyPem.length,
      pairingSecret: fields.pairingSecret.length,
      agentToken: fields.agentToken.length,
    },
  };
  await runSecurityPrompt(
    [
      "add-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      serviceName(ref),
      "-U",
      "-w",
    ],
    JSON.stringify(manifest),
  );
  for (const [field, chunks] of Object.entries(fields)) {
    for (const [index, chunk] of chunks.entries()) {
      await runSecurityPrompt(
        [
          "add-generic-password",
          "-a",
          KEYCHAIN_ACCOUNT,
          "-s",
          chunkServiceName(ref, field, index),
          "-U",
          "-w",
        ],
        chunk,
      );
    }
  }
}

export async function loadBindingCredentials(ref: string): Promise<BindingCredentials> {
  if (!osKeychainSupported()) throw new Error("os_keychain_unavailable");
  let manifest: KeychainManifest;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readSecurityValue(serviceName(ref)));
  } catch {
    throw new Error("os_keychain_corrupt");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("os_keychain_corrupt");
  }
  const value = parsed as Partial<KeychainManifest>;
  const fieldCounts = value.fields;
  if (
    value.version !== 1 ||
    !fieldCounts ||
    !Number.isInteger(fieldCounts.privateKeyPem) || fieldCounts.privateKeyPem < 1 || fieldCounts.privateKeyPem > 128 ||
    !Number.isInteger(fieldCounts.pairingSecret) || fieldCounts.pairingSecret < 1 || fieldCounts.pairingSecret > 128 ||
    !Number.isInteger(fieldCounts.agentToken) || fieldCounts.agentToken < 0 || fieldCounts.agentToken > 128
  ) {
    throw new Error("os_keychain_corrupt");
  }
  manifest = value as KeychainManifest;
  try {
    const privateKeyPem = decodeChunks(
      await readSecurityChunks(ref, "privateKeyPem", manifest.fields.privateKeyPem),
    );
    const pairingSecret = decodeChunks(
      await readSecurityChunks(ref, "pairingSecret", manifest.fields.pairingSecret),
    );
    const agentToken = manifest.fields.agentToken
      ? decodeChunks(await readSecurityChunks(ref, "agentToken", manifest.fields.agentToken))
      : "";
    return {
      privateKeyPem,
      pairingSecret,
      ...(agentToken ? { agentToken } : {}),
    };
  } catch {
    throw new Error("os_keychain_corrupt");
  }
}

export async function deleteBindingCredentials(ref: string): Promise<void> {
  if (!osKeychainSupported()) throw new Error("os_keychain_unavailable");
  let manifest: KeychainManifest | undefined;
  try {
    const parsed = JSON.parse(await readSecurityValue(serviceName(ref))) as Partial<KeychainManifest>;
    if (parsed.version === 1 && parsed.fields) manifest = parsed as KeychainManifest;
  } catch {
    // Continue deleting the manifest; a partially written item is not useful.
  }
  if (manifest) {
    for (const [field, count] of Object.entries(manifest.fields)) {
      for (let index = 0; index < count; index += 1) {
        await deleteSecurityItem(chunkServiceName(ref, field, index));
      }
    }
  }
  await deleteSecurityItem(serviceName(ref));
}

async function deleteSecurityItem(service: string): Promise<void> {
  try {
    await execFileAsync(
      "security",
      [
        "delete-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        service,
      ],
      { timeout: KEYCHAIN_COMMAND_TIMEOUT_MS },
    );
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "44") return;
    throw new Error("os_keychain_delete_failed");
  }
}

function encodeChunks(value: string): string[] {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += KEYCHAIN_CHUNK_SIZE) {
    chunks.push(encoded.slice(offset, offset + KEYCHAIN_CHUNK_SIZE));
  }
  return chunks;
}

function decodeChunks(chunks: string[]): string {
  return Buffer.from(chunks.join(""), "base64").toString("utf8");
}

async function readSecurityValue(service: string): Promise<string> {
  const result = await execFileAsync(
    "security",
    [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      service,
      "-w",
    ],
    { timeout: KEYCHAIN_COMMAND_TIMEOUT_MS },
  );
  return String(result.stdout).trim();
}

async function readSecurityChunks(ref: string, field: string, count: number): Promise<string[]> {
  const chunks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = await readSecurityValue(chunkServiceName(ref, field, index));
    if (!/^[A-Za-z0-9+/=]+$/.test(chunk) || chunk.length > KEYCHAIN_CHUNK_SIZE) {
      throw new Error("invalid_keychain_chunk");
    }
    chunks.push(chunk);
  }
  return chunks;
}

async function runSecurityPrompt(args: string[], secret: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("security", args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
    }, KEYCHAIN_COMMAND_TIMEOUT_MS);
    timeout.unref();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(new Error("os_keychain_write_failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (code === 0) {
        resolve();
        return;
      }
      // Never include security's stderr: it can echo command context and is
      // not needed by callers. The secret is supplied through stdin rather
      // than argv so process listings cannot expose it.
      void stderr;
      reject(new Error("os_keychain_write_failed"));
    });
    // `security` prompts for the value twice when stdin is non-interactive.
    // Supplying both copies keeps the payload off argv while satisfying that
    // confirmation prompt.
    child.stdin.end(secret + "\n" + secret + "\n");
  });
}

export const systemBindingCredentialBackend: BindingCredentialBackend = {
  supported: osKeychainSupported,
  save: saveBindingCredentials,
  load: loadBindingCredentials,
  remove: deleteBindingCredentials,
};

export function warnFileFallback(): void {
  const platformWarning = process.platform === "win32"
    ? " Windows ACLs are not verified; do not use this fallback for production."
    : "";
  process.stderr.write(
    `[meshr] OS keychain unavailable; runtime credentials remain in a mode-0600 state file. Use a supported keychain before production.${platformWarning}\n`,
  );
}
