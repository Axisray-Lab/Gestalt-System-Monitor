#!/usr/bin/env node
/**
 * Match Analyzer — reads [ATTR-RECORD] UE log, splits into individual matches,
 * and produces per-match summary JSON (same schema as attr-record-analysis).
 *
 * Also outputs per-match trace files (WatchAttributeMapsResult format) suitable
 * for replay through the TraceReplayer.
 *
 * Usage: node analyze-trace.mjs <ue-log> [--out <dir>]
 * Output: <dir>/summary.json  +  <dir>/iter-001.trace.json ... iter-NNN.trace.json
 */

import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

// ── Attribute IDs ──
const A = {
  Health: 10000003, HealthMax: 60000004, Defeated: 50000007,
  PlayerID: 10000035, TeamID: 10000036, TeamNumber: 10000037,
  Class: 60000002, Level: 60000003,
  DamageAppliedTotal: 63000000, DamageTakenTotal: 63000001, BulletFiredTotal: 63000002,
  IsCharging: 50000023, IsInFortressOccupyPoint: 50000041, IsInDeploymentMode: 50000043,
  G_CurGameTime: 80000002, G_CurMatchStatus: 80000005,
  G_BaseId_0: 80001000, G_OutpostId_0: 80002000,
  BC_State: 73000001,
  RadarDoubleVulnerabilityUsedCount: 10000094, RadarMarkLevel: 10000089,
  RealDartAmmoCount: 10000067, AmmoDartCount: 10000069, DartRemainingShots: 10000074,
};

const CAREERS = { 1001:'Hero',1002:'Engineer',1003:'Infantry',1004:'Sentry',1005:'Aerial',1006:'Radar',1007:'Dart' };

function attr(attrs, id, def = 0) { for (let i=0;i<attrs.length;i+=2) if (attrs[i]===id) return attrs[i+1]; return def; }
function attrsHas(attrs, id) { for (let i=0;i<attrs.length;i+=2) if (attrs[i]===id) return true; return false; }

function attrsToRecord(flat) { const r={};for(let i=0;i<flat.length;i+=2)r[String(flat[i])]=flat[i+1];return r; }

// Compact array-pair attr diff: only include changed values vs previous frame
function attrsDiff(prev, cur) {
  if (!prev) return cur; // first frame: full
  const diff = [];
  for (let i = 0; i < cur.length; i += 2) {
    const id = cur[i], val = cur[i + 1];
    let found = false;
    for (let j = 0; j < prev.length; j += 2) {
      if (prev[j] === id) { if (prev[j + 1] !== val) diff.push(id, val); found = true; break; }
    }
    if (!found) diff.push(id, val); // new attribute
  }
  return diff.length > 0 ? diff : null;
}

function parseLine(line) {
  const i=line.indexOf('[ATTR-RECORD]');if(i<0)return null;
  const j=line.indexOf('{',i);if(j<0)return null;
  try{return JSON.parse(line.substring(j));}catch{return null;}
}

function sampleToMaps(sample) {
  const m=new Map();for(const[id,flat]of(sample.maps??[]))m.set(id,flat);return m;
}

function globalAttrs(maps) {
  for(const a of maps.values())if(attrsHas(a,A.G_CurMatchStatus))return a;return[];
}

// ── Building snapshot ──
function buildingSnapshot(maps, global) {
  const teams=[];
  for(let t=0;t<2;t++){
    const bid=attr(global,A.G_BaseId_0+t,0),oid=attr(global,A.G_OutpostId_0+t,0);
    const b=maps.get(bid)??[],o=maps.get(oid)??[];
    teams.push({
      team:t,base_id:bid,base_hp:attr(b,A.Health,null),base_hp_max:attr(b,A.HealthMax,null),
      base_state:attr(b,A.BC_State,null),outpost_id:oid,outpost_hp:attr(o,A.Health,null),outpost_hp_max:attr(o,A.HealthMax,null),
    });
  }
  return teams;
}

// ── Bot stats ──
function updateBotStats(match, sample, maps) {
  for(const[mid,attrs]of maps){
    const c=attr(attrs,A.Class,0);if(!CAREERS[c])continue;
    const t=attr(attrs,A.TeamID,-999),tn=attr(attrs,A.TeamNumber,-1),pid=attr(attrs,A.PlayerID,0);
    const key=`${t}:${tn}:${c}:${pid}:${mid}`;
    let bot=match.bots.get(key);
    if(!bot){
      bot={map_id:mid,team:t,team_number:tn,player_id:pid,career:c,career_name:CAREERS[c],
        first_gt:sample.gt,last_gt:sample.gt,max_fired:0,max_damage_applied:0,max_damage_taken:0,
        defeated_samples:0,charging_samples:0,fortress_samples:0,deployed_samples:0,
        radar_used_max:0,radar_mark_level_max:0,dart_remaining_min:null,dart_ammo_min:null,
        hp_first:attr(attrs,A.Health,null),hp_last:attr(attrs,A.Health,null)};
      match.bots.set(key,bot);
    }
    bot.last_gt=sample.gt;
    bot.max_fired=Math.max(bot.max_fired,attr(attrs,A.BulletFiredTotal,0));
    bot.max_damage_applied=Math.max(bot.max_damage_applied,attr(attrs,A.DamageAppliedTotal,0));
    bot.max_damage_taken=Math.max(bot.max_damage_taken,attr(attrs,A.DamageTakenTotal,0));
    bot.hp_last=attr(attrs,A.Health,bot.hp_last);
    if(attr(attrs,A.Defeated,0)===1)bot.defeated_samples++;
    if(attr(attrs,A.IsCharging,0)===1)bot.charging_samples++;
    if(attr(attrs,A.IsInFortressOccupyPoint,0)>0)bot.fortress_samples++;
    if(attr(attrs,A.IsInDeploymentMode,0)===1)bot.deployed_samples++;
    bot.radar_used_max=Math.max(bot.radar_used_max,attr(attrs,A.RadarDoubleVulnerabilityUsedCount,0));
    bot.radar_mark_level_max=Math.max(bot.radar_mark_level_max,attr(attrs,A.RadarMarkLevel,0));
    if(c===1007){
      const rem=attr(attrs,A.DartRemainingShots,null),ammo=attr(attrs,A.RealDartAmmoCount,attr(attrs,A.AmmoDartCount,null));
      bot.dart_remaining_min=rem==null?bot.dart_remaining_min:Math.min(bot.dart_remaining_min??rem,rem);
      bot.dart_ammo_min=ammo==null?bot.dart_ammo_min:Math.min(bot.dart_ammo_min??ammo,ammo);
    }
  }
}

function createMatch(idx,sample,buildings){return{index:idx,first_sample:sample.s,last_sample:sample.s,start_rt:sample.rt,end_rt:sample.rt,start_gt:sample.gt,end_gt:sample.gt,sample_count:0,first_buildings:buildings,last_buildings:buildings,min_base_hp:[1/0,1/0],min_outpost_hp:[1/0,1/0],bots:new Map(),frames:[],_prevMaps:new Map()};}

function finalizeMatch(match){
  if(!match)return null;
  const bases=match.last_buildings.map(b=>b.base_hp);
  let w='draw_or_unknown';
  if((bases[0]??1/0)<=0&&(bases[1]??1/0)>0)w='team1';
  else if((bases[1]??1/0)<=0&&(bases[0]??1/0)>0)w='team0';
  else if((bases[0]??1/0)<(bases[1]??1/0))w='team1_hp';
  else if((bases[1]??1/0)<(bases[0]??1/0))w='team0_hp';

  const bots=[...match.bots.values()].sort((a,b)=>a.team-b.team||a.career-b.career||a.team_number-b.team_number);
  const td=[0,0],tf=[0,0];
  for(const b of bots){if(b.team===0||b.team===1){td[b.team]+=b.max_damage_applied;tf[b.team]+=b.max_fired;}}

  return {index:match.index,samples:match.sample_count,
    duration_game_ms:Math.max(0,match.end_gt-match.start_gt),
    duration_record_ms:Math.max(0,match.end_rt-match.start_rt),
    inferred_winner:w,
    base_hp_final:match.last_buildings.map(b=>b.base_hp),
    outpost_hp_final:match.last_buildings.map(b=>b.outpost_hp),
    base_hp_min:match.min_base_hp.map(v=>Number.isFinite(v)?v:null),
    outpost_hp_min:match.min_outpost_hp.map(v=>Number.isFinite(v)?v:null),
    base_state_final:match.last_buildings.map(b=>b.base_state),
    team_damage_applied:td,team_bullets_fired:tf,bots,
    _frames: match.frames,  // carried for per-match trace output
  };
}

function aggregate(matches){
  const w={team0:0,team1:0,team0_hp:0,team1_hp:0,draw_or_unknown:0};
  for(const m of matches)w[m.inferred_winner]=(w[m.inferred_winner]??0)+1;
  return {match_count:matches.length,wins:w,
    avg_duration_game_ms:matches.reduce((s,m)=>s+m.duration_game_ms,0)/Math.max(1,matches.length),
    avg_team_damage_applied:[
      matches.reduce((s,m)=>s+m.team_damage_applied[0],0)/Math.max(1,matches.length),
      matches.reduce((s,m)=>s+m.team_damage_applied[1],0)/Math.max(1,matches.length)],
    avg_team_bullets_fired:[
      matches.reduce((s,m)=>s+m.team_bullets_fired[0],0)/Math.max(1,matches.length),
      matches.reduce((s,m)=>s+m.team_bullets_fired[1],0)/Math.max(1,matches.length)]};
}

async function main(){
  const args=process.argv.slice(2);
  const lp=args.find(a=>!a.startsWith('--')&&a.endsWith('.log'));
  const oi=args.indexOf('--out');const od=oi>=0?args[oi+1]:'traces';
  if(!lp){console.error('usage: node analyze-trace.mjs <ue-log> [--out <dir>]');process.exit(1);}
  await mkdir(od,{recursive:true});

  const rl=readline.createInterface({input:createReadStream(lp),crlfDelay:Infinity});
  const matches=[];let cur=null,parsed=0,failed=0;

  for await(const line of rl){
    const s=parseLine(line);if(!s)continue;
    parsed++;const maps=sampleToMaps(s),global=globalAttrs(maps),bld=buildingSnapshot(maps,global);

    const isNew=!cur||(s.st===1&&cur.sample_count>0&&s.gt<cur.end_gt-1000);
    if(isNew){
      const f=finalizeMatch(cur);if(f)matches.push(f);
      cur=createMatch(matches.length+1,s,bld);
    }
    cur.sample_count++;cur.last_sample=s.s;cur.end_rt=s.rt;cur.end_gt=s.gt;cur.last_buildings=bld;
    for(const r of bld){
      if(r.base_hp!=null)cur.min_base_hp[r.team]=Math.min(cur.min_base_hp[r.team],r.base_hp);
      if(r.outpost_hp!=null)cur.min_outpost_hp[r.team]=Math.min(cur.min_outpost_hp[r.team],r.outpost_hp);
    }
    updateBotStats(cur,s,maps);

    // Build compact delta trace frame (keyframe every 150 frames, marker 0/1)
    const KEYFRAME_EVERY = 150;
    const isKeyframe = cur.sample_count === 1 || cur.sample_count % KEYFRAME_EVERY === 0;
    const buildingIds = new Set();
    const globalUp2 = maps.get(1);
    if (globalUp2) for (let t = 0; t < 2; t++) {
      const bid = attr(globalUp2, A.G_BaseId_0 + t, 0), oid = attr(globalUp2, A.G_OutpostId_0 + t, 0);
      if (bid) buildingIds.add(bid); if (oid) buildingIds.add(oid);
    }
    const compactMaps = [];
    for (const [mid, flat] of (s.maps ?? [])) {
      if (mid !== 1 && !buildingIds.has(mid) && attr(flat, A.Class, 0) <= 0) continue;
      const prevFlat = cur._prevMaps.get(mid);
      if (isKeyframe) {
        compactMaps.push([mid, flat, 0]); // 0 = keyframe
        cur._prevMaps.set(mid, flat);
      } else {
        const diff = attrsDiff(prevFlat, flat);
        if (diff) {
          compactMaps.push([mid, diff, 1]); // 1 = delta
          cur._prevMaps.set(mid, flat);
        }
      }
    }
    cur.frames.push(compactMaps);
  }
  const f=finalizeMatch(cur);if(f)matches.push(f);

  // Build summary (strip _frames — those go to per-match trace files)
  const summaryMatches = matches.map(({_frames, ...rest}) => rest);
  const stem=path.basename(lp).replace(/\.[^.]+$/,'');
  const summary={schema:'attr-record-analysis/1',input:lp,parsed_records:parsed,failed_records:failed,aggregate:aggregate(matches),matches:summaryMatches};
  const sp=path.join(od,`${stem}.summary.json`);
  await writeFile(sp,JSON.stringify(summary));
  console.error(`[analyze] ${parsed} records, ${matches.length} matches → ${sp}`);

  // Write per-match trace files (use original match objects with _frames)
  const fullMatches = matches; // need original with _frames
  for(const m of fullMatches){
    if(!m._frames) continue;
    const tp=path.join(od,`${stem}.iter-${String(m.index).padStart(3,'0')}.trace.json`);
    const trace={v:3,src:'attr-record',fmt:'compact-delta',mapId:9,frameCount:m._frames.length,durMs:m.duration_record_ms,gtMs:m.duration_game_ms,summary:{winner:m.inferred_winner,teamDamage:m.team_damage_applied,bots:m.bots},frames:m._frames};
    await writeFile(tp,JSON.stringify(trace));
    console.error(`[analyze]   iter ${m.index}: ${(Buffer.byteLength(JSON.stringify(trace))/1e6).toFixed(1)} MB`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
