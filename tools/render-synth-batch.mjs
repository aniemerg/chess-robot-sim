import { chromium } from "playwright";
import { spawn, execSync } from "child_process";
import fs from "fs";
import net from "net";

/**
 * Batch synthetic-episode writer — renders many episodes into ONE dataset in a
 * single browser session (reuses a running Vite). Each job is `scenario:seed`
 * (optionally `scenario:seed:set`); episodes are written with sequential indices.
 *
 * Usage:
 *   node tools/render-synth-batch.mjs <dataset> <scenario:seed[:set]> ...
 */
const dataset = process.argv[2] || "synth_demo";
const jobs = process.argv.slice(3).map((s) => {
  const [scenario, seed, set] = s.split(":");
  return { scenario, seed: Number(seed), set: set || "" };
});
if (!jobs.length) { console.error("no jobs"); process.exit(1); }
const PORT = 4319;

const portUp = (port) => new Promise((res) => {
  const s = net.connect(port, "localhost");
  s.on("connect", () => { s.destroy(); res(true); });
  s.on("error", () => res(false));
});
const waitPort = async (port) => { for (let i = 0; i < 100; i++) { if (await portUp(port)) return; await new Promise((r) => setTimeout(r, 200)); } throw new Error("vite did not start"); };

let vite = null;
if (!(await portUp(PORT))) {
  vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  process.on("exit", () => vite && vite.kill());
  await waitPort(PORT);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 900, height: 320 } });

const used = {};
for (let i = 0; i < jobs.length; i++) {
  const { scenario, seed, set } = jobs[i];
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  const setQ = set ? `&set=${set}` : "";
  await page.goto(`http://localhost:${PORT}/synth.html?scenario=${scenario}&seed=${seed}&index=${i}${setQ}`, { waitUntil: "commit", timeout: 30000 });
  await page.waitForFunction(() => window.SYNTH && window.SYNTH.ready, { timeout: 90000 });
  const meta = await page.evaluate(() => ({ n: window.SYNTH.numFrames, episode: window.SYNTH.episode, frames: window.SYNTH.frames, manifest: window.SYNTH.manifest, stats: window.SYNTH.stats }));

  const dir = `synth/${dataset}/episodes/episode_${String(i).padStart(6, "0")}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(`${dir}/base`, { recursive: true });
  fs.mkdirSync(`${dir}/wrist`, { recursive: true });
  fs.writeFileSync(`${dir}/episode.json`, JSON.stringify(meta.episode));
  fs.writeFileSync(`${dir}/manifest.json`, JSON.stringify(meta.manifest, null, 2));
  fs.writeFileSync(`${dir}/frames.jsonl`, meta.frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
  for (let f = 0; f < meta.n; f++) {
    const [b, w] = await page.evaluate((k) => [window.SYNTH.renderBase(k), window.SYNTH.renderWrist(k)], f);
    fs.writeFileSync(`${dir}/base/${String(f).padStart(6, "0")}.jpg`, Buffer.from(b.split(",")[1], "base64"));
    fs.writeFileSync(`${dir}/wrist/${String(f).padStart(6, "0")}.jpg`, Buffer.from(w.split(",")[1], "base64"));
  }
  await page.close();
  const mdl = meta.manifest.pieces[0].model;
  used[mdl] = (used[mdl] || 0) + 1;
  console.log(`[${i}] ${scenario} seed=${seed} | ${meta.episode.task} | ${mdl} | ${meta.n}f ${meta.stats.duration_s}s IK=${meta.stats.meanErr_mm}mm err=${errs.length}`);
}

await browser.close();
if (vite) vite.kill();
console.log(`\nwrote ${jobs.length} episodes -> synth/${dataset}/`);
console.log("piece sets used:", JSON.stringify(used));
