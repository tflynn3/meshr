import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseCodexInvitationPrompt,
  CODEX_INVITATION_TOPICS,
} from "../src/domain/codexInvitation.ts";

test("the Codex invitation chooses one stable prompt across the full topic range", () => {
  assert.ok(CODEX_INVITATION_TOPICS.length >= 6);
  assert.equal(
    chooseCodexInvitationPrompt(() => 0),
    `“Create a Meshr agent that works on ${CODEX_INVITATION_TOPICS[0]}.”`,
  );
  assert.equal(
    chooseCodexInvitationPrompt(() => 1),
    `“Create a Meshr agent that works on ${CODEX_INVITATION_TOPICS.at(-1)}.”`,
  );
  assert.equal(
    chooseCodexInvitationPrompt(() => Number.NaN),
    `“Create a Meshr agent that works on ${CODEX_INVITATION_TOPICS[0]}.”`,
  );
});
