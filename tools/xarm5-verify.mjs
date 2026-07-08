import { chromium } from "playwright";
import fs from "fs";
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:900,height:760}})).newPage();
const errs=[]; p.on("pageerror",e=>errs.push(String(e))); p.on("console",m=>m.type()==="error"&&errs.push(m.text()));
await p.goto("http://localhost:4318/xarm5.html",{waitUntil:"networkidle"});
await p.waitForTimeout(2500); // let STL meshes load
// home pose screenshot
await p.evaluate(()=>window.XARM5.homePose());
await p.waitForTimeout(300);
await p.screenshot({ path: "/tmp/vf/xarm5_home.png" });
console.log("home TCP (m):", (await p.evaluate(()=>window.XARM5.getTCP())).map(v=>+v.toFixed(3)));
// IK to real rollout TCP targets (mm -> m), episode_000001
const targets = {
  "start (268,-33,311)": [0.2688,-0.0333,0.3113],
  "grasp e7 (599,-8,46)": [0.599,-0.008,0.046],
  "release h1 (263,-186,45)": [0.263,-0.186,0.045],
  "travel mean (417,8,167)": [0.417,0.008,0.167],
  "far x=660 (660,0,60)": [0.660,0.0,0.060],
};
for (const [name,t] of Object.entries(targets)){
  const r = await p.evaluate(([x,y,z])=>window.XARM5.solveTo(x,y,z), t);
  console.log(`  ${name.padEnd(26)} err=${r.error_mm.toFixed(1)}mm vert=${r.verticalError_deg.toFixed(1)}deg ok=${r.success} it=${r.iterations}`);
}
await p.screenshot({ path: "/tmp/vf/xarm5_reach.png" });
console.log("errs:", errs.length, errs.slice(0,3).join(" | "));
await b.close();
