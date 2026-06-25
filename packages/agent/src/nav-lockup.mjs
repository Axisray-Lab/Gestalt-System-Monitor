#!/usr/bin/env node
/**
 * Car-to-car LOCK-UP metric — the thing point-③ (inter-vehicle avoidance) fixes.
 *
 * A "lock-up" = two non-aerial units within CONTACT cm of each other for >= LOCK_SEC
 * while BOTH barely move (jammed displacement < JAM cm over the window) and both
 * alive. This is the "ram & stick" the avoidance change targets — distinct from the
 * stuck%/AWOL metrics (a unit creeping or holding a post is NOT a lock-up).
 *
 * Usage: node nav-lockup.mjs <dir|trace...> [--contact 75] [--lock 1.5] [--jam 30]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const A = { Health:10000003, Defeated:50000007, TeamID:10000036, Class:60000002,
  X:10000107, Y:10000108, IsInDeploymentMode:50000043 };
const CAREERS = { 1001:'Hero',1002:'Engineer',1003:'Infantry',1004:'Sentry',1005:'Aerial',1006:'Radar',1007:'Dart' };
const AERIAL = 1005;
const D = (ax,ay,bx,by)=>Math.hypot(ax-bx,ay-by);

const argv = process.argv.slice(2);
const num = (f,d)=>{const i=argv.indexOf(f);return i>=0?+argv[i+1]:d;};
const CONTACT = num('--contact', 75);   // cm, center-to-center "touching" (~2 robot radii)
const LOCK_F = Math.round(num('--lock', 1.5) * 10); // frames (~10 Hz)
const JAM = num('--jam', 30);           // cm: both units move < this over the episode = jammed
const paths = argv.filter((a,i)=>!a.startsWith('--') && argv[i-1]!=='--contact' && argv[i-1]!=='--lock' && argv[i-1]!=='--jam');

const files = [];
for (const a of paths){ const st=statSync(a); if(st.isDirectory()) for(const f of readdirSync(a)){ if(f.endsWith('.trace.json')) files.push(path.join(a,f)); } else if(a.endsWith('.trace.json')) files.push(a); }
files.sort();

function reconstruct(t){
  const state=new Map(), series=new Map(), id=new Map();
  for(const frame of t.frames){
    for(const[mid,flat]of frame){ let s=state.get(mid); if(!s){s={};state.set(mid,s);} for(let i=0;i<flat.length;i+=2)s[flat[i]]=flat[i+1]; }
    for(const[mid,s]of state){ const c=s[A.Class]; if(!CAREERS[c]||c===AERIAL)continue; if(s[A.X]==null||s[A.Y]==null)continue;
      if(!id.has(mid))id.set(mid,{team:s[A.TeamID],career:CAREERS[c]});
      let arr=series.get(mid); if(!arr){arr=[];series.set(mid,arr);}
      const dead=s[A.Defeated]===1||(s[A.Health]??0)<=0;
      arr.push({x:s[A.X],y:s[A.Y],alive:!dead&&s[A.IsInDeploymentMode]!==1}); }
  }
  return { series, id };
}

// Detect lock-up episodes for one pair of frame-aligned series.
function pairLockups(a, b){
  const n=Math.min(a.length,b.length); const eps=[];
  let run=[]; // {ax,ay,bx,by}
  const flush=()=>{
    if(run.length>=LOCK_F){
      let amnx=1e9,amxx=-1e9,amny=1e9,amxy=-1e9,bmnx=1e9,bmxx=-1e9,bmny=1e9,bmxy=-1e9,sx=0,sy=0;
      for(const r of run){ amnx=Math.min(amnx,r.ax);amxx=Math.max(amxx,r.ax);amny=Math.min(amny,r.ay);amxy=Math.max(amxy,r.ay);
        bmnx=Math.min(bmnx,r.bx);bmxx=Math.max(bmxx,r.bx);bmny=Math.min(bmny,r.by);bmxy=Math.max(bmxy,r.by); sx+=(r.ax+r.bx)/2; sy+=(r.ay+r.by)/2; }
      const aMove=Math.hypot(amxx-amnx,amxy-amny), bMove=Math.hypot(bmxx-bmnx,bmxy-bmny);
      if(aMove<JAM && bMove<JAM) eps.push({frames:run.length, cx:sx/run.length, cy:sy/run.length});
    }
    run=[];
  };
  for(let i=0;i<n;i++){ const pa=a[i],pb=b[i];
    if(pa.alive&&pb.alive&&D(pa.x,pa.y,pb.x,pb.y)<CONTACT){ run.push({ax:pa.x,ay:pa.y,bx:pb.x,by:pb.y}); }
    else flush();
  }
  flush();
  return eps;
}

let nM=0, tot={friend:{n:0,sec:0}, foe:{n:0,sec:0}}, locs=[];
const perMatch=[];
for(const f of files){
  let t; try{t=JSON.parse(readFileSync(f,'utf8'));}catch{continue;}
  if(t.fmt!=='compact-delta')continue; nM++;
  const {series,id}=reconstruct(t);
  const mids=[...series.keys()].filter(m=>id.get(m).team===0||id.get(m).team===1);
  let mFriend=0,mFoe=0,mSec=0;
  for(let i=0;i<mids.length;i++)for(let j=i+1;j<mids.length;j++){
    const A1=id.get(mids[i]),B1=id.get(mids[j]);
    const eps=pairLockups(series.get(mids[i]),series.get(mids[j]));
    const same=A1.team===B1.team;
    for(const e of eps){ const sec=e.frames*0.1; tot[same?'friend':'foe'].n++; tot[same?'friend':'foe'].sec+=sec;
      if(same)mFriend++;else mFoe++; mSec+=sec; locs.push({x:e.cx,y:e.cy,sec}); }
  }
  perMatch.push({file:path.basename(f), friend:mFriend, foe:mFoe, sec:+mSec.toFixed(0)});
}

console.log(`\n══ LOCK-UP METRIC: ${nM} matches ══  (pair <${CONTACT}cm for ≥${LOCK_F/10}s, both jammed <${JAM}cm)\n`);
console.log(`per-match avg:  friend-friend lockups=${(tot.friend.n/Math.max(1,nM)).toFixed(2)}  foe-foe=${(tot.foe.n/Math.max(1,nM)).toFixed(2)}  total lock-sec=${((tot.friend.sec+tot.foe.sec)/Math.max(1,nM)).toFixed(0)}`);
console.log(`totals:  friend lockups=${tot.friend.n} (${tot.friend.sec.toFixed(0)}s)  foe lockups=${tot.foe.n} (${tot.foe.sec.toFixed(0)}s)`);
const grid=new Map();
for(const l of locs){const gx=Math.round(l.x/100)*100,gy=Math.round(l.y/100)*100;const k=`${gx},${gy}`;const g=grid.get(k)??{gx,gy,sec:0,n:0};g.sec+=l.sec;g.n++;grid.set(k,g);}
console.log(`\nlock-up hotspots (top 8, meters):`);
for(const g of [...grid.values()].sort((a,b)=>b.sec-a.sec).slice(0,8)) console.log(`  (${(g.gx/100).toFixed(1)},${(g.gy/100).toFixed(1)})  ${g.n} eps  ${g.sec.toFixed(0)}s`);
if(argv.includes('--per-match')){ console.log('\nper-match:'); for(const m of perMatch)console.log(`  ${m.file}: friend=${m.friend} foe=${m.foe} sec=${m.sec}`); }
