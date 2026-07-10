import { chromium } from "playwright";
import { spawn, execSync } from "child_process";
import fs from "fs";
import net from "net";

/**
 * Headless synthetic-episode writer. Reuses a running Vite dev server (or spawns
 * one), opens synth.html for (scenario, seed), and writes one episode in the
 * recorder's on-disk format:
 *   synth/<dataset>/episodes/episode_XXXXXX/{episode.json,frames.jsonl,manifest.json,base/*.jpg,wrist/*.jpg}
 *
 * Usage: node tools/render-synth.mjs <scenario> <seed> [index] [dataset]
 */
const scenario = process.argv[2] || "queen_move";
const seed = Number(process.argv[3] ?? "1");
const index = Number(process.argv[4] ?? "0");
const dataset = process.argv[5] || `synth_${scenario}`;
const set = process.argv[6] || ""; // optional piece-set override
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
const page = await (await browser.newContext({ viewport: { width: 900, height: 320 } })).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
const setQ = set ? `&set=${set}` : "";
await page.goto(`http://localhost:${PORT}/synth.html?scenario=${scenario}&seed=${seed}&index=${index}${setQ}`, { waitUntil: "commit", timeout: 30000 });
await page.waitForFunction(() => window.SYNTH && window.SYNTH.ready, { timeout: 90000 });

const meta = await page.evaluate(() => ({ n: window.SYNTH.numFrames, episode: window.SYNTH.episode, frames: window.SYNTH.frames, manifest: window.SYNTH.manifest, stats: window.SYNTH.stats }));

const dir = `synth/${dataset}/episodes/episode_${String(index).padStart(6, "0")}`;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(`${dir}/base`, { recursive: true });
fs.mkdirSync(`${dir}/wrist`, { recursive: true });
fs.writeFileSync(`${dir}/episode.json`, JSON.stringify(meta.episode));
fs.writeFileSync(`${dir}/manifest.json`, JSON.stringify(meta.manifest, null, 2));
fs.writeFileSync(`${dir}/frames.jsonl`, meta.frames.map((f) => JSON.stringify(f)).join("\n") + "\n");

for (let i = 0; i < meta.n; i++) {
  const [b, w] = await page.evaluate((f) => [window.SYNTH.renderBase(f), window.SYNTH.renderWrist(f)], i);
  fs.writeFileSync(`${dir}/base/${String(i).padStart(6, "0")}.jpg`, Buffer.from(b.split(",")[1], "base64"));
  fs.writeFileSync(`${dir}/wrist/${String(i).padStart(6, "0")}.jpg`, Buffer.from(w.split(",")[1], "base64"));
}

await browser.close();
if (vite) vite.kill();

// Optional side-by-side preview clip for eyeballing (base|wrist); not part of the dataset.
try {
  execSync(`ffmpeg -v error -y -framerate 14 -i ${dir}/base/%06d.jpg -framerate 14 -i ${dir}/wrist/%06d.jpg -filter_complex hstack -pix_fmt yuv420p -crf 20 synth/${dataset}_ep${String(index).padStart(6, "0")}.mp4`);
} catch { /* ffmpeg optional */ }

console.log(`wrote ${meta.n} frames -> ${dir}`);
console.log(`  task: ${meta.episode.task}`);
console.log(`  IK follow mean=${meta.stats.meanErr_mm}mm max=${meta.stats.maxErr_mm}mm  dupFrac=${meta.stats.dupFraction}  grasp@${meta.stats.graspFrame} release@${meta.stats.releaseFrame}  dur=${meta.stats.duration_s}s  pageerrs=${errs.length}`);
if (errs.length) console.log("  " + errs.slice(0, 4).join("\n  "));
