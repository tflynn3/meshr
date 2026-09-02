import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import {
  createGithubIdentityVerifier,
  createIdentityPlatformVerifier,
} from "./identity.ts";

const projectId = "meshr-identity-test";

function pem(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function identityToken(
  kid: string,
  privateKey: KeyObject,
  options: { provider?: "google" | "github"; includeEmail?: boolean } = {},
): string {
  const now = Math.floor(Date.now() / 1_000);
  const providerId = options.provider === "github" ? "github.com" : "google.com";
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: `subject-${kid}`,
    user_id: `subject-${kid}`,
    ...(options.includeEmail === false
      ? {}
      : { email: `${kid}@example.test`, email_verified: true }),
    exp: now + 3_600,
    iat: now,
    firebase: {
      identities: { [providerId]: [`provider-${kid}`] },
      sign_in_provider: providerId,
    },
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}

function certificateResponse(certificates: Record<string, string>): Response {
  return new Response(JSON.stringify(certificates), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}

test("GitHub identity verification resolves the primary verified email", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    url: string;
    authorization: string | null;
    apiVersion: string | null;
    redirect: string | undefined;
  }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        apiVersion: new Headers(init?.headers).get("x-github-api-version"),
        redirect: init?.redirect,
      });
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({
          id: 424242,
          login: "verified-owner",
          name: "Verified Owner",
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify([
        { email: "secondary@example.test", primary: false, verified: true },
        { email: "verified@example.test", primary: true, verified: true },
      ]), { headers: { "content-type": "application/json" } });
    };

    const verify = createGithubIdentityVerifier();
    const identity = await verify("github-access-token");

    assert.deepEqual(identity, {
      subject: "424242",
      email: "verified@example.test",
      displayName: "Verified Owner",
    });
    assert.deepEqual(requests.map(({ url }) => url), [
      "https://api.github.com/user",
      "https://api.github.com/user/emails",
    ]);
    assert.equal(
      requests.every(({ authorization }) => authorization === "Bearer github-access-token"),
      true,
    );
    assert.equal(requests.every(({ apiVersion }) => apiVersion === "2026-03-10"), true);
    assert.equal(requests.every(({ redirect }) => redirect === "error"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub identity verification rejects an unverified primary email", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let request = 0;
    globalThis.fetch = async () => {
      request += 1;
      return request === 1
        ? new Response(JSON.stringify({ id: 424242, login: "owner" }))
        : new Response(JSON.stringify([
            { email: "unverified@example.test", primary: true, verified: false },
          ]));
    };

    await assert.rejects(
      () => createGithubIdentityVerifier()("github-access-token"),
      /no primary verified email/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a cached unknown signing key causes one fail-closed single-flight certificate refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  let now = originalDateNow();
  const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const absent = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const concurrent = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let releaseConcurrentRefresh!: () => void;
  let markConcurrentRefreshStarted!: () => void;
  const concurrentRefresh = new Promise<void>((resolve) => {
    releaseConcurrentRefresh = resolve;
  });
  const concurrentRefreshStarted = new Promise<void>((resolve) => {
    markConcurrentRefreshStarted = resolve;
  });
  let requests = 0;

  try {
    Date.now = () => now;
    globalThis.fetch = async (input) => {
      assert.equal(
        String(input),
        "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com",
      );
      requests += 1;
      if (requests === 1) return certificateResponse({ first: pem(first.publicKey) });
      if (requests === 2) return certificateResponse({ rotated: pem(rotated.publicKey) });
      if (requests === 3) return new Response("unavailable", { status: 503 });
      if (requests === 4) {
        markConcurrentRefreshStarted();
        await concurrentRefresh;
        return certificateResponse({ concurrent: pem(concurrent.publicKey) });
      }
      throw new Error(`Unexpected certificate request ${requests}.`);
    };

    const verifier = createIdentityPlatformVerifier(projectId);
    const initialClaims = await verifier("google", identityToken("first", first.privateKey));
    assert.equal(initialClaims.subject, "subject-first");
    assert.equal(initialClaims.providerSubject, "provider-first");
    assert.equal(requests, 1);

    const githubClaims = await verifier(
      "github",
      identityToken("first", first.privateKey, {
        provider: "github",
        includeEmail: false,
      }),
    );
    assert.equal(githubClaims.email, "");
    assert.equal(githubClaims.providerSubject, "provider-first");

    const rotatedClaims = await verifier("google", identityToken("rotated", rotated.privateKey));
    assert.equal(rotatedClaims.subject, "subject-rotated");
    assert.equal(requests, 2, "a fresh cache miss must make exactly one bypass request");

    await assert.rejects(
      () => verifier("google", identityToken("absent", absent.privateKey)),
      /signing key is unknown/,
    );
    await assert.rejects(
      () => verifier("google", identityToken("another-absent", absent.privateKey)),
      /signing key is unknown/,
    );
    assert.equal(
      requests,
      2,
      "different absent keys must not bypass the forced-refresh cooldown",
    );

    now += 60_001;
    await assert.rejects(
      () => verifier("google", identityToken("failed-refresh", absent.privateKey)),
      /certificate request failed \(503\)/,
    );
    assert.equal(requests, 3, "a failed bypass must fail closed without retrying");

    await assert.rejects(
      () => verifier("google", identityToken("failed-refresh-cooldown", absent.privateKey)),
      /signing key is unknown/,
    );
    assert.equal(requests, 3, "a failed bypass must also start the cooldown");

    now += 60_001;
    const token = identityToken("concurrent", concurrent.privateKey);
    const firstVerification = verifier("google", token);
    const secondVerification = verifier("google", token);
    await concurrentRefreshStarted;
    assert.equal(requests, 4, "concurrent cache misses must share one refresh");
    releaseConcurrentRefresh();
    const claims = await Promise.all([firstVerification, secondVerification]);
    assert.deepEqual(
      claims.map((claim) => claim.subject),
      ["subject-concurrent", "subject-concurrent"],
    );
    assert.equal(requests, 4);
  } finally {
    releaseConcurrentRefresh?.();
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});
