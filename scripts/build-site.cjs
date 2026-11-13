#!/usr/bin/env node
// Static site build: data/resolution-log.json (committed) -> docs/index.html + docs/resolution-log.json.
// `docs/` is GitHub-Pages-ready ("deploy from /docs"); also works on Vercel/Netlify as a static dir.
// Usage: npm run build [-- --refresh]   (--refresh rebuilds the JSON log from data/*.jsonl first)
const fs = require("fs");
const path = require("path");
const { renderSite } = require("../src/lib/site.cjs");
const root = path.join(__dirname, "..");
const LOG = path.join(root, "data/resolution-log.json");
const OUT = path.join(root, process.env.SITE_OUT || "docs");
if (process.argv.includes("--refresh") || !fs.existsSync(LOG)) require("../src/keeper.cjs").writeResolutionLog();
const log = JSON.parse(fs.readFileSync(LOG, "utf8"));
fs.mkdirSync(OUT, { recursive: true });
const TR = path.join(OUT, "traction.json"); // written by `npm run traction` (on-chain scan, ours vs outside)
const honest = fs.existsSync(TR) ? JSON.parse(fs.readFileSync(TR, "utf8")) : null;
fs.writeFileSync(path.join(OUT, "index.html"), renderSite(log, honest));
fs.copyFileSync(LOG, path.join(OUT, "resolution-log.json"));
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
console.log(`built ${path.relative(root, OUT)}/ : ${log.stats.resolved} resolutions, ${log.stats.ladders} ladders`);
