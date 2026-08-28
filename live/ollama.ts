import type { HttpEvidence } from "./types.ts";

const MAX_RESPONSE_EXCERPT = 32_000;

export function assertLoopbackOllamaUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(hostname)
  ) {
    throw new Error("Ollama URL must be an http loopback address.");
  }
  return url.toString().replace(/\/$/, "");
}

export function parseOllamaBody(content: string, marker: string): string {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Ollama response must be a JSON object.");
  }
  const body = (parsed as Record<string, unknown>).body;
  if (typeof body !== "string" || !body.trim() || body.length > 1_200) {
    throw new Error("Ollama response body must contain 1 to 1200 characters.");
  }
  if (!body.includes(marker)) {
    throw new Error(`Ollama response omitted required marker ${marker}.`);
  }
  return body.trim();
}

export async function invokeOllama(input: {
  baseUrl: string;
  model: string;
  prompt: string;
  marker: string;
  timeoutMs: number;
}): Promise<{ execution: HttpEvidence; body?: string }> {
  const baseUrl = assertLoopbackOllamaUrl(input.baseUrl);
  const url = `${baseUrl}/api/generate`;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let status: number | undefined;
  let excerpt = "";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    status = response.status;
    const raw = await response.text();
    excerpt = raw.slice(0, MAX_RESPONSE_EXCERPT);
    if (!response.ok)
      throw new Error(`Ollama returned HTTP ${response.status}.`);
    const envelope = JSON.parse(raw) as {
      response?: unknown;
      error?: unknown;
    };
    if (typeof envelope.response !== "string") {
      throw new Error(
        typeof envelope.error === "string"
          ? envelope.error
          : "Ollama response is missing generated text.",
      );
    }
    const body = parseOllamaBody(envelope.response, input.marker);
    return {
      body,
      execution: {
        kind: "http",
        url,
        startedAt,
        elapsedMs: Math.round(performance.now() - start),
        exitCode: 0,
        httpStatus: status,
        timedOut: false,
        responseExcerpt: excerpt,
      },
    };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      execution: {
        kind: "http",
        url,
        startedAt,
        elapsedMs: Math.round(performance.now() - start),
        exitCode: 1,
        ...(status !== undefined ? { httpStatus: status } : {}),
        timedOut,
        ...(excerpt ? { responseExcerpt: excerpt } : {}),
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
