import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubAuthProvider, GoogleAuthProvider } from "firebase/auth";
import type { UserCredential } from "firebase/auth";
import {
  socialAuthProof,
  socialAuthProvider,
} from "../src/auth/socialAuthProvider.ts";

test("social auth requests only the email scopes required by each provider", () => {
  const githubProvider = socialAuthProvider("github");
  assert.ok(githubProvider instanceof GithubAuthProvider);
  assert.deepEqual(githubProvider.getScopes(), ["user:email"]);

  const googleProvider = socialAuthProvider("google");
  assert.ok(googleProvider instanceof GoogleAuthProvider);
  assert.deepEqual(googleProvider.getScopes(), ["profile", "email"]);
});

test("social auth proof sends the GitHub OAuth token only for GitHub", async () => {
  const result = {
    user: { getIdToken: async () => "firebase-id-token" },
    _tokenResponse: { oauthAccessToken: "github-access-token" },
  } as unknown as UserCredential;

  assert.deepEqual(await socialAuthProof("github", result), {
    idToken: "firebase-id-token",
    providerAccessToken: "github-access-token",
  });
  assert.deepEqual(await socialAuthProof("google", result), {
    idToken: "firebase-id-token",
  });
});

test("social auth proof fails closed without a GitHub OAuth token", async () => {
  const result = {
    user: { getIdToken: async () => "firebase-id-token" },
    _tokenResponse: {},
  } as unknown as UserCredential;

  await assert.rejects(
    () => socialAuthProof("github", result),
    /GitHub did not return the credential required to sign in/,
  );
});
