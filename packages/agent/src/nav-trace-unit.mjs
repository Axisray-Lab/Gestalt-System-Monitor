#!/usr/bin/env node
/**
 * Dump downsampled trajectories + longest stuck episodes for specific careers
 * in ONE match, to inspect pathfinding / target-assignment behavior directly.
 * Usage: node nav-trace-unit.mjs <trace.json> [--every 50]
 */
import { readFileSync } from 'node:fs';
const A = { Health:10000003, Defeated:50000007, PlayerID:10000035, TeamID:10000036, Class:60000002, X:10000107, Y:10000108, ChassisYaw:10000110, IsInDeploymentMode:50000043 };
const CAREERS = { 1001:'Hero',1002:'Engineer',1003:'Infantry',1004:'Sentry',1005:'Aerial',1006:'Radar',1007:'Dart' };
const OBJ=[{n:'redBase',x:8,y:-1130},{n:'blueBase',x:7,y:1185},{n:'redOut',x:-381,y:-283},{n:'blueOut',x:393,y:333}];
const D=(ax,ay,bx,by)=>Math.hypot(ax-bx,ay-by);
const file=process.argv[2];
const every=(()=>{const i=process.argv.indexOf('--every');return i>=0?+process.argv[i+1]:50;})();
const t=JSON.parse(readFileSync(file,'utf8'));
const state=new Map(),series=new Map(),id=new Map();
for(const frame of t.frames){
  for(const[mid,flat]of frame){let s=state.get(mid);if(!s){s={};state.set(mid,s);}for(let i=0;i<flat.length;i+=2)s[flat[i]]=flat[i+1];}
  for(const[mid,s]of state){const c=s[A.Class];if(!CAREERS[c])continue;if(s[A.X]==null||s[A.Y]==null)continue;
    if(!id.has(mid))id.set(mid,{team:s[A.TeamID],career:CAREERS[c],pid:s[A.PlayerID]});
    let arr=series.get(mid);if(!arr){arr=[];series.set(mid,arr);}
    const dead=s[A.Defeated]===1||(s[A.Health]??0)<=0;
    arr.push({x:s[A.X],y:s[A.Y],alive:!dead&&s[A.IsInDeploymentMode]!==1,hp:s[A.Health]??0});}
}
console.log(`Match ${file.split(/[\\/]/).pop()} winner=${t.summary?.winner} dmg=[${t.summary?.teamDamage}] frames=${t.frameCount}`);
const wanted=[['0','Infantry'],['1','Infantry'],['0','Hero'],['1','Hero']];
for(const[team,career]of wanted){
  for(const[mid,info]of id){
    if(String(info.team)!==team||info.career!==career)continue;
    const arr=series.get(mid);
    // longest stuck episode (alive, <40cm over window)
    let bestLen=0,bestC=null,cur=[],deaths=0,prevAlive=true;
    let L=0,prev=null,aliveF=0;
    for(const p of arr){
      if(p.alive){aliveF++;if(prev&&prev.alive)L+=D(p.x,p.y,prev.x,prev.y);}
      if(!prevAlive&&p.alive)deaths++; prevAlive=p.alive;
      if(p.alive){cur.push(p);let mnx=1e9,mxx=-1e9,mny=1e9,mxy=-1e9;for(const w of cur){mnx=Math.min(mnx,w.x);mxx=Math.max(mxx,w.x);mny=Math.min(mny,w.y);mxy=Math.max(mxy,w.y);}
        if(Math.hypot(mxx-mnx,mxy-mny)>=40){if(cur.length>bestLen){bestLen=cur.length;let sx=0,sy=0;for(const w of cur){sx+=w.x;sy+=w.y;}bestC={x:sx/cur.length,y:sy/cur.length};}cur=[];}}
      else{if(cur.length>bestLen){bestLen=cur.length;let sx=0,sy=0;for(const w of cur){sx+=w.x;sy+=w.y;}bestC=cur.length?{x:sx/cur.length,y:sy/cur.length}:null;}cur=[];}
      prev=p;
    }
    const near=bestC?OBJ.map(o=>({o,d:D(bestC.x,bestC.y,o.x,o.y)})).sort((a,b)=>a.d-b.d)[0]:null;
    console.log(`\n── T${info.team} ${career} mid=${mid} pid=${info.pid}: aliveS=${(aliveF*0.1).toFixed(0)} path=${(L/100).toFixed(0)}m respawns=${deaths} longestStuck=${(bestLen*0.1).toFixed(0)}s @(${bestC?(bestC.x/100).toFixed(1):'?'},${bestC?(bestC.y/100).toFixed(1):'?'})m near ${near?near.o.n+' '+(near.d/100).toFixed(1)+'m':'?'}`);
    // downsampled trajectory
    const pts=[];
    for(let i=0;i<arr.length;i+=every){const p=arr[i];pts.push(`${(i*0.1).toFixed(0)}s:(${(p.x/100).toFixed(1)},${(p.y/100).toFixed(1)})${p.alive?'':'✝'}`);}
    console.log('   '+pts.join(' '));
  }
}
