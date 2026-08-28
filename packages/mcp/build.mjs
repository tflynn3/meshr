import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  packages: "external",
  sourcemap: true,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
};
await build({ ...common, entryPoints: ["index.ts"], outfile: "dist/index.js" });
await build({ ...common, entryPoints: ["cli.ts"], outfile: "dist/cli.js" });
