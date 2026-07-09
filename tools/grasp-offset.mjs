import { chromium } from "playwright";
const id = process.argv[2] || "all_011";
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:700,height:340}})).newPage();
await p.goto(`http://localhost:4318/replay.html?episode=${id}`,{waitUntil:"networkidle"});
await p.waitForFunction(()=>window.REPLAY&&window.REPLAY.totalFrames>0,{timeout:60000});
const tf=await p.evaluate(()=>window.REPLAY.totalFrames);
const st=await p.evaluate(()=>window.REPLAY.stats);
const rows=await p.evaluate((tf)=>{const o=[];for(let i=0;i<tf;i++)o.push(window.REPLAY.probe(i));return o;},tf);
const pieceInit = rows[0].piece;
console.log(`${id}: attach=${st.attachFrame} detach=${st.detachFrame}`);
console.log(`piece placed at (${pieceInit[0]}, ${pieceInit[1]}) mm`);
// frames around attach: show TCP xy and offset to the placed piece
const a=st.attachFrame;
console.log("--- around ATTACH (frame, tcpXY, offset piece->tcp) ---");
for(let i=Math.max(0,a-4);i<=Math.min(tf-1,a+4);i++){const r=rows[i];
  const off=Math.hypot(r.tcp[0]-pieceInit[0], r.tcp[1]-pieceInit[1]).toFixed(0);
  console.log(`  ${String(i).padStart(3)} grip=${r.grip.toFixed(2)} st=${r.applied} tcpXY=(${r.tcp[0]},${r.tcp[1]}) tcpZ=${r.tcp[2]} offset=${off}mm`);}
if(st.detachFrame>0){const d=st.detachFrame;console.log("--- around DETACH ---");
  for(let i=Math.max(0,d-3);i<=Math.min(tf-1,d+3);i++){const r=rows[i];
    console.log(`  ${String(i).padStart(3)} grip=${r.grip.toFixed(2)} st=${r.applied} tcpXY=(${r.tcp[0]},${r.tcp[1]}) tcpZ=${r.tcp[2]} pieceXY=(${r.piece[0]},${r.piece[1]})`);}}
await b.close();
