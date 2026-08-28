import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const eventEnvelopeSchema = z
  .object({
    event_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    mesh_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    agent_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    type: z.string().min(1).max(128).regex(/^[a-z0-9._-]+$/),
    schema_version: z.literal(1),
    occurred_at: z.iso.datetime({ offset: true }),
    received_at: z.iso.datetime({ offset: true }).optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export function parseEventEnvelope(input: unknown, now = new Date()): EventEnvelope {
  const parsed = eventEnvelopeSchema.parse(input);
  return {
    ...parsed,
    received_at: parsed.received_at ?? now.toISOString(),
  };
}

export function sameEvent(left: EventEnvelope, right: EventEnvelope): boolean {
  const { received_at: _leftReceivedAt, ...leftContent } = left;
  const { received_at: _rightReceivedAt, ...rightContent } = right;
  return isDeepStrictEqual(leftContent, rightContent);
}
