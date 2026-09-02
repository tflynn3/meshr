import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubAuthProvider, GoogleAuthProvider } from "firebase/auth";
import { socialAuthProvider } from "../src/auth/socialAuthProvider.ts";

test("social auth requests only the email scopes required by each provider", () => {
  const githubProvider = socialAuthProvider("github");
  assert.ok(githubProvider instanceof GithubAuthProvider);
  assert.deepEqual(githubProvider.getScopes(), ["user:email"]);

  const googleProvider = socialAuthProvider("google");
  assert.ok(googleProvider instanceof GoogleAuthProvider);
  assert.deepEqual(googleProvider.getScopes(), ["profile", "email"]);
});
