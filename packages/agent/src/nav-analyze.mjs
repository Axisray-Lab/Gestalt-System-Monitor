#!/usr/bin/env node
/**
 * Navigation Analyzer — reads compact-delta trace files (v3, produced by
 * analyze-trace.mjs) and reconstructs per-unit trajectories to quantify
 * NAVIGATION and TARGET-ASSIGNMENT quality.
 *
 * Position attrs (WorldPosX/Y = 10000107/8) are in UE cm; same coordinate
 * frame as Content/Config/transform_define.csv values / 1000. Field (map 9,
 * RMUC-2026 AI) runs along Y: red(team0) home Y<0, blue(team1) home Y>0.
 *
 * Usage:
 *   node nav-analyze.mjs <trace.json | dir> [more...] [--json out.json] [--top N]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// ── Attribute IDs ──
const A = {
  Health: 10000003, HealthMax: 60000004, Defeated: 50000007,
  PlayerID: 10000035, TeamID: 10000036, TeamNumber: 10000037,
  Class: 60000002, X: 10000107, Y: 10000108, Z: 10000109,
  ChassisYaw: 10000110, TurretYaw: 10000111,
  IsInDeploymentMode: 50000043,
  DamageAppliedTotal: 63000000, DamageTakenTotal: 63000001,
};
const CAREERS = { 1001: 'Hero', 1002: 'Engineer', 1003: 'Infantry', 1004: 'Sentry', 1005: 'Aerial', 1006: 'Radar', 1007: 'Dart' };

// ── Map 9 (RMUC 2026 AI) objectives, from transform_define.csv (/1000 = cm) ──
const OBJ = {
  base:    [{ team: 0, x: 8, y: -1130 }, { team: 1, x: 7, y: 1185 }],
  outpost: [{ team: 0, x: -381, y: -283 }, { team: 1, x: 393, y: 333 }],
};
const MIDLINE_Y = 27; // (-1130 + 1185)/2 ≈ 27

const FRAME_MS = 100;        // ~10 Hz attrrecord
const STUCK_WIN = 20;        // 2.0 s window
const STUCK_DIST = 40;       // <40 cm of motion across the window ⇒ stationary
const STRIKE_R = 300;        // within 3 m of a structure = "in strike range"
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function loadTrace(file) {
  const t = JSON.parse(readFileSync(file, 'utf8'));
  if (t.fmt !== 'compact-delta') throw new Error(`${file}: not compact-delta (${t.fmt})`);
  return t;
}

/** Reconstruct, for one trace, per-unit time series + identity. */
function reconstruct(t) {
  const state = new Map();          // mid -> live attr record
  const series = new Map();         // mid -> [{x,y,hp,alive}]
  const identity = new Map();       // mid -> {team,career,pid,tn}
  for (const frame of t.frames) {
    for (const [mid, flat] of frame) {
      let s = state.get(mid); if (!s) { s = {}; state.set(mid, s); }
      for (let i = 0; i < flat.length; i += 2) s[flat[i]] = flat[i + 1];
    }
    // sample every mobile unit (has position + a career class)
    for (const [mid, s] of state) {
      const c = s[A.Class];
      if (!CAREERS[c]) continue;
      if (s[A.X] == null || s[A.Y] == null) continue;       // stationary unit (radar/dart) → skip
      if (!identity.has(mid)) identity.set(mid, { team: s[A.TeamID], career: CAREERS[c], pid: s[A.PlayerID], tn: s[A.TeamNumber] });
      let arr = series.get(mid); if (!arr) { arr = []; series.set(mid, arr); }
      const hp = s[A.Health] ?? 0;
      const dead = s[A.Defeated] === 1 || hp <= 0;
      const deploying = s[A.IsInDeploymentMode] === 1;
      arr.push({ x: s[A.X], y: s[A.Y], hp, alive: !dead && !deploying });
    }
  }
  return { series, identity };
}

/** Compute navigation metrics for one unit's time series. */
function unitMetrics(arr, team) {
  const home = team === 0 ? -1 : 1;                 // sign of own half along Y
  const enemyBase = OBJ.base.find(b => b.team !== team);
  const enemyOut = OBJ.outpost.find(o => o.team !== team);
  let pathLen = 0, aliveFrames = 0, enemyHalfFrames = 0, movingFrames = 0;
  let minBase = Infinity, minOut = Infinity, maxPen = -Infinity;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let prev = null;
  const stuckEpisodes = [];
  let win = [];                                     // sliding window of alive positions
  let curStuck = 0;

  for (const p of arr) {
    if (p.alive) {
      aliveFrames++;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minBase = Math.min(minBase, dist(p.x, p.y, enemyBase.x, enemyBase.y));
      minOut = Math.min(minOut, dist(p.x, p.y, enemyOut.x, enemyOut.y));
      // penetration into enemy half (signed): how far past midline toward enemy
      const pen = home === -1 ? (p.y - MIDLINE_Y) : (MIDLINE_Y - p.y);
      maxPen = Math.max(maxPen, pen);
      if (pen > 0) enemyHalfFrames++;
      if (prev && prev.alive) {
        const d = dist(p.x, p.y, prev.x, prev.y);
        pathLen += d;
        if (d > 5) movingFrames++;                  // >5cm/frame ≈ >0.5 m/s
      }
      // stuck window
      win.push(p);
      if (win.length > STUCK_WIN) win.shift();
      if (win.length === STUCK_WIN) {
        let wMinX = Infinity, wMaxX = -Infinity, wMinY = Infinity, wMaxY = -Infinity;
        for (const w of win) { wMinX = Math.min(wMinX, w.x); wMaxX = Math.max(wMaxX, w.x); wMinY = Math.min(wMinY, w.y); wMaxY = Math.max(wMaxY, w.y); }
        const span = Math.hypot(wMaxX - wMinX, wMaxY - wMinY);
        if (span < STUCK_DIST) curStuck++;
        else { if (curStuck >= STUCK_WIN) stuckEpisodes.push(curStuck); curStuck = 0; win = []; }
      }
    } else {
      if (curStuck >= STUCK_WIN) stuckEpisodes.push(curStuck);
      curStuck = 0; win = [];
    }
    prev = p;
  }
  if (curStuck >= STUCK_WIN) stuckEpisodes.push(curStuck);

  const bboxDiag = Math.hypot(maxX - minX, maxY - minY);
  const stuckFrames = stuckEpisodes.reduce((s, e) => s + e, 0);
  return {
    aliveFrames,
    aliveSec: +(aliveFrames * FRAME_MS / 1000).toFixed(0),
    pathLen_m: +(pathLen / 100).toFixed(1),
    bboxDiag_m: +(bboxDiag / 100).toFixed(1),
    // tortuosity: path length vs how much ground it actually covered
    tortuosity: bboxDiag > 50 ? +(pathLen / bboxDiag).toFixed(1) : null,
    movingPct: aliveFrames ? +(100 * movingFrames / aliveFrames).toFixed(0) : 0,
    enemyHalfPct: aliveFrames ? +(100 * enemyHalfFrames / aliveFrames).toFixed(0) : 0,
    maxPenetration_m: +(maxPen / 100).toFixed(1),
    minEnemyOutpost_m: +(minOut / 100).toFixed(1),
    minEnemyBase_m: +(minBase / 100).toFixed(1),
    reachedOutpost: minOut < STRIKE_R,
    reachedBase: minBase < STRIKE_R,
    stuckEpisodes: stuckEpisodes.length,
    stuckSec: +(stuckFrames * FRAME_MS / 1000).toFixed(0),
    stuckPct: aliveFrames ? +(100 * stuckFrames / aliveFrames).toFixed(0) : 0,
  };
}

function analyzeMatch(file) {
  const t = loadTrace(file);
  const { series, identity } = reconstruct(t);
  const units = [];
  for (const [mid, arr] of series) {
    const id = identity.get(mid);
    if (id.team !== 0 && id.team !== 1) continue;
    units.push({ mid, ...id, ...unitMetrics(arr, id.team) });
  }
  units.sort((a, b) => a.team - b.team || a.career.localeCompare(b.career));
  return { file: path.basename(file), winner: t.summary?.winner, teamDamage: t.summary?.teamDamage, frameCount: t.frameCount, gtMs: t.gtMs, units };
}

/** team-level rollup of a match's units. */
function teamRollup(units, team) {
  const u = units.filter(x => x.team === team);
  if (!u.length) return null;
  const avg = (f) => +(u.reduce((s, x) => s + (x[f] ?? 0), 0) / u.length).toFixed(1);
  const sum = (f) => u.reduce((s, x) => s + (x[f] ?? 0), 0);
  return {
    units: u.length,
    avgPathLen_m: avg('pathLen_m'),
    avgEnemyHalfPct: avg('enemyHalfPct'),
    avgMaxPenetration_m: avg('maxPenetration_m'),
    avgMovingPct: avg('movingPct'),
    avgStuckPct: avg('stuckPct'),
    totStuckSec: sum('stuckSec'),
    reachedOutpost: u.filter(x => x.reachedOutpost).length,
    reachedBase: u.filter(x => x.reachedBase).length,
    minEnemyOutpost_m: Math.min(...u.map(x => x.minEnemyOutpost_m)),
    minEnemyBase_m: Math.min(...u.map(x => x.minEnemyBase_m)),
  };
}

function expandPaths(args) {
  const files = [];
  for (const a of args) {
    const st = statSync(a);
    if (st.isDirectory()) {
      for (const f of readdirSync(a)) if (f.endsWith('.trace.json')) files.push(path.join(a, f));
    } else if (a.endsWith('.trace.json')) files.push(a);
  }
  return files.sort();
}

function main() {
  const argv = process.argv.slice(2);
  const jsonI = argv.indexOf('--json'); const jsonOut = jsonI >= 0 ? argv[jsonI + 1] : null;
  const topI = argv.indexOf('--top'); const top = topI >= 0 ? +argv[topI + 1] : 0;
  const paths = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--json' && argv[i - 1] !== '--top');
  const files = expandPaths(paths);
  if (!files.length) { console.error('no trace files'); process.exit(1); }

  const matches = [];
  for (const f of files) {
    try { matches.push(analyzeMatch(f)); } catch (e) { console.error(`skip ${f}: ${e.message}`); }
  }

  // Cross-match team aggregate
  const agg = { 0: [], 1: [] };
  for (const m of matches) for (const team of [0, 1]) { const r = teamRollup(m.units, team); if (r) agg[team].push(r); }
  const meanOf = (arr, f) => arr.length ? +(arr.reduce((s, x) => s + x[f], 0) / arr.length).toFixed(1) : 0;

  console.log(`\n══ NAV ANALYSIS: ${matches.length} matches (${files.length} files) ══`);
  console.log(`\nCROSS-MATCH TEAM AGGREGATE (mean over matches):`);
  console.log(`  metric                     team0(red)   team1(blue)`);
  const rows = [
    ['avg path length (m)', 'avgPathLen_m'],
    ['avg time in enemy half %', 'avgEnemyHalfPct'],
    ['avg max penetration (m)', 'avgMaxPenetration_m'],
    ['avg moving %', 'avgMovingPct'],
    ['avg stuck %', 'avgStuckPct'],
    ['min dist→enemy outpost (m)', 'minEnemyOutpost_m'],
    ['min dist→enemy base (m)', 'minEnemyBase_m'],
    ['units reaching outpost', 'reachedOutpost'],
    ['units reaching base', 'reachedBase'],
  ];
  for (const [label, f] of rows) {
    console.log(`  ${label.padEnd(27)} ${String(meanOf(agg[0], f)).padStart(8)}   ${String(meanOf(agg[1], f)).padStart(10)}`);
  }

  if (top) {
    console.log(`\nPER-MATCH (first ${top}):`);
    for (const m of matches.slice(0, top)) {
      const r0 = teamRollup(m.units, 0), r1 = teamRollup(m.units, 1);
      console.log(`\n  ${m.file}  winner=${m.winner} dmg=[${m.teamDamage}]`);
      console.log(`    T0 push: enemyHalf=${r0.avgEnemyHalfPct}% pen=${r0.avgMaxPenetration_m}m minOut=${r0.minEnemyOutpost_m}m minBase=${r0.minEnemyBase_m}m reachOut=${r0.reachedOutpost} reachBase=${r0.reachedBase} stuck=${r0.avgStuckPct}%`);
      console.log(`    T1 push: enemyHalf=${r1.avgEnemyHalfPct}% pen=${r1.avgMaxPenetration_m}m minOut=${r1.minEnemyOutpost_m}m minBase=${r1.minEnemyBase_m}m reachOut=${r1.reachedOutpost} reachBase=${r1.reachedBase} stuck=${r1.avgStuckPct}%`);
    }
  }

  if (jsonOut) { writeFileSync(jsonOut, JSON.stringify({ matches, aggregate: agg }, null, 1)); console.log(`\n→ ${jsonOut}`); }
}
main();
