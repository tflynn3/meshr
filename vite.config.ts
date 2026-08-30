import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const configDirectory = dirname(fileURLToPath(import.meta.url));

interface SchemaAsset {
  fileName: string;
  source: string;
  urlPath: string;
}

function schemaAssets(): SchemaAsset[] {
  const versionedRoot = join(configDirectory, "schemas", "v1");
  const versioned = readdirSync(versionedRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      fileName: `schemas/meshr/v1/${entry.name}`,
      source: join(versionedRoot, entry.name),
      urlPath: `/schemas/meshr/v1/${entry.name}`,
    }));
  return [
    {
      fileName: "schemas/agent-v0alpha1.json",
      source: join(configDirectory, "schemas", "agent-v0alpha1.json"),
      urlPath: "/schemas/agent-v0alpha1.json",
    },
    ...versioned,
  ];
}

function meshrSchemaAssets(): Plugin {
  return {
    name: "meshr-schema-assets",
    configureServer(server) {
      const assets = new Map(schemaAssets().map((asset) => [asset.urlPath, asset]));
      server.middlewares.use((request: any, response: any, next: () => void) => {
        const pathname = new URL(request.url ?? "/", "http://meshr.local").pathname;
        const asset = assets.get(pathname);
        if (!asset) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("cache-control", "no-cache");
        response.setHeader("content-type", "application/schema+json; charset=utf-8");
        response.end(readFileSync(asset.source));
      });
    },
    generateBundle() {
      for (const asset of schemaAssets()) {
        this.emitFile({
          type: "asset",
          fileName: asset.fileName,
          source: readFileSync(asset.source),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), meshrSchemaAssets()],
  // Bazel presents declared inputs as symlinks in its output tree. Keeping
  // those paths intact makes Vite/Rolldown emit workspace-relative assets.
  resolve: {
    preserveSymlinks: true,
  },
  server: {
    proxy: {
      // Keep the browser's same-origin live topology connection on the same
      // dev origin as HTTP. The explicit ws flag is required for Vite to
      // forward WebSocket upgrades instead of hanging after the initial page
      // load.
      "/v1": {
        target: "http://127.0.0.1:8787",
        ws: true,
      },
      "/healthz": {
        target: "http://127.0.0.1:8787",
      },
    },
  },
});
