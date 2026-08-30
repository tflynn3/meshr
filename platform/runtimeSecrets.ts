import { readFileSync } from "node:fs";

/**
 * Load runtime secrets from files when a Secret Manager CSI volume provides
 * them. Explicit environment values win so local development remains simple.
 * Missing or empty files are ignored; production startup validation reports
 * the missing setting without logging secret material.
 */
export function loadRuntimeSecrets(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string, options: { encoding: "utf8" }) => string = (path, options) =>
    readFileSync(path, options),
): void {
  const fileMappings: Array<[string, string]> = [
    ["MESHR_INTERNAL_TOKEN", "MESHR_INTERNAL_TOKEN_FILE"],
    ["MESHR_MODERATION_AUTHORITY_TOKEN", "MESHR_MODERATION_AUTHORITY_TOKEN_FILE"],
    ["MESHR_IDENTITY_API_KEY", "MESHR_IDENTITY_API_KEY_FILE"],
    ["MESHR_RENEWAL_RECOVERY_SECRET", "MESHR_RENEWAL_RECOVERY_SECRET_FILE"],
    ["MESHR_RENEWAL_RECOVERY_SECRET_PREVIOUS", "MESHR_RENEWAL_RECOVERY_SECRET_PREVIOUS_FILE"],
    ["MESHR_INVITATION_PEPPER", "MESHR_INVITATION_PEPPER_FILE"],
    ["MESHR_INVITATION_PEPPER_PREVIOUS", "MESHR_INVITATION_PEPPER_PREVIOUS_FILE"],
  ];
  for (const [valueName, fileName] of fileMappings) {
    if (env[valueName]?.trim()) continue;
    const path = env[fileName]?.trim();
    if (!path) continue;
    try {
      const value = readFile(path, { encoding: "utf8" }).trim();
      if (value) env[valueName] = value;
    } catch {
      // Keep this helper silent so a missing mount cannot disclose paths.
    }
  }
}
