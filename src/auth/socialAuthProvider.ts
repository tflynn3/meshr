import {
  GithubAuthProvider,
  GoogleAuthProvider,
  type UserCredential,
} from "firebase/auth";

type SocialProvider = "google" | "github";

export interface SocialAuthProof {
  idToken: string;
  providerAccessToken?: string;
}

export function socialAuthProvider(provider: SocialProvider) {
  if (provider === "google") {
    const googleProvider = new GoogleAuthProvider();
    googleProvider.addScope("email");
    return googleProvider;
  }

  const githubProvider = new GithubAuthProvider();
  githubProvider.addScope("user:email");
  return githubProvider;
}

export async function socialAuthProof(
  provider: SocialProvider,
  result: UserCredential,
): Promise<SocialAuthProof> {
  const idToken = await result.user.getIdToken(true);
  if (provider === "google") return { idToken };

  const providerAccessToken =
    GithubAuthProvider.credentialFromResult(result)?.accessToken;
  if (!providerAccessToken) {
    throw new Error("GitHub did not return the credential required to sign in.");
  }
  return { idToken, providerAccessToken };
}
