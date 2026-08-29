import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcceptedEventFeed } from "../load/rehearsal.ts";

test("completed corrupt accepted-event feed lines fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-event-feed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "accepted.events");
  await writeFile(path, "", { mode: 0o600 });
  await chmod(path, 0o600);

  const writer = await AcceptedEventFeed.open(path, true, "run-1");
  await writer.append({ postId: "post-1", acceptedAt: 100, ordinal: 1 });
  const reader = await AcceptedEventFeed.open(path, false, "run-1");
  await reader.refresh();
  assert.equal(reader.get("post-1")?.ordinal, 1);

  await appendFile(path, "not-json\n", { mode: 0o600 });
  await assert.rejects(reader.refresh(), /event_feed_line_invalid_json/);
});
