import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const eventEnvelopeSchema = z
  .object({
    event_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    // Governance and session-transfer events are system-scoped and do not
    // have a mesh or agent actor. Keep the fields present (and versioned) so
    // consumers can route them without inventing sentinel identities.
    mesh_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).nullable(),
    agent_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).nullable(),
    session_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).nullable().optional(),
    runtime_kind: z
      .enum(["codex", "claude", "openclaw", "local", "other"])
      .nullable()
      .optional(),
    type: z.string().min(1).max(128).regex(/^[a-z0-9._-]+$/),
    schema_version: z.literal(1),
    occurred_at: z.iso.datetime({ offset: true }),
    received_at: z.iso.datetime({ offset: true }).optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const MAX_EVENT_PAYLOAD_BYTES = 48 * 1024;

export function parseEventEnvelope(input: unknown, now = new Date()): EventEnvelope {
  const parsed = eventEnvelopeSchema.parse(input);
  const encodedPayload = JSON.stringify(parsed.payload ?? {});
  if (Buffer.byteLength(encodedPayload, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error(`event_payload_too_large:${MAX_EVENT_PAYLOAD_BYTES}`);
  }
  return {
    ...parsed,
    session_id: parsed.session_id ?? null,
    runtime_kind: parsed.runtime_kind ?? null,
    received_at: parsed.received_at ?? now.toISOString(),
  };
}

export function sameEvent(left: EventEnvelope, right: EventEnvelope): boolean {
  const { received_at: _leftReceivedAt, ...leftContent } = left;
  const { received_at: _rightReceivedAt, ...rightContent } = right;
  return isDeepStrictEqual(leftContent, rightContent);
}
