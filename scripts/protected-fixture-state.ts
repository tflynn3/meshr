#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENVELOPE_VERSION = 1 as const;
const ALGORITHM = "aes-256-gcm" as const;
// Keep the encrypted fixture comfortably below Firestore's 1 MiB document
// limit after AES-GCM overhead, JSON, base64 encoding, and metadata. The
// envelope store applies the same 512 KiB bound to the encoded artifact; a
// 384 KiB plaintext ceiling leaves enough margin for that expansion.
const MAX_STATE_BYTES = 384 * 1024;

type Envelope = {
  version: typeof ENVELOPE_VERSION;
  algorithm: typeof ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
};

function valueAfter(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index === -1 ? undefined : values[index + 1];
}

function usage(): string {
  return [
    "Usage: npm run protected:state -- <encrypt|decrypt> --input <path> --output <path>",
    "",
    "Encrypts or decrypts a protected runtime fixture with AES-256-GCM.",
    "The key is read from MESHR_PROTECTED_STATE_KEY as base64 or hex; it is never written to the artifact.",
  ].join("\n");
}

function keyFromEnvironment(): Buffer {
  const encoded = process.env.MESHR_PROTECTED_STATE_KEY?.trim();
  if (!encoded) throw new Error("MESHR_PROTECTED_STATE_KEY is required.");
  const base64 = Buffer.from(encoded, "base64");
  if (base64.length === 32 && base64.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "")) {
    return base64;
  }
  const hex = Buffer.from(encoded, "hex");
  if (hex.length === 32 && /^[0-9a-fA-F]{64}$/.test(encoded)) return hex;
  throw new Error("MESHR_PROTECTED_STATE_KEY must encode exactly 32 bytes as base64 or 64 hex characters.");
}

function parseEnvelope(value: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Protected fixture artifact is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Protected fixture artifact has an invalid envelope.");
  }
  const envelope = parsed as Partial<Envelope>;
  if (
    envelope.version !== ENVELOPE_VERSION ||
    envelope.algorithm !== ALGORITHM ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Protected fixture artifact has an unsupported envelope.");
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Protected fixture artifact has invalid authenticated encryption fields.");
  }
  return envelope as Envelope;
}

export async function transformProtectedFixture(
  mode: "encrypt" | "decrypt",
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const input = await readFile(resolve(inputPath));
  const key = keyFromEnvironment();
  let output: Buffer;
  if (mode === "encrypt") {
    if (input.length > MAX_STATE_BYTES) throw new Error("Protected fixture state is unexpectedly large.");
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    output = Buffer.from(JSON.stringify({
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    } satisfies Envelope) + "\n", "utf8");
  } else {
    const envelope = parseEnvelope(input.toString("utf8"));
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    try {
      output = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
    } catch {
      throw new Error("Protected fixture artifact authentication failed.");
    }
    if (output.length > MAX_STATE_BYTES) throw new Error("Decrypted protected fixture state is unexpectedly large.");
  }
  await writeFile(resolve(outputPath), output, { mode: 0o600 });
  await chmod(resolve(outputPath), 0o600);
}

async function main(values = process.argv.slice(2)): Promise<void> {
  if (values.includes("--help") || values.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const mode = values[0];
  if (mode !== "encrypt" && mode !== "decrypt") throw new Error(usage());
  const input = valueAfter(values, "--input");
  const output = valueAfter(values, "--output");
  if (!input || !output) throw new Error("--input and --output are required.");
  await transformProtectedFixture(mode, input, output);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
