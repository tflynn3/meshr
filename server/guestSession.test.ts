import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMeshrServer } from "./app.ts";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "expected a session cookie");
  return value.split(";", 1)[0]!;
}

test("a production-style social-only server admits a seamless guest session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-guest-session-test-"));
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    socialAuthOnly: true,
  });
  const { baseUrl } = await app.listen();
  try {
    const created = await fetch(`${baseUrl}/v1/sessions/guest`, {
      method: "POST",
      headers: { "X-Meshr-Contract-Version": "1" },
    });
    assert.equal(created.status, 201);
    const session = await created.json() as {
      guest: boolean;
      csrfToken: string;
      user: { id: string; email: string; displayName: string };
    };
    assert.equal(session.guest, true);
    assert.equal(session.user.displayName, "Visitor");
    assert.match(session.user.email, /^visitor-[A-Za-z0-9_-]+@guest\.meshr\.invalid$/);
    assert.ok(session.csrfToken);

    const cookie = cookieFrom(created);
    const current = await fetch(`${baseUrl}/v1/me`, {
      headers: { Cookie: cookie, "X-Meshr-Contract-Version": "1" },
    });
    assert.equal(current.status, 200);
    const currentSession = await current.json() as { guest: boolean; user: { id: string } };
    assert.equal(currentSession.guest, true);
    assert.equal(currentSession.user.id, session.user.id);

    const browserAgent = await fetch(`${baseUrl}/v1/webmcp/session`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Meshr-Contract-Version": "1",
        "X-Meshr-CSRF": session.csrfToken,
        "Idempotency-Key": "guest-computational-chemist-001",
      },
      body: JSON.stringify({
        createAgent: {
          name: "Computational Chemist",
          handle: "computational-chemist",
          tagline: "Explores molecular systems through computation.",
          interests: ["computational chemistry", "molecular simulation"],
          personality: "Rigorous, curious, and clear about uncertainty.",
          participation: "interactive",
        },
      }),
    });
    assert.equal(browserAgent.status, 201);
    const agent = await browserAgent.json() as {
      agent: { ownerId: string; attention: { rootPosts: string; replies: string } };
    };
    assert.equal(agent.agent.ownerId, session.user.id);
    assert.deepEqual(agent.agent.attention, {
      browse: "public",
      rootPosts: "draft",
      replies: "draft",
      notes: "Participate when directly instructed through this page.",
    });
    assert.equal("guest" in agent.agent, false);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
