#!/usr/bin/env node
/**
 * Quantify two AI pathologies across a match set:
 *   (A) AWOL-idle:   alive but parked (<60cm motion) ≥ IDLE_SEC continuously
 *   (B) feed:        respawns per unit (deaths while match running)
 * Usage: node nav-pathology.mjs <dir|trace...> [--idle 50]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
const A={Health:10000003,Defeated:50000007,PlayerID:10000035,TeamID:10000036,Class:60000002,X:10000107,Y:10000108,IsInDeploymentMode:50000043};
const CAREERS={1001:'Hero',1002:'Engineer',1003:'Infantry',1004:'Sentry',1005:'Aerial',1006:'Radar',1007:'Dart'};
const argv=process.argv.slice(2);
const IDLE=(()=>{const i=argv.indexOf('--idle');return i>=0?+argv[i+1]:50;})();
const IDLE_F=IDLE*10, PARK=60; // <60cm spread over the whole idle run
const paths=argv.filter((a,i)=>!a.startsWith('--')&&argv[i-1]!=='--idle');
const files=[];
for(const a of paths){const st=statSync(a);if(st.isDirectory())for(const f of readdirSync(a)){if(f.endsWith('.trace.json'))files.push(path.join(a,f));}else if(a.endsWith('.trace.json'))files.push(a);}
files.sort();

const byTC={}; // team:career -> {n, awol, awolSec, respawns, awolEnemy}
const tc=(t,c)=>byTC[`${t}:${c}`]??(byTC[`${t}:${c}`]={team:t,career:c,n:0,awol:0,awolSec:0,respawns:0});
let matchAwol={0:0,1:0}, nM=0, awolLocs=[];

for(const f of files){
  let t;try{t=JSON.parse(readFileSync(f,'utf8'));}catch{continue;}
  if(t.fmt!=='compact-delta')continue; nM++;
  const state=new Map(),series=new Map(),id=new Map();
  for(const frame of t.frames){
    for(const[mid,flat]of frame){let s=state.get(mid);if(!s){s={};state.set(mid,s);}for(let i=0;i<flat.length;i+=2)s[flat[i]]=flat[i+1];}
    for(const[mid,s]of state){const c=s[A.Class];if(!CAREERS[c])continue;if(s[A.X]==null||s[A.Y]==null)continue;
      if(!id.has(mid))id.set(mid,{team:s[A.TeamID],career:CAREERS[c]});
      let arr=series.get(mid);if(!arr){arr=[];series.set(mid,arr);}
      const dead=s[A.Defeated]===1||(s[A.Health]??0)<=0;
      arr.push({x:s[A.X],y:s[A.Y],alive:!dead&&s[A.IsInDeploymentMode]!==1});}
  }
  for(const[mid,arr]of series){
    const info=id.get(mid);if(info.team!==0&&info.team!==1)continue;
    const c=tc(info.team,info.career);c.n++;
    // respawns: dead->alive transitions
    let prevAlive=arr.length?arr[0].alive:true,resp=0;
    for(const p of arr){if(!prevAlive&&p.alive)resp++;prevAlive=p.alive;}
    c.respawns+=resp;
    // AWOL idle: longest alive run with bbox<PARK lasting >=IDLE_F
    let run=[],hasAwol=false;
    const check=()=>{if(run.length>=IDLE_F){let mnx=1e9,mxx=-1e9,mny=1e9,mxy=-1e9,sx=0,sy=0;for(const w of run){mnx=Math.min(mnx,w.x);mxx=Math.max(mxx,w.x);mny=Math.min(mny,w.y);mxy=Math.max(mxy,w.y);sx+=w.x;sy+=w.y;}
        if(Math.hypot(mxx-mnx,mxy-mny)<PARK){c.awol++;c.awolSec+=run.length*0.1;hasAwol=true;awolLocs.push({t:info.team,career:info.career,x:sx/run.length,y:sy/run.length,sec:run.length*0.1});}}};
    for(const p of arr){if(p.alive){run.push(p);}else{check();run=[];}}check();
    if(hasAwol)matchAwol[info.team]++;
  }
}

console.log(`\n══ PATHOLOGY SCAN: ${nM} matches ══  (AWOL = alive & parked <${PARK}cm for ≥${IDLE}s)\n`);
console.log('PER TEAM:CAREER:');
console.log('  team career    units  AWOL-units  AWOL-rate  avgAWOLsec  respawns/unit');
for(const c of Object.values(byTC).sort((a,b)=>a.team-b.team||a.career.localeCompare(b.career))){
  console.log(`  T${c.team}  ${c.career.padEnd(9)} ${String(c.n).padStart(4)}   ${String(c.awol).padStart(7)}    ${(100*c.awol/c.n).toFixed(0).padStart(6)}%   ${(c.awolSec/Math.max(1,c.awol)).toFixed(0).padStart(7)}s    ${(c.respawns/c.n).toFixed(1).padStart(6)}`);
}
const t0=Object.values(byTC).filter(c=>c.team===0),t1=Object.values(byTC).filter(c=>c.team===1);
const sum=(a,f)=>a.reduce((s,x)=>s+x[f],0);
console.log(`\nTEAM TOTALS:  AWOL-units T0=${sum(t0,'awol')} T1=${sum(t1,'awol')} | respawns T0=${sum(t0,'respawns')} T1=${sum(t1,'respawns')}`);
console.log(`Matches with ≥1 AWOL unit: T0=${matchAwol[0]}/${nM}  T1=${matchAwol[1]}/${nM}`);
// AWOL location clustering
const grid=new Map();
for(const l of awolLocs){const gx=Math.round(l.x/100)*100,gy=Math.round(l.y/100)*100;const k=`${gx},${gy}`;const g=grid.get(k)??{gx,gy,sec:0,n:0,t0:0,t1:0};g.sec+=l.sec;g.n++;g[`t${l.t}`]++;grid.set(k,g);}
console.log(`\nAWOL park locations (top 12, meters):`);
for(const g of [...grid.values()].sort((a,b)=>b.sec-a.sec).slice(0,12))
  console.log(`  (${(g.gx/100).toFixed(1)},${(g.gy/100).toFixed(1)})  ${g.n} episodes  ${g.sec.toFixed(0)}s  t0=${g.t0} t1=${g.t1}`);
