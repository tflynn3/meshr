import { spawn } from "node:child_process";
import type { ProcessEvidence } from "./types.ts";

const MAX_CAPTURE_CHARACTERS = 256_000;
const FORCE_KILL_GRACE_MS = 1_000;

function signalProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      // POSIX detached children lead their own process group. Signal the
      // negative PID so model-launched descendants cannot outlive a timeout.
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

/**
 * Native hosts receive only their explicit session configuration. In
 * particular, never pass Meshr release/CI variables (which can contain
 * pairing secrets, tokens, or provider credentials) through the host's
 * inherited environment.
 */
export function nativeHostEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => {
      const normalized = name.toUpperCase();
      return (
        !normalized.startsWith("MESHR_") &&
        !normalized.startsWith("MCP_") &&
        ![
          "MESHR",
          "MCP",
          "GITHUB_TOKEN",
          "ACTIONS_RUNTIME_TOKEN",
          "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
          "CLOUDSDK_AUTH_ACCESS_TOKEN",
          "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
          "GOOGLE_APPLICATION_CREDENTIALS",
          "GOOGLE_GHA_CREDS_PATH",
          "NPM_TOKEN",
          "NODE_AUTH_TOKEN",
        ].includes(normalized)
      );
    }),
  );
}

function appendBounded(
  current: string,
  chunk: Buffer | string,
): { value: string; truncated: boolean } {
  const next = current + chunk.toString();
  if (next.length <= MAX_CAPTURE_CHARACTERS) {
    return { value: next, truncated: false };
  }
  return {
    value: next.slice(next.length - MAX_CAPTURE_CHARACTERS),
    truncated: true,
  };
}

export async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ProcessEvidence> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let stdout = "";
  let stderr = "";
  let outputTruncated = false;
  let timedOut = false;

  return new Promise((resolve) => {
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timedOutClose:
      | { exitCode: number | null; signal: NodeJS.Signals | null }
      | undefined;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: nativeHostEnvironment(input.env ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk);
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk);
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
    });

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      error?: string,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        kind: "process",
        command: input.command,
        args: [...input.args],
        startedAt,
        elapsedMs: Math.round(performance.now() - start),
        exitCode,
        signal,
        timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        outputTruncated,
        ...(error ? { error } : {}),
      });
    };

    child.once("error", (error) => finish(null, null, error.message));
    child.once("close", (exitCode, signal) => {
      if (timedOut && forceKillTimer) {
        timedOutClose = { exitCode, signal };
        return;
      }
      // A CLI can exit after detaching a helper with closed stdio. No model
      // attempt owns background work beyond its terminal result.
      if (!timedOut) signalProcessTree(child, "SIGKILL");
      finish(exitCode, signal);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        signalProcessTree(child, "SIGKILL");
        if (timedOutClose) {
          finish(timedOutClose.exitCode, timedOutClose.signal);
        }
      }, FORCE_KILL_GRACE_MS);
    }, input.timeoutMs);
    timeout.unref();
  });
}

export async function readVersion(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<import("./types.ts").VersionEvidence> {
  const execution = await runProcess({
    command: input.command,
    args: ["--version"],
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
  });
  const installed = execution.exitCode === 0 && !execution.timedOut;
  return {
    installed,
    ...(installed
      ? {
          version:
            execution.stdout || execution.stderr || "version unavailable",
        }
      : {}),
    execution,
  };
}
