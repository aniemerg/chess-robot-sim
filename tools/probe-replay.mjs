import { chromium } from "playwright";
const id = process.argv[2] || "v2_001";
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:700,height:340}})).newPage();
await p.goto(`http://localhost:4318/replay.html?episode=${id}`,{waitUntil:"networkidle"});
await p.waitForFunction(()=>window.REPLAY && window.REPLAY.totalFrames>0,{timeout:60000});
const tf = await p.evaluate(()=>window.REPLAY.totalFrames);
const st = await p.evaluate(()=>window.REPLAY.stats);
// probe EVERY frame sequentially (stateful) in the browser, return the array
const rows = await p.evaluate((tf)=>{ const out=[]; for(let i=0;i<tf;i++) out.push(window.REPLAY.probe(i)); return out; }, tf);
console.log(`${id}: frames=${tf} attach=${st.attachFrame} detach=${st.detachFrame}`);
// report min piece Z (through-floor check) and sample rows
let minPZ=1e9, minAt=-1;
for (const r of rows){ if(r.piece && r.applied===1 && r.piece[2]<minPZ){minPZ=r.piece[2];minAt=r.i;} }
console.log(`min held-piece Z = ${minPZ}mm at frame ${minAt}  (tableZ=${id.startsWith('all_01')?0:9}mm; below = through floor)`);
console.log("i    grip st tcpZ pieceZ  d(xy)");
for (let i=0;i<tf;i+=Math.max(1,Math.round(tf/22))){ const r=rows[i]; const d=r.piece?Math.hypot(r.piece[0]-r.tcp[0],r.piece[1]-r.tcp[1]).toFixed(0):'-';
  console.log(`${String(r.i).padStart(3)} ${r.grip.toFixed(2)} ${r.applied} ${String(r.tcp[2]).padStart(6)} ${String(r.piece?r.piece[2]:'-').padStart(6)} ${d}`); }
await b.close();
