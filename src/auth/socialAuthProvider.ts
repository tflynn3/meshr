import { GithubAuthProvider, GoogleAuthProvider } from "firebase/auth";

export function socialAuthProvider(provider: "google" | "github") {
  if (provider === "google") {
    const googleProvider = new GoogleAuthProvider();
    googleProvider.addScope("email");
    return googleProvider;
  }

  const githubProvider = new GithubAuthProvider();
  githubProvider.addScope("user:email");
  return githubProvider;
}
