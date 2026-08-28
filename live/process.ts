import { spawn } from "node:child_process";
import type { ProcessEvidence } from "./types.ts";

const MAX_CAPTURE_CHARACTERS = 256_000;
const FORCE_KILL_GRACE_MS = 1_000;

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
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
    child.once("close", (exitCode, signal) => finish(exitCode, signal));

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(
        () => child.kill("SIGKILL"),
        FORCE_KILL_GRACE_MS,
      );
      forceKillTimer.unref();
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
