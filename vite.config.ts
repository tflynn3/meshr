import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Bazel presents declared inputs as symlinks in its output tree. Keeping
  // those paths intact makes Vite/Rolldown emit workspace-relative assets.
  resolve: {
    preserveSymlinks: true,
  },
  server: {
    proxy: {
      "/v1": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
    },
  },
});
