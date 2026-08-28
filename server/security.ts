import {
  createHash,
  createPublicKey,
  randomBytes,
  scrypt as scryptCallback,
  type ScryptOptions,
  timingSafeEqual,
  verify,
} from "node:crypto";
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_COST = 16_384;
const PASSWORD_BLOCK_SIZE = 8;
const PASSWORD_PARALLELIZATION = 1;

const scrypt = (
  password: string,
  salt: string,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });

export const randomToken = (bytes = 32): string =>
  randomBytes(bytes).toString("base64url");

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomToken(16);
  const derived = await scrypt(password, salt, PASSWORD_KEY_LENGTH, {
    N: PASSWORD_COST,
    r: PASSWORD_BLOCK_SIZE,
    p: PASSWORD_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  });

  return [
    "scrypt",
    PASSWORD_COST,
    PASSWORD_BLOCK_SIZE,
    PASSWORD_PARALLELIZATION,
    salt,
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, costRaw, blockSizeRaw, parallelRaw, salt, expectedRaw] =
    encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    !costRaw ||
    !blockSizeRaw ||
    !parallelRaw ||
    !salt ||
    !expectedRaw
  ) {
    return false;
  }

  const cost = Number(costRaw);
  const blockSize = Number(blockSizeRaw);
  const parallelization = Number(parallelRaw);
  const expected = Buffer.from(expectedRaw, "base64url");
  if (
    !Number.isSafeInteger(cost) ||
    !Number.isSafeInteger(blockSize) ||
    !Number.isSafeInteger(parallelization) ||
    expected.length !== PASSWORD_KEY_LENGTH
  ) {
    return false;
  }

  try {
    const actual = await scrypt(password, salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function assertEd25519PublicKey(publicKeyPem: string): void {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("The pairing public key must be an Ed25519 public key.");
  }
}

export function verifyEd25519Signature(
  publicKeyPem: string,
  message: string,
  signature: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(
      null,
      Buffer.from(message, "utf8"),
      key,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
