import { build } from "esbuild";

const [entryPoint, outfile] = process.argv.slice(2);
if (!entryPoint || !outfile) {
  throw new Error("usage: esbuild.mjs <entry-point> <outfile>");
}

await build({
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  bundle: true,
  entryPoints: [entryPoint],
  format: "esm",
  outfile,
  packages: "external",
  platform: "node",
  target: "node24",
});
