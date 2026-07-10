import { chromium } from "playwright";
import { spawn } from "child_process";
import net from "net";
const PORT=4319;
const up=(p)=>new Promise(r=>{const s=net.connect(p,"localhost");s.on("connect",()=>{s.destroy();r(true)});s.on("error",()=>r(false))});
let vite=null;
if(!(await up(PORT))){ vite=spawn("npx",["vite","--port",String(PORT),"--strictPort"],{stdio:"ignore"}); for(let i=0;i<100&&!(await up(PORT));i++)await new Promise(r=>setTimeout(r,200)); }
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:1100,height:760}})).newPage();
const errs=[]; p.on("pageerror",e=>errs.push(String(e).split("\n")[0]));
// default load = queen_move seed 11
await p.goto(`http://localhost:${PORT}/viewer.html`,{waitUntil:"commit"});
await p.waitForFunction(()=>window.VIEWER&&window.VIEWER.ready,{timeout:60000});
let v=await p.evaluate(()=>({task:window.VIEWER.task,num:window.VIEWER.num,wp:window.VIEWER.waypoints,stats:window.VIEWER.stats}));
console.log("QUEEN_MOVE:",JSON.stringify(v));
await p.evaluate(()=>window.VIEWER.setFrame(Math.floor(window.VIEWER.num*0.5)));
await p.screenshot({path:"/tmp/viewer_move.png"});
// now a pickup
await p.selectOption("#scenario","table_pickup");
await p.fill("#seed","33");
await p.click("#gen");
await p.waitForFunction(()=>window.VIEWER&&window.VIEWER.task&&window.VIEWER.task.includes("pick up"),{timeout:60000});
v=await p.evaluate(()=>({task:window.VIEWER.task,num:window.VIEWER.num,wp:window.VIEWER.waypoints,stats:window.VIEWER.stats}));
console.log("TABLE_PICKUP:",JSON.stringify(v));
await p.evaluate(()=>window.VIEWER.setFrame(Math.floor(window.VIEWER.num*0.5)));
await p.screenshot({path:"/tmp/viewer_pickup.png"});
console.log("pageerrs:",errs.length, errs.slice(0,3).join(" | "));
await b.close(); if(vite)vite.kill();
