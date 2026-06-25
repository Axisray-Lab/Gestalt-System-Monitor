#!/usr/bin/env node
/**
 * Navigation deep-dive — per-career behavior + spatial clustering of "stuck"
 * episodes (to separate geometry/path traps from legitimate combat holds).
 *
 * Usage: node nav-deep.mjs <dir|trace...> [--cell 100] [--hotspots 18]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const A = {
  Health: 10000003, Defeated: 50000007, PlayerID: 10000035, TeamID: 10000036,
  TeamNumber: 10000037, Class: 60000002, X: 10000107, Y: 10000108,
  ChassisYaw: 10000110, TurretYaw: 10000111, IsInDeploymentMode: 50000043,
};
const CAREERS = { 1001: 'Hero', 1002: 'Engineer', 1003: 'Infantry', 1004: 'Sentry', 1005: 'Aerial', 1006: 'Radar', 1007: 'Dart' };
const OBJ = [
  { name: 'redBase', team: 0, x: 8, y: -1130 }, { name: 'blueBase', team: 1, x: 7, y: 1185 },
  { name: 'redOutpost', team: 0, x: -381, y: -283 }, { name: 'blueOutpost', team: 1, x: 393, y: 333 },
  { name: 'redSupply', team: 0, x: 209, y: 123 /*BuffStation2026_0*/ }, { name: 'blueSupply', team: 1, x: -195, y: 505 },
];
const MIDLINE_Y = 27;
const STUCK_WIN = 20, STUCK_DIST = 40;
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function reconstruct(t) {
  const state = new Map(), series = new Map(), identity = new Map();
  for (const frame of t.frames) {
    for (const [mid, flat] of frame) { let s = state.get(mid); if (!s) { s = {}; state.set(mid, s); } for (let i = 0; i < flat.length; i += 2) s[flat[i]] = flat[i + 1]; }
    for (const [mid, s] of state) {
      const c = s[A.Class]; if (!CAREERS[c]) continue; if (s[A.X] == null || s[A.Y] == null) continue;
      if (!identity.has(mid)) identity.set(mid, { team: s[A.TeamID], career: CAREERS[c], pid: s[A.PlayerID] });
      let arr = series.get(mid); if (!arr) { arr = []; series.set(mid, arr); }
      const dead = s[A.Defeated] === 1 || (s[A.Health] ?? 0) <= 0;
      arr.push({ x: s[A.X], y: s[A.Y], alive: !dead && s[A.IsInDeploymentMode] !== 1, yaw: s[A.ChassisYaw] });
    }
  }
  return { series, identity };
}

function nearestObj(x, y, team) {
  let best = null, bd = Infinity;
  for (const o of OBJ) { const d = dist(x, y, o.x, o.y); if (d < bd) { bd = d; best = o; } }
  return { obj: best, d: bd, own: best.team === team };
}

// detect stuck episodes; return list of {cx,cy,frames,enemyHalf}
function stuckEpisodes(arr, team) {
  const home = team === 0 ? -1 : 1;
  const eps = []; let win = [];
  const flush = () => {
    if (win.length >= STUCK_WIN) {
      let sx = 0, sy = 0; for (const w of win) { sx += w.x; sy += w.y; }
      const cx = sx / win.length, cy = sy / win.length;
      const pen = home === -1 ? cy - MIDLINE_Y : MIDLINE_Y - cy;
      eps.push({ cx, cy, frames: win.length, enemyHalf: pen > 0 });
    }
    win = [];
  };
  for (const p of arr) {
    if (!p.alive) { flush(); continue; }
    win.push(p);
    let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
    for (const w of win) { mnX = Math.min(mnX, w.x); mxX = Math.max(mxX, w.x); mnY = Math.min(mnY, w.y); mxY = Math.max(mxY, w.y); }
    if (Math.hypot(mxX - mnX, mxY - mnY) >= STUCK_DIST) {
      // window broke — pop oldest until span small again, recording a completed episode if long
      flush();
    }
  }
  flush();
  return eps;
}

function pathLen(arr) { let L = 0, prev = null; for (const p of arr) { if (p.alive && prev && prev.alive) L += dist(p.x, p.y, prev.x, prev.y); prev = p; } return L; }

function main() {
  const argv = process.argv.slice(2);
  const cell = (() => { const i = argv.indexOf('--cell'); return i >= 0 ? +argv[i + 1] : 100; })();
  const topHot = (() => { const i = argv.indexOf('--hotspots'); return i >= 0 ? +argv[i + 1] : 18; })();
  const paths = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--cell' && argv[i - 1] !== '--hotspots');
  const files = [];
  for (const a of paths) { const st = statSync(a); if (st.isDirectory()) for (const f of readdirSync(a)) { if (f.endsWith('.trace.json')) files.push(path.join(a, f)); } else if (a.endsWith('.trace.json')) files.push(a); }
  files.sort();

  // per-career aggregate
  const career = {}; // key team:career
  const hot = new Map(); // grid cell -> {frames, team, enemyHalf, nearObj}
  let nMatch = 0;

  for (const f of files) {
    let t; try { t = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    if (t.fmt !== 'compact-delta') continue;
    nMatch++;
    const { series, identity } = reconstruct(t);
    for (const [mid, arr] of series) {
      const id = identity.get(mid); if (id.team !== 0 && id.team !== 1) continue;
      const k = `${id.team}:${id.career}`;
      const c = career[k] ?? (career[k] = { team: id.team, career: id.career, n: 0, alive: 0, path: 0, stuckF: 0, stuckEnemyF: 0, eps: 0 });
      const alive = arr.filter(p => p.alive).length;
      const eps = stuckEpisodes(arr, id.team);
      c.n++; c.alive += alive; c.path += pathLen(arr) / 100;
      for (const e of eps) {
        c.eps++; c.stuckF += e.frames; if (e.enemyHalf) c.stuckEnemyF += e.frames;
        const gx = Math.round(e.cx / cell) * cell, gy = Math.round(e.cy / cell) * cell;
        const key = `${gx},${gy}`;
        const h = hot.get(key) ?? { gx, gy, frames: 0, t0: 0, t1: 0, enemyHalf: 0 };
        h.frames += e.frames; h[`t${id.team}`] += e.frames; if (e.enemyHalf) h.enemyHalf += e.frames;
        hot.set(key, h);
      }
    }
  }

  console.log(`\n══ NAV DEEP-DIVE: ${nMatch} matches ══  (FRAME≈0.1s; stuck = <${STUCK_DIST}cm motion over ${STUCK_WIN/10}s)\n`);
  console.log('PER-CAREER (mean per unit-match):');
  console.log('  team career     aliveS  path(m) stuck%  stuck-in-enemy-half%  stuckEps');
  const order = Object.values(career).sort((a, b) => a.team - b.team || a.career.localeCompare(b.career));
  for (const c of order) {
    const aliveS = (c.alive / c.n * 0.1).toFixed(0);
    const path = (c.path / c.n).toFixed(0);
    const stuckPct = (100 * c.stuckF / Math.max(1, c.alive)).toFixed(0);
    const enemyShare = c.stuckF ? (100 * c.stuckEnemyF / c.stuckF).toFixed(0) : '0';
    const eps = (c.eps / c.n).toFixed(1);
    console.log(`  T${c.team}  ${c.career.padEnd(9)} ${aliveS.padStart(5)}  ${path.padStart(6)}  ${stuckPct.padStart(5)}  ${enemyShare.padStart(18)}   ${eps.padStart(6)}`);
  }

  console.log(`\nSTUCK HOTSPOTS (${cell}cm grid cells, ranked by total stuck-frames; loc in meters):`);
  console.log('   x(m)   y(m)   stuckSec  t0/t1   half   nearest objective (dist m)');
  const hots = [...hot.values()].sort((a, b) => b.frames - a.frames).slice(0, topHot);
  for (const h of hots) {
    const no = nearestObj(h.gx, h.gy, h.t0 >= h.t1 ? 0 : 1);
    const half = h.enemyHalf / h.frames > 0.5 ? 'ENEMY' : 'own';
    console.log(`  ${(h.gx/100).toFixed(1).padStart(6)} ${(h.gy/100).toFixed(1).padStart(6)}  ${(h.frames*0.1).toFixed(0).padStart(7)}  ${String(Math.round(h.t0*0.1)).padStart(3)}/${String(Math.round(h.t1*0.1)).padEnd(3)} ${half.padStart(5)}   ${no.obj.name} (${(no.d/100).toFixed(1)})`);
  }
}
main();
