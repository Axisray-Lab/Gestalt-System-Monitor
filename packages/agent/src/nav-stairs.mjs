#!/usr/bin/env node
/** Per-unit vertical (stairs) + home-exit behavior. Usage: node nav-stairs.mjs <trace> [--every 40] */
import { readFileSync } from 'node:fs';
const A={Health:10000003,Defeated:50000007,PlayerID:10000035,TeamID:10000036,TeamNumber:10000037,Class:60000002,X:10000107,Y:10000108,Z:10000109,IsInDeploymentMode:50000043};
const CAREERS={1001:'Hero',1002:'Engineer',1003:'Infantry',1004:'Sentry',1005:'Aerial',1006:'Radar',1007:'Dart'};
const HOME={0:-1130,1:1185}; // base Y (cm) per team
const file=process.argv[2];
const every=(()=>{const i=process.argv.indexOf('--every');return i>=0?+process.argv[i+1]:40;})();
const t=JSON.parse(readFileSync(file,'utf8'));
const state=new Map(),series=new Map(),id=new Map();
for(const frame of t.frames){
  for(const[mid,flat]of frame){let s=state.get(mid);if(!s){s={};state.set(mid,s);}for(let i=0;i<flat.length;i+=2)s[flat[i]]=flat[i+1];}
  for(const[mid,s]of state){const c=s[A.Class];if(!CAREERS[c])continue;if(s[A.X]==null||s[A.Y]==null)continue;
    if(!id.has(mid))id.set(mid,{team:s[A.TeamID],career:CAREERS[c],tn:s[A.TeamNumber],pid:s[A.PlayerID]});
    let arr=series.get(mid);if(!arr){arr=[];series.set(mid,arr);}
    const dead=s[A.Defeated]===1||(s[A.Health]??0)<=0;
    arr.push({x:s[A.X],y:s[A.Y],z:s[A.Z]??0,alive:!dead&&s[A.IsInDeploymentMode]!==1});}
}
console.log(`Match ${file.split(/[\\/]/).pop()} winner=${t.summary?.winner}\n`);
const units=[...id.entries()].filter(([,i])=>i.team===0||i.team===1).sort((a,b)=>a[1].team-b[1].team||(a[1].career<b[1].career?-1:1)||a[1].tn-b[1].tn);
for(const[mid,info]of units){
  const arr=series.get(mid).filter(p=>p.alive);
  if(!arr.length)continue;
  const homeY=HOME[info.team];
  let zmin=1e9,zmax=-1e9,homeF=0,total=arr.length,maxClimb=0,baseZ=arr[0].z;
  for(const p of arr){zmin=Math.min(zmin,p.z);zmax=Math.max(zmax,p.z);if(Math.abs(p.y-homeY)<300)homeF++;maxClimb=Math.max(maxClimb,p.z-baseZ);}
  const tag=(info.team===0?'R':'B')+info.tn;
  console.log(`${tag} ${info.career} (team${info.team} tn${info.tn} pid${info.pid}) aliveS=${(total*0.1).toFixed(0)} Zcm[${zmin.toFixed(0)}..${zmax.toFixed(0)}] Zrange=${(zmax-zmin).toFixed(0)}cm timeAtHome=${(100*homeF/total).toFixed(0)}% maxClimbFromSpawn=${maxClimb.toFixed(0)}cm`);
}
console.log('\n── Infantry trajectories (t: x,y,z cm) ──');
for(const[mid,info]of units){
  if(info.career!=='Infantry')continue;
  const arr=series.get(mid);const tag=(info.team===0?'R':'B')+info.tn;
  const pts=[];for(let i=0;i<arr.length;i+=every){const p=arr[i];pts.push(`${(i*0.1).toFixed(0)}:(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})${p.alive?'':'✝'}`);}
  console.log(`\n${tag} ${info.career}:\n  ${pts.join(' ')}`);
}
