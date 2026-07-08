import { chromium } from "playwright";
import fs from "fs";
import { execSync } from "child_process";
const episode = process.argv[2] || "v2_001";
const tmp = `/tmp/replay_${episode}`;
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 700, height: 340 } })).newPage();
const errs=[]; p.on("pageerror",e=>errs.push(String(e)));
await p.goto(`http://localhost:4318/replay.html?episode=${episode}`, { waitUntil: "networkidle" });
await p.waitForFunction(()=>window.REPLAY && window.REPLAY.totalFrames>0, {timeout:90000});
const tf = await p.evaluate(()=>window.REPLAY.totalFrames);
const fps = await p.evaluate(()=>window.REPLAY.fps);
const st = await p.evaluate(()=>window.REPLAY.stats);
for (let i=0;i<tf;i++){
  const d = await p.evaluate((f)=>window.REPLAY.renderFrame(f), i);
  fs.writeFileSync(`${tmp}/f_${String(i).padStart(5,"0")}.png`, Buffer.from(d.split(",")[1],"base64"));
}
await b.close();
const out = `replicas/replay_${episode}.mp4`;
execSync(`ffmpeg -v error -y -framerate ${fps} -i ${tmp}/f_%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart ${out}`);
execSync(`ffmpeg -v error -y -i ${out} -vf "fps=20,scale=480:-1" replicas/replay_${episode}.gif`);
console.log(`rendered ${tf} frames @ ${fps}fps -> ${out}  keyframes=${st.keyframes} path-follow mean=${st.meanErr_mm.toFixed(2)}mm max=${st.maxErr_mm.toFixed(2)}mm  errs=${errs.length}`);
