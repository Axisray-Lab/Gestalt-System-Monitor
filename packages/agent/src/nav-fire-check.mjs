#!/usr/bin/env node
/** Detect firing-at-phantom: a unit firing while no enemy is near / turret pointed at own half.
 * Usage: node nav-fire-check.mjs <trace> [--tail 90] */
import { readFileSync } from 'node:fs';
const A={Health:10000003,Defeated:50000007,PlayerID:10000035,TeamID:10000036,TeamNumber:10000037,Class:60000002,
  X:10000107,Y:10000108,TurretYaw:10000111,Fired:63000002,IsInDeploymentMode:50000043};
const CAREERS={1001:'Hero',1002:'Engineer',1003:'Infantry',1004:'Sentry',1005:'Aerial',1006:'Radar',1007:'Dart'};
const BASE={0:{x:8,y:-1130},1:{x:7,y:1185}}; // own base/supply side per team
const file=process.argv[2];
const tail=(()=>{const i=process.argv.indexOf('--tail');return i>=0?+process.argv[i+1]:90;})();
const t=JSON.parse(readFileSync(file,'utf8'));
const state=new Map(),series=new Map(),id=new Map();
for(const frame of t.frames){
  for(const[mid,flat]of frame){let s=state.get(mid);if(!s){s={};state.set(mid,s);}for(let i=0;i<flat.length;i+=2)s[flat[i]]=flat[i+1];}
  for(const[mid,s]of state){const c=s[A.Class];if(!CAREERS[c])continue;if(s[A.X]==null||s[A.Y]==null)continue;
    if(!id.has(mid))id.set(mid,{team:s[A.TeamID],career:CAREERS[c],tn:s[A.TeamNumber]});
    let arr=series.get(mid);if(!arr){arr=[];series.set(mid,arr);}
    const dead=s[A.Defeated]===1||(s[A.Health]??0)<=0;
    arr.push({x:s[A.X],y:s[A.Y],yaw:s[A.TurretYaw]??0,fired:s[A.Fired]??0,alive:!dead&&s[A.IsInDeploymentMode]!==1});}
}
const N=Math.max(...[...series.values()].map(a=>a.length));
const bearing=(fx,fy,tx,ty)=>{let d=Math.atan2(ty-fy,tx-fx)*180/Math.PI;return d;};
const angDiff=(a,b)=>{let d=((a-b)%360+540)%360-180;return Math.abs(d);};
// check the requested units
const want=[['1','Sentry'],['1','Hero']]; // team1 (Blue) Sentry + Hero
console.log(`Match ${file.split(/[\\/]/).pop()} winner=${t.summary?.winner} frames=${N} (tail ${tail}s)\n`);
for(const[team,career]of want){
  for(const[mid,info]of id){
    if(String(info.team)!==team||info.career!==career)continue;
    const arr=series.get(mid); const start=Math.max(0,arr.length-tail*10);
    let firedStart=null,firedEnd=null,fireFrames=0,aliveFrames=0;
    let nearEnemySum=0,turretAtBaseFrames=0,turretAtEnemyFrames=0,firingNoEnemy=0;
    let prevFired=null;
    for(let i=start;i<arr.length;i++){const p=arr[i];if(!p.alive)continue;aliveFrames++;
      if(firedStart===null)firedStart=p.fired; firedEnd=p.fired;
      const firing=prevFired!=null&&p.fired>prevFired; if(firing)fireFrames++; prevFired=p.fired;
      // nearest enemy (team0) this frame
      let nd=1e9,nx=0,ny=0;
      for(const[em,ei]of id){if(ei.team===info.team)continue;const ea=series.get(em)[i];if(!ea||!ea.alive)continue;const d=Math.hypot(ea.x-p.x,ea.y-p.y);if(d<nd){nd=d;nx=ea.x;ny=ea.y;}}
      nearEnemySum+=Math.min(nd,2000);
      const bBase=bearing(p.x,p.y,BASE[info.team].x,BASE[info.team].y);
      const bEnemy=nd<1e9?bearing(p.x,p.y,nx,ny):null;
      if(angDiff(p.yaw,bBase)<35)turretAtBaseFrames++;
      if(bEnemy!=null&&angDiff(p.yaw,bEnemy)<35)turretAtEnemyFrames++;
      if(firing&&nd>800)firingNoEnemy++; // firing with nearest enemy >8m
    }
    const tag='B'+info.tn;
    console.log(`${tag} ${career} (mid=${mid}): tail aliveS=${(aliveFrames*0.1).toFixed(0)} bulletsFiredInTail=${firedEnd-firedStart} firingFrames=${fireFrames}`);
    console.log(`   avgNearestEnemy=${(nearEnemySum/Math.max(1,aliveFrames)/100).toFixed(1)}m  turret→ownBase=${(100*turretAtBaseFrames/Math.max(1,aliveFrames)).toFixed(0)}%  turret→enemy=${(100*turretAtEnemyFrames/Math.max(1,aliveFrames)).toFixed(0)}%  firingWithNoEnemy(>8m)=${fireFrames?((100*firingNoEnemy/fireFrames).toFixed(0)):0}%`);
    // dump last 20 samples
    const pts=[];for(let i=Math.max(0,arr.length-20);i<arr.length;i++){const p=arr[i];pts.push(`(${(p.x/100).toFixed(1)},${(p.y/100).toFixed(1)})y${p.yaw.toFixed(0)}f${p.fired}${p.alive?'':'✝'}`);}
    console.log('   last20: '+pts.join(' ')+'\n');
  }
}
