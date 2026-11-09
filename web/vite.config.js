import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// Built into ../docs/app so GitHub Pages serves it at /strikebook/app/ next to the keeper's ../resolution-log.json.
// In `npm run dev`, /resolution-log.json is served from ../data (the keeper's live copy).
const devLog = {
  name: "strikebook-dev-log",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url.endsWith("/resolution-log.json")) return next();
      res.setHeader("content-type", "application/json");
      res.end(fs.readFileSync(path.resolve(__dirname, "../data/resolution-log.json")));
    });
  },
};

export default defineConfig({
  base: "./",
  plugins: [react(), devLog],
  build: { outDir: "../docs/app", emptyOutDir: true },
  test: { environment: "node" },
});
