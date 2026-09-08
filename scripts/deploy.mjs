import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = resolve(projectRoot, ".next");
const standaloneDir = resolve(buildDir, "standalone");
const deployDir = process.env.DEPLOY_DIR || resolve(process.env.HOME || "/home/ngduyd", ".9router/deploy");

if (!existsSync(standaloneDir)) {
  console.error(`[deploy] standalone not found at ${standaloneDir}`);
  console.error(`[deploy] run: npm run build`);
  process.exit(1);
}
if (!existsSync(resolve(standaloneDir, "server.js"))) {
  console.error(`[deploy] server.js missing in ${standaloneDir} — build incomplete`);
  process.exit(1);
}

// Clean deploy dir (keep sibling ~/.9router/logs, db, etc.)
if (existsSync(deployDir)) rmSync(deployDir, { recursive: true, force: true });
mkdirSync(deployDir, { recursive: true });

// Copy entire standalone tree (self-contained: .next, public, open-sse, src/mitm, node_modules, custom-server.js, server.js)
cpSync(standaloneDir, deployDir, { recursive: true, force: true });
console.log(`[deploy] copied ${standaloneDir} -> ${deployDir}`);

// Ensure static assets (postbuild may have missed it)
const staticSrc = resolve(buildDir, "static");
const staticDst = resolve(deployDir, ".next/static");
if (existsSync(staticSrc) && !existsSync(staticDst)) {
  cpSync(staticSrc, staticDst, { recursive: true, force: true });
  console.log(`[deploy] copied static ${staticSrc} -> ${staticDst}`);
}

// Ensure custom-server.js present (standalone already has it, but guard)
const csSrc = resolve(projectRoot, "custom-server.js");
const csDst = resolve(deployDir, "custom-server.js");
if (!existsSync(csDst) && existsSync(csSrc)) {
  cpSync(csSrc, csDst, { force: true });
  console.log(`[deploy] copied custom-server.js`);
}

console.log(`[deploy] done. Deploy dir: ${deployDir}`);
console.log(`[deploy] next: pm2 start ecosystem.config.js  (or pm2 restart 9router)`);
console.log(`[deploy] verify: pm2 list && curl -s http://localhost:20128/api/health 2>&1 | head`);
