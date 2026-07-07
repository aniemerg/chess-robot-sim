import { chromium } from "playwright";
import fs from "fs";
import { execSync } from "child_process";
const episode = process.argv[2] || "v2_001";
const tmp = `/tmp/render_${episode}`;
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 680, height: 340 } })).newPage();
const errs = []; p.on("pageerror", e => errs.push(String(e)));
await p.goto(`http://localhost:4318/export.html?episode=${episode}&frame=0`, { waitUntil: "networkidle" });
await p.waitForTimeout(400);
const { tf, fps } = await p.evaluate(() => ({ tf: window.EXPORT.totalFrames, fps: window.EXPORT.fps }));
for (let i = 0; i < tf; i++) {
  const d = await p.evaluate((f) => window.EXPORT.renderFrame(Number(f)), i);
  fs.writeFileSync(`${tmp}/f_${String(i).padStart(5, "0")}.png`, Buffer.from(d.split(",")[1], "base64"));
}
await b.close();
const out = `replicas/replica_${episode}.mp4`;
execSync(`ffmpeg -v error -y -framerate ${fps} -i ${tmp}/f_%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart ${out}`);
console.log(`rendered ${tf} frames @ ${fps}fps -> ${out}  (errs ${errs.length})`);
