#!/usr/bin/env node
/** Validate blue's tunnel side-choice + hero-hunt execution.
 *  - Per blue ground unit: deepest Y reached (penetration into red half),
 *    which side (X sign) it crossed the midline on, % time at home, in red half.
 *  - Red lob hero deployed position + closest any blue unit got to it (hunt).
 *  Usage: node nav-tunnel-hunt.mjs <trace.json> */
import { readFileSync } from 'node:fs';
const A = { Health:10000003, Defeated:50000007, PlayerID:10000035, TeamID:10000036,
  TeamNumber:10000037, Class:60000002, X:10000107, Y:10000108, TurretYaw:10000111,
  Fired:63000002, Deploy:50000043 };
const CAREERS = {1001:'Hero',1002:'Eng',1003:'Infantry',1004:'Sentry',1005:'Aerial',1006:'Radar',1007:'Dart'};
const GROUND = new Set(['Hero','Infantry','Sentry']);
const file = process.argv[2];
const t = JSON.parse(readFileSync(file,'utf8'));
const state=new Map(), series=new Map(), id=new Map();
for (const frame of t.frames) {
  for (const [mid,flat] of frame){let s=state.get(mid);if(!s){s={};state.set(mid,s);}for(let i=0;i<flat.length;i+=2)s[flat[i]]=flat[i+1];}
  for (const [mid,s] of state){const c=s[A.Class];if(!CAREERS[c])continue;if(s[A.X]==null||s[A.Y]==null)continue;
    if(!id.has(mid))id.set(mid,{team:s[A.TeamID],career:CAREERS[c],tn:s[A.TeamNumber]});
    let arr=series.get(mid);if(!arr){arr=[];series.set(mid,arr);}
    const dead=s[A.Defeated]===1||(s[A.Health]??0)<=0;
    arr.push({x:s[A.X],y:s[A.Y],deploy:s[A.Deploy]===1,alive:!dead});}
}
// red lob hero (team0 Hero) deployed positions
let redHero=null; for(const[mid,info]of id) if(info.team===0&&info.career==='Hero') redHero=mid;
const redHeroArr = redHero?series.get(redHero):[];
const deployPts = redHeroArr.filter(p=>p.deploy&&p.alive);
const dhx = deployPts.length?deployPts.reduce((a,p)=>a+p.x,0)/deployPts.length:null;
const dhy = deployPts.length?deployPts.reduce((a,p)=>a+p.y,0)/deployPts.length:null;
console.log(`Match ${file.split(/[\\/]/).pop()}  winner=${t.summary?.winner??'?'}  frames=${t.frames.length}`);
console.log(`RED lob hero (mid=${redHero}): deployed ${deployPts.length} frames @ avg(${dhx?.toFixed(0)},${dhy?.toFixed(0)})  [red base y≈-1130]\n`);

const tag=i=>(i.team===0?'R':'B')+i.tn;
for (const side of [1,0]) { // blue first
  console.log(`=== ${side===1?'BLUE (team1, offense)':'RED (team0, defense)'} ground units ===`);
  for (const [mid,info] of id) {
    if (info.team!==side || !GROUND.has(info.career)) continue;
    const arr=series.get(mid); const live=arr.filter(p=>p.alive);
    if(!live.length){console.log(`  ${tag(info)} ${info.career}: never alive`);continue;}
    // home = own base side: blue y>900, red y<-900
    const homeY = side===1? (p=>p.y>900):(p=>p.y<-900);
    const enemyHalf = side===1? (p=>p.y<0):(p=>p.y>0);
    const home = live.filter(homeY).length, eh = live.filter(enemyHalf).length;
    // deepest penetration toward enemy base + side at that point
    let deep=null; for(const p of live){if(!deep|| (side===1? p.y<deep.y : p.y>deep.y))deep=p;}
    // midline crossings: sign of X when |y|<150
    const near=live.filter(p=>Math.abs(p.y)<150);
    const leftC=near.filter(p=>p.x<0).length, rightC=near.filter(p=>p.x>=0).length;
    // closest to red lob hero deploy pt
    let minD=1e9; if(dhx!=null) for(const p of live){const d=Math.hypot(p.x-dhx,p.y-dhy);if(d<minD)minD=d;}
    console.log(`  ${tag(info)} ${info.career}: home=${(100*home/live.length).toFixed(0)}% enemyHalf=${(100*eh/live.length).toFixed(0)}% `+
      `deepestY=${deep.y.toFixed(0)}(x=${deep.x.toFixed(0)},${deep.x<0?'LEFT':'RIGHT'}) `+
      `midcross L/R=${leftC}/${rightC} ${side===1?`distToRedHero=${minD.toFixed(0)}`:''}`);
  }
  console.log('');
}
