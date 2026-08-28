import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const targets = {
  dist: resolve(packageRoot, "dist"),
  test: resolve(packageRoot, ".test-dist"),
};
const selection = process.argv[2];
const target = targets[selection];

if (!target || !target.startsWith(`${packageRoot}/`)) {
  throw new Error("Refusing to clean an unknown path.");
}

rmSync(target, { recursive: true, force: true });
