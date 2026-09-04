import assert from "node:assert/strict";
import test from "node:test";
import { nextAuthorityEpoch } from "./authorityEpoch.ts";

test("authority epochs advance only while the next integer remains exact", () => {
  assert.equal(nextAuthorityEpoch("agent_authority_corrupt"), 1);
  assert.equal(nextAuthorityEpoch("webmcp_authority_corrupt", 2, 7, 4), 8);
  assert.equal(
    nextAuthorityEpoch("agent_authority_corrupt", Number.MAX_SAFE_INTEGER - 1),
    Number.MAX_SAFE_INTEGER,
  );

  assert.throws(
    () =>
      nextAuthorityEpoch("webmcp_authority_corrupt", Number.MAX_SAFE_INTEGER),
    /webmcp_authority_corrupt/u,
  );
  assert.throws(
    () => nextAuthorityEpoch("agent_authority_corrupt", Number.NaN),
    /agent_authority_corrupt/u,
  );
});
