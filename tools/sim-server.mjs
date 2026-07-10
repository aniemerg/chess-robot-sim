import { chromium } from "playwright";
import { spawn } from "child_process";
import http from "http";
import net from "net";

/**
 * Sim environment HTTP server. Runs the Three.js closed-loop env (env.html) in a
 * headless browser and exposes it over HTTP so any client (e.g. the Python π0.5
 * eval) can drive it:
 *   POST /reset   {scenario, seed}     -> obs {base, wrist (b64 jpeg), state[5], task, goalKind}
 *   POST /step    {action:[x,y,z,yaw,grip]} -> obs
 *   GET  /success                      -> {success, ...}
 *   GET  /info                         -> {task, goalKind, steps, holding, released, ...}
 *   GET  /health                       -> {ok:true}
 *
 * Usage: node tools/sim-server.mjs   (serves on :8010; spawns Vite on :4319)
 */
const VITE_PORT = 4319;
const HTTP_PORT = Number(process.env.SIM_PORT || 8010);

const portUp = (port) => new Promise((res) => { const s = net.connect(port, "localhost"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
const waitPort = async (port) => { for (let i = 0; i < 150; i++) { if (await portUp(port)) return; await new Promise((r) => setTimeout(r, 200)); } throw new Error("vite did not start"); };

let vite = null;
if (!(await portUp(VITE_PORT))) {
  vite = spawn("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"], { stdio: "ignore" });
  process.on("exit", () => vite && vite.kill());
  await waitPort(VITE_PORT);
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 360, height: 280 } })).newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", String(e).split("\n")[0]));
await page.goto(`http://localhost:${VITE_PORT}/env.html`, { waitUntil: "commit", timeout: 30000 });
await page.waitForFunction(() => window.ENV && window.ENV.ready, { timeout: 60000 });
console.log(`env ready; serving on http://localhost:${HTTP_PORT}`);

const body = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b ? JSON.parse(b) : {})); });
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];
    if (url === "/health") return send(res, 200, { ok: true });
    if (url === "/reset" && req.method === "POST") {
      const { scenario, seed } = await body(req);
      const o = await page.evaluate(([s, sd]) => window.ENV.reset(s, sd), [scenario ?? "queen_move", Number(seed ?? 1)]);
      return send(res, 200, o);
    }
    if (url === "/step" && req.method === "POST") {
      const { action } = await body(req);
      const o = await page.evaluate((a) => window.ENV.step(a), action);
      return send(res, 200, o);
    }
    if (url === "/success") return send(res, 200, await page.evaluate(() => window.ENV.success()));
    if (url === "/info") return send(res, 200, await page.evaluate(() => window.ENV.info()));
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String(e).split("\n")[0] });
  }
});
server.listen(HTTP_PORT);

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await browser.close(); if (vite) vite.kill(); process.exit(0); });
