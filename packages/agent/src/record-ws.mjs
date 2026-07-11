#!/usr/bin/env node
// @ts-check
/**
 * AttributeMap WebSocket recorder.
 *
 * This is the batch/offline counterpart of the Monitor live feed: it subscribes
 * to `attribute.watchAttributeMaps`, dynamically follows referenced map ids, and
 * derives match progress plus dart telemetry from AttributeMap updates instead
 * of UE log sampling.
 *
 * Usage:
 *   node record-ws.mjs --url ws://127.0.0.1:9240 --target 5 --out traces/run
 *   node record-ws.mjs --url ws://127.0.0.1:9240 --target 5 --progress progress.json --out summary.json
 */

import { createWriteStream, readdirSync, statSync, unlinkSync } from 'node:fs';
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// rbrecord/1 writer version stamp (meta.recorder = record-ws.mjs/<RECORDER_VERSION>).
const RECORDER_VERSION = '1.0';
// Prefer the 'ws' package when resolvable, fall back to node's built-in (undici) WebSocket.
// Rationale: undici's client dies with an empty-message TypeError from its own #onSocketClose
// while a healthy recording is in flight (reproduced 3x at ~200s on node 24; the reconnect layer
// then burns its budget because every fresh undici socket dies the same way). The 'ws' package is
// unaffected. CI shell-runner checkouts have no node_modules — there the import fails and the
// built-in keeps things working (as it did for the balance13 overnight fleet). Both expose the
// WHATWG addEventListener API used below.
const WebSocket = await import('ws').then(m => m.default).catch(() => globalThis.WebSocket);

const METHOD_WATCH_ATTRIBUTE_MAPS = 'attribute.watchAttributeMaps';
const METHOD_WATCH_ATTRIBUTE_MAPS_RESULT = 'watchAttributeMaps.result';
const WATCH_CONTINUOUS = 2;

const A = {
  PlayerID_0: 0,
  PlayerID_MAX: 100000,
  PlayerBattleAttributeMapID: 1000001,
  Health: 10000003,
  PlayerID: 10000035,
  TeamID: 10000036,
  TeamNumber: 10000037,
  RealDartAmmoCount: 10000067,
  AmmoDartCount: 10000069,
  DartControlTarget: 10000071,
  DartBaseTargetMode: 10000072,
  DartGateReady: 10000073,
  DartRemainingShots: 10000074,
  Class: 60000002,
  HealthMax: 60000004,
  // Scoreboard (per-robot combat + per-team economy/rune) — the observable match state a
  // spectator dashboard shows, snapshotted at match end alongside building HP.
  DamageTakenTotal: 63000001,
  KillCount: 63000004,
  DeathCount: 63000005,
  BigRuneBuffArmCount: 50000082,
  BigRuneBuffLightCount: 50000083,
  IsInFortressOccupyPoint: 50000041,
  HasFortressAmmo: 50000047,
  TM_Coins: 74000003,
  TM_BaseDamageCount: 74000010,
  TM_OutPostRebuildCount: 74000011,
  TM_FortAmmo: 74000013,
  TM_FortAmmoCapMax: 74000022,
  TM_SupportCoins_70: 74000007,
  TM_SupportCoins_140: 74000008,
  TM_DartOutpostHitCount: 74000023,
  TM_DartBaseHitCount: 74000024,
  TM_DartOutpostDamageTotal: 74000025,
  TM_DartBaseDamageTotal: 74000026,
  TM_DartSuppressedHitCount: 74000027,
  G_CurGameTime: 80000002,
  G_CurMatchStatus: 80000005,
  G_MapId: 80000007,
  G_BaseId_0: 80001000,
  G_BaseId_MAX: 80001999,
  G_OutpostId_0: 80002000,
  G_OutpostId_MAX: 80002999,
  G_BuffStationId_0: 80004000,
  G_BuffStationId_MAX: 80004999,
};

const CLASS = {
  Aerial: 1005,
  Dart: 1007,
};

const DART_TARGET = {
  Outpost: 0,
  Base: 1,
};

const DEFAULT_WATCH_MAP_IDS = Array.from({ length: 256 }, (_, i) => i + 1);

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name, fallback = undefined) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
  };
  const has = name => args.includes(name);
  const rawOut = get('--out', '');
  const traceDir =
    get('--trace-dir', '') ||
    (rawOut && !/\.json$/i.test(rawOut) ? rawOut : '');
  const summary =
    get('--summary', '') ||
    (rawOut && /\.json$/i.test(rawOut) ? rawOut : traceDir ? path.join(traceDir, 'summary.json') : '');
  let metaJson = {};
  const rawMeta = get('--meta-json', '');
  if (rawMeta) {
    try {
      const parsed = JSON.parse(rawMeta);
      if (parsed && typeof parsed === 'object') metaJson = parsed;
    } catch {
      console.error('[record-ws] WARN: --meta-json is not valid JSON, ignoring');
    }
  }
  return {
    url: get('--url', ''),
    agent: get('--agent', ''),
    targetMatches: Number(get('--target', get('--count', '0'))),
    timeoutSec: Number(get('--timeout-sec', '0')),
    summary,
    progress: get('--progress', ''),
    events: get('--events', ''),
    traceDir,
    mapId: Number(get('--map-id', get('--mapid', '0'))),
    progressIntervalMs: Number(get('--progress-ms', '5000')),
    quiet: has('--quiet'),
    // rbrecord/1 unified per-match recording (opt-in; absent => zero behaviour change).
    rbrecordDir: get('--rbrecord-dir', ''),
    rbrecordSampleDir: get('--rbrecord-sample-dir', ''),
    rbrecordSampleEvery: Number(get('--rbrecord-sample-every', '10')),
    rbrecordCapGb: Number(get('--rbrecord-cap-gb', '20')),
    metaJson,
  };
}

function log(cfg, ...parts) {
  if (!cfg.quiet) console.log('[record-ws]', ...parts);
}

function num(attrs, id, fallback = undefined) {
  const v = attrs?.[String(id)];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function cloneAttrs(attrs) {
  return attrs && typeof attrs === 'object' ? { ...attrs } : {};
}

function attrsToFlat(attrs) {
  const pairs = [];
  for (const [k, v] of Object.entries(attrs ?? {})) {
    const attr = Number(k);
    const value = Number(v);
    if (Number.isFinite(attr) && Number.isFinite(value)) pairs.push([attr, value]);
  }
  pairs.sort(([a], [b]) => a - b);
  const flat = [];
  for (const [attr, value] of pairs) flat.push(attr, value);
  return flat;
}

function addRangeValues(attrs, first, last, out) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    const attr = Number(k);
    if (attr < first || attr > last) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.add(Math.round(v));
  }
}

function hasRangeKey(attrs, first, last) {
  for (const k of Object.keys(attrs ?? {})) {
    const attr = Number(k);
    if (attr >= first && attr <= last) return true;
  }
  return false;
}

function referencedMapIdsFromStore(maps) {
  const ids = new Set();
  for (const attrs of maps.values()) {
    const battleMapId = num(attrs, A.PlayerBattleAttributeMapID);
    if (battleMapId && battleMapId > 0) ids.add(Math.round(battleMapId));

    addRangeValues(attrs, A.G_BaseId_0, A.G_BaseId_MAX, ids);
    addRangeValues(attrs, A.G_OutpostId_0, A.G_OutpostId_MAX, ids);
    addRangeValues(attrs, A.G_BuffStationId_0, A.G_BuffStationId_MAX, ids);

    const hasGlobalRefs =
      hasRangeKey(attrs, A.G_BaseId_0, A.G_BaseId_MAX) ||
      hasRangeKey(attrs, A.G_OutpostId_0, A.G_OutpostId_MAX) ||
      hasRangeKey(attrs, A.G_BuffStationId_0, A.G_BuffStationId_MAX);
    if (hasGlobalRefs) addRangeValues(attrs, A.PlayerID_0, A.PlayerID_MAX, ids);
  }
  return ids;
}

function makeLaunchTargetStats() {
  return { outpost: 0, base: 0, unknown: 0 };
}

function addLaunchTargetStats(dst, src) {
  dst.outpost += src?.outpost ?? 0;
  dst.base += src?.base ?? 0;
  dst.unknown += src?.unknown ?? 0;
}

function cloneLaunchTargetStats(src) {
  return {
    outpost: src?.outpost ?? 0,
    base: src?.base ?? 0,
    unknown: src?.unknown ?? 0,
  };
}

function makeTeamStats() {
  return {
    launches_from_dart_ammo: 0,
    launches_from_aerial_remaining: 0,
    launches_by_target: makeLaunchTargetStats(),
    launches_by_target_from_dart_ammo: makeLaunchTargetStats(),
    launches_by_target_from_aerial_remaining: makeLaunchTargetStats(),
    outpost_hits: 0,
    base_hits: 0,
    outpost_damage: 0,
    base_damage: 0,
    suppressed_hits: 0,
  };
}

function makeState(cfg) {
  return {
    cfg,
    startedAt: Date.now(),
    connected: false,
    closed: false,
    frames: 0,
    updates: 0,
    watched: new Set(),
    maps: new Map(),
    lastWatchAt: 0,
    lastProgressAt: 0,
    lastStatus: undefined,
    currentGameTimeMs: 0,
    activeMatchSeen: false,
    currentMatchIndex: 0,
    completedMatches: 0,
    matches: [],
    traces: [],
    traceWrites: [],
    currentTrace: null,
    teamControl: new Map(),
    // root-cause verification accumulators (reset per match in applyStatus):
    occupyMs: new Map(),          // robot mapId -> cumulative ms with IsInFortressOccupyPoint=1
    fortAmmoMs: new Map(),        // robot mapId -> cumulative ms with HasFortressAmmo=1 (leverages 堡垒弹药增益区)
    lastZoneGt: 0,                // last game-time we charged occupy/fort-ammo against
    firstOutpostFallGt: null,     // game-time the FIRST outpost fell (增益区开启, ~outpost-kill)
    scoreboardAtFall: null,       // scoreboard snapshot at that moment (增益区开启 boundary)
    firstOccupyGt: null,          // game-time 占垒 window opens = first robot actually occupies (~4min gate + outpost)
    scoreboardAtOccupy: null,     // scoreboard snapshot when 占垒 opens (correct 占垒-易伤 phase boundary)
    teamStats: new Map([
      [0, makeTeamStats()],
      [1, makeTeamStats()],
    ]),
    // rbrecord/1 per-match state (only populated when cfg.rbrecordDir is set):
    matchTeamStats: null,          // per-match dart accumulator (lifetime teamStats stays intact)
    mapIdsSeenThisMatch: new Set(), // scoreboard-bleed guard: only maps updated this match count
    droppedTimeDeltas: 0,           // occupy/fort-ammo time deltas rejected by the guard (per match)
    forceRewatch: false,            // set at match start to bypass the 500ms follow throttle once
    currentRb: null,                // { index, mapId, startWallMs, startGt, connectMidMatch, events, frames }
    rbWrites: [],                   // pending gzip write promises (awaited in finish())
    rbFiles: [],                    // committed rbrecord descriptors (diagnostics)
    rbCommitted: 0,                 // committed count (drives the sampling copy cadence)
    eventsWritten: 0,
    eventStream: null,
  };
}

function teamStats(state, team) {
  if (!state.teamStats.has(team)) state.teamStats.set(team, makeTeamStats());
  return state.teamStats.get(team);
}

// Per-match dart accumulator (rbrecord/1 fix #4): reset each match; null when rbrecord is off.
function matchTeamStatsFor(state, team) {
  if (!state.matchTeamStats) return null;
  if (!state.matchTeamStats.has(team)) state.matchTeamStats.set(team, makeTeamStats());
  return state.matchTeamStats.get(team);
}

function applyLaunchToStats(stats, source, kind, delta) {
  if (source === 'dart_ammo') {
    stats.launches_from_dart_ammo += delta;
    stats.launches_by_target_from_dart_ammo[kind] += delta;
  } else {
    stats.launches_from_aerial_remaining += delta;
    stats.launches_by_target_from_aerial_remaining[kind] += delta;
  }
}

function targetKind(target) {
  if (target === DART_TARGET.Outpost) return 'outpost';
  if (target === DART_TARGET.Base) return 'base';
  return 'unknown';
}

function selectedLaunchTargetStats(stats) {
  if (stats.launches_from_dart_ammo > 0) return stats.launches_by_target_from_dart_ammo;
  if (stats.launches_from_aerial_remaining > 0) return stats.launches_by_target_from_aerial_remaining;
  return stats.launches_by_target;
}

function finalizeDartStats(stats, overrides = {}) {
  const trueLaunches =
    overrides.trueLaunches ??
    (stats.launches_from_dart_ammo > 0
      ? stats.launches_from_dart_ammo
      : stats.launches_from_aerial_remaining);
  const launchesByTarget = cloneLaunchTargetStats(
    overrides.launchesByTarget ?? selectedLaunchTargetStats(stats)
  );
  const hits = stats.outpost_hits + stats.base_hits;
  return {
    ...stats,
    launches_by_target: launchesByTarget,
    true_launches: trueLaunches,
    effective_hits: hits,
    effective_hit_rate: trueLaunches > 0 ? hits / trueLaunches : null,
    impact_or_suppressed_rate:
      trueLaunches > 0 ? (hits + stats.suppressed_hits) / trueLaunches : null,
  };
}

function summarizeDartMap(teamStatsMap) {
  const byTeam = {};
  const total = makeTeamStats();
  let totalTrueLaunches = 0;
  const entries = teamStatsMap ? [...teamStatsMap.entries()].sort((a, b) => a[0] - b[0]) : [];
  for (const [team, stats] of entries) {
    const teamFinal = finalizeDartStats(stats);
    byTeam[String(team)] = teamFinal;
    totalTrueLaunches += teamFinal.true_launches;

    total.launches_from_dart_ammo += stats.launches_from_dart_ammo;
    total.launches_from_aerial_remaining += stats.launches_from_aerial_remaining;
    addLaunchTargetStats(total.launches_by_target, teamFinal.launches_by_target);
    addLaunchTargetStats(
      total.launches_by_target_from_dart_ammo,
      stats.launches_by_target_from_dart_ammo
    );
    addLaunchTargetStats(
      total.launches_by_target_from_aerial_remaining,
      stats.launches_by_target_from_aerial_remaining
    );
    total.outpost_hits += stats.outpost_hits;
    total.base_hits += stats.base_hits;
    total.outpost_damage += stats.outpost_damage;
    total.base_damage += stats.base_damage;
    total.suppressed_hits += stats.suppressed_hits;
  }
  return {
    source: 'attribute.watchAttributeMaps',
    launch_rule:
      'primary=RealDartAmmoCount decrement on Dart class map; fallback=DartRemainingShots decrement on Aerial map',
    total: finalizeDartStats(total, {
      trueLaunches: totalTrueLaunches,
      launchesByTarget: total.launches_by_target,
    }),
    by_team: byTeam,
  };
}

// Legacy process-lifetime dart summary (unchanged shape; the *_attribute_summary.json + progress
// consumers depend on this). rbrecord per-match summaries use summarizeDartMap(state.matchTeamStats).
function summarizeDart(state) {
  return summarizeDartMap(state.teamStats);
}

function progressPayload(state) {
  const completedMatches = Math.max(state.completedMatches, countTraceMatches(state.cfg.traceDir));
  return {
    schema: 'attribute-watch-recorder/progress/1',
    at: new Date().toISOString(),
    url: state.cfg.url,
    connected: state.connected,
    closed: state.closed,
    elapsed_sec: Math.round((Date.now() - state.startedAt) / 100) / 10,
    frames: state.frames,
    updates: state.updates,
    watched_maps: state.watched.size,
    target_matches: state.cfg.targetMatches,
    completed_matches: completedMatches,
    last_match_status: state.lastStatus ?? null,
    current_game_time_ms: state.currentGameTimeMs,
    dart: summarizeDart(state),
  };
}

function finalPayload(state, reason) {
  const completedMatches = Math.max(state.completedMatches, countTraceMatches(state.cfg.traceDir));
  return {
    schema: 'attribute-watch-recorder/1',
    source: 'attribute.watchAttributeMaps',
    reason,
    generated_at: new Date().toISOString(),
    url: state.cfg.url,
    target_matches: state.cfg.targetMatches,
    completed_matches: completedMatches,
    elapsed_sec: Math.round((Date.now() - state.startedAt) / 100) / 10,
    frames: state.frames,
    updates: state.updates,
    watched_maps: state.watched.size,
    matches: state.matches,
    traces: state.traces,
    dart: summarizeDart(state),
  };
}

async function writeJsonAtomic(file, payload) {
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      lastError = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code) || attempt === 24) break;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

// Binary sibling of writeJsonAtomic (same tmp→rename EPERM/EBUSY retry) for the gzipped rbrecord.
async function writeBufferAtomic(file, buf) {
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, buf);
  let lastError;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      lastError = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code) || attempt === 24) break;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

// Startup FIFO sweep: if the rbrecord dir exceeds --rbrecord-cap-gb, delete oldest
// *.rbrecord.json.gz until under cap. Full-fat rbrecords live on the runner's local disk
// (GIT_CLEAN kept); this bounds them so a night of matches can't fill the volume.
function sweepRbrecordDir(cfg) {
  const dir = cfg.rbrecordDir;
  if (!dir) return;
  const capBytes = Math.max(0, cfg.rbrecordCapGb) * 1024 * 1024 * 1024;
  if (capBytes <= 0) return;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const files = [];
  let total = 0;
  for (const name of names) {
    if (!/\.rbrecord\.json\.gz$/i.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      files.push({ full, name, size: st.size, mtime: st.mtimeMs });
      total += st.size;
    } catch {}
  }
  if (total <= capBytes) return;
  files.sort((a, b) => a.mtime - b.mtime);
  let remaining = total;
  const deleted = [];
  for (const f of files) {
    if (remaining <= capBytes) break;
    try {
      unlinkSync(f.full);
      remaining -= f.size;
      deleted.push(f.name);
    } catch {}
  }
  if (deleted.length > 0) {
    const shown = deleted.slice(0, 8).join(', ');
    log(
      cfg,
      `rbrecord FIFO sweep: cap=${cfg.rbrecordCapGb}GB before=${(total / 1e9).toFixed(2)}GB ` +
        `after=${(remaining / 1e9).toFixed(2)}GB deleted=${deleted.length} [${shown}${deleted.length > 8 ? ', …' : ''}]`
    );
  }
}

// Per-run label for rbrecord filenames: reuse the summary basename (so rbrecords join back to
// the same cell as *_attribute_summary.json), else the meta run_stamp, else the pid.
function rbLabel(cfg) {
  if (cfg.summary) {
    const base = path
      .basename(cfg.summary)
      .replace(/\.json$/i, '')
      .replace(/_attribute_summary$/i, '');
    if (base) return base;
  }
  const runStamp = cfg.metaJson?.run_stamp;
  return runStamp ? `run_${runStamp}` : `run_${process.pid}`;
}

function countTraceMatches(dir) {
  if (!dir) return 0;
  try {
    return readdirSync(dir).filter(name => /\.trace\.json$/i.test(name)).length;
  } catch {
    return 0;
  }
}

function writeEvent(state, event) {
  const full = { at: Date.now(), ...event };
  // rbrecord/1: buffer this match's events slice (only while a match is being recorded).
  if (state.currentRb) state.currentRb.events.push(full);
  if (!state.eventStream) return;
  state.eventsWritten++;
  state.eventStream.write(`${JSON.stringify(full)}\n`);
}

function watch(ws, state, ids, options = {}) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const fresh = [...ids]
    .map(id => Math.round(id))
    .filter(id => Number.isFinite(id) && id > 0 && (options.force || !state.watched.has(id)));
  if (fresh.length === 0) return;
  for (const id of fresh) state.watched.add(id);
  ws.send(
    JSON.stringify({
      type: 0,
      id: state.watched.size,
      method: METHOD_WATCH_ATTRIBUTE_MAPS,
      params: { attribute_map_ids: fresh, watch_type: WATCH_CONTINUOUS },
    })
  );
}

function beginTrace(state, mapId) {
  if (!state.cfg.traceDir || state.currentTrace) return;
  state.currentTrace = {
    index: state.currentMatchIndex,
    mapId: Number.isFinite(state.cfg.mapId) && state.cfg.mapId > 0 ? state.cfg.mapId : mapId,
    startedAt: Date.now(),
    startGt: state.currentGameTimeMs,
    frames: [],
  };
}

// Compact one WS frame's updates into the shared [mapId, flatAttrPairs, marker(0=keyframe|1=delta)]
// form used by BOTH the legacy trace and rbrecord frames (trace-replayer convertCompact reads it).
function compactUpdates(updates) {
  const compact = [];
  for (const update of updates) {
    const mapId = update?.attribute_map_id;
    if (!Number.isFinite(mapId)) continue;
    const flat = attrsToFlat(update.attributes);
    if (flat.length === 0) continue;
    compact.push([mapId, flat, update.sync_type === 0 ? 0 : 1]);
  }
  return compact;
}

function appendTraceFrame(state, updates) {
  const trace = state.currentTrace;
  if (!trace) return;
  const compact = compactUpdates(updates);
  if (compact.length > 0) trace.frames.push(compact);
}

// rbrecord/1 frame buffer. First frame of each match is a synthesized keyframe (full state of all
// watched maps at match start); every later WS frame is a [relMs, gtMs, updates] tuple where relMs is
// wall-time since match start and gtMs is the game-time captured at frame arrival (after applyUpdate).
function beginRb(state, mapId, connectMidMatch) {
  if (!state.cfg.rbrecordDir) return;
  const startGt = Number.isFinite(state.currentGameTimeMs) ? Math.round(state.currentGameTimeMs) : 0;
  const keyframe = [];
  for (const [mid, attrs] of state.maps) {
    const flat = attrsToFlat(attrs);
    if (flat.length === 0) continue;
    keyframe.push([mid, flat, 0]);
  }
  state.currentRb = {
    index: state.currentMatchIndex,
    mapId: Number.isFinite(state.cfg.mapId) && state.cfg.mapId > 0 ? state.cfg.mapId : mapId,
    startWallMs: Date.now(),
    startGt,
    connectMidMatch: !!connectMidMatch,
    events: [],
    frames: [[0, startGt, keyframe]],
  };
}

function appendRbFrame(state, updates) {
  const rb = state.currentRb;
  if (!rb) return;
  const compact = compactUpdates(updates);
  if (compact.length === 0) return;
  const relMs = Math.max(0, Date.now() - rb.startWallMs);
  const gtMs = Number.isFinite(state.currentGameTimeMs) ? Math.round(state.currentGameTimeMs) : null;
  rb.frames.push([relMs, gtMs, compact]);
}

// Commit the buffered match as <label>_m<NNN>.rbrecord.json.gz (gzip in RAM, tmp→rename). matchSummary
// is THIS match's summary (same shape as matches[] PLUS per-match dart). Every Nth commit is also
// copied to the sample dir for artifact upload.
function commitRb(state, matchSummary, opts = {}) {
  const rb = state.currentRb;
  if (!rb || !state.cfg.rbrecordDir) return;
  const partial = !!opts.partial;
  const metaJson = state.cfg.metaJson ?? {};
  const meta = {
    recorder: `record-ws.mjs/${RECORDER_VERSION}`,
    generated_at: new Date().toISOString(),
    ...metaJson,
    match_index: rb.index,
    map_id: rb.mapId,
    partial,
    connect_mid_match: rb.connectMidMatch,
    dropped_time_deltas: state.droppedTimeDeltas ?? 0,
  };
  const summary = { ...matchSummary, dart: summarizeDartMap(state.matchTeamStats) };
  const payload = { schema: 'rbrecord/1', meta, summary, events: rb.events, frames: rb.frames };
  const label = rbLabel(state.cfg);
  const name = `${label}_m${String(rb.index).padStart(3, '0')}.rbrecord.json.gz`;
  const file = path.join(state.cfg.rbrecordDir, name);
  state.rbCommitted++;
  const doSample =
    state.cfg.rbrecordSampleDir &&
    state.cfg.rbrecordSampleEvery > 0 &&
    state.rbCommitted % state.cfg.rbrecordSampleEvery === 0;
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const write = writeBufferAtomic(file, gz)
    .then(async () => {
      state.rbFiles.push({ match: rb.index, file, partial, bytes: gz.length });
      if (doSample) {
        await mkdir(state.cfg.rbrecordSampleDir, { recursive: true });
        await copyFile(file, path.join(state.cfg.rbrecordSampleDir, name));
      }
    })
    .catch(err => {
      log(state.cfg, `rbrecord write failed (${name}): ${err?.message ?? err}`);
    });
  state.rbWrites.push(write);
}

function flushTrace(state, matchSummary) {
  const trace = state.currentTrace;
  if (!trace || !state.cfg.traceDir) return;
  state.currentTrace = null;
  const name = `iter-${String(trace.index).padStart(3, '0')}.trace.json`;
  const file = path.join(state.cfg.traceDir, name);
  const payload = {
    v: 3,
    src: 'attribute-watch-recorder',
    fmt: 'compact-delta',
    mapId: trace.mapId,
    frameCount: trace.frames.length,
    durMs: Date.now() - trace.startedAt,
    gtMs: Math.max(0, state.currentGameTimeMs - trace.startGt),
    summary: {
      completed_matches: state.completedMatches,
      end_game_time_ms: state.currentGameTimeMs,
      match: matchSummary.index,
    },
    frames: trace.frames,
  };
  const write = writeJsonAtomic(file, payload).then(() => {
    state.traces.push({
      match: trace.index,
      file,
      frames: trace.frames.length,
      gt_ms: payload.gtMs,
    });
  });
  state.traceWrites.push(write);
}

// Snapshot both teams' base + outpost Health at match end. Raw LAN-observable match
// state (the recorder already follows these maps via G_BaseId_0+team / G_OutpostId_0+team).
// This is the "who is ahead" a spectator sees; the winner tiebreak (a game-ruleset
// concern) is left to the private consumer — the monitor only exposes observable hp.
function snapshotBuildingHp(state, globalAttrs) {
  const out = {};
  for (const team of [0, 1]) {
    const baseId = num(globalAttrs, A.G_BaseId_0 + team);
    const outpostId = num(globalAttrs, A.G_OutpostId_0 + team);
    const baseMap = baseId ? state.maps.get(Math.round(baseId)) : null;
    const outpostMap = outpostId ? state.maps.get(Math.round(outpostId)) : null;
    out[`t${team}_base_hp`] = baseMap ? (num(baseMap, A.Health) ?? null) : null;
    out[`t${team}_base_hp_max`] = baseMap ? (num(baseMap, A.HealthMax) ?? null) : null;
    out[`t${team}_outpost_hp`] = outpostMap ? (num(outpostMap, A.Health) ?? null) : null;
    out[`t${team}_outpost_hp_max`] = outpostMap ? (num(outpostMap, A.HealthMax) ?? null) : null;
  }
  return out;
}

// Snapshot the scoreboard a spectator dashboard shows at match end: per-robot combat
// (team/class/kills/deaths/damage-taken) and per-team economy (coins) + rune activations.
// Iterates every followed map — robot maps carry TeamID + KillCount/DeathCount; economy/
// rune attributes are aggregated per team wherever they appear. Observable match state,
// same category as the dart telemetry and building HP already exposed here.
function snapshotScoreboard(state) {
  const vehicles = [];
  const teams = {};
  const team = t => {
    if (!teams[t]) teams[t] = { vehicles: 0, kills: 0, deaths: 0, damage_taken: 0, coins: null, support_coins: 0, rune_arm: 0, rune_light: 0, base_damage: null, outpost_rebuild: null, occupy_ms: 0, fort_ammo_ms: 0, fort_ammo: null, fort_ammo_cap: null };
    return teams[t];
  };
  // rbrecord/1 fix: state.maps is never cleared, so last match's vehicles bleed in. When rbrecord is
  // on, only count maps actually updated THIS match (mapIdsSeenThisMatch). Off => unchanged behaviour.
  const bleedGuard = !!state.cfg.rbrecordDir;
  for (const [mapId, m] of state.maps) {
    if (bleedGuard && !state.mapIdsSeenThisMatch.has(mapId)) continue;
    const tm = num(m, A.TeamID);
    if (tm !== 0 && tm !== 1) continue;
    const kills = num(m, A.KillCount);
    const deaths = num(m, A.DeathCount);
    if (kills !== undefined || deaths !== undefined) {
      const occMs = Math.round(state.occupyMs.get(mapId) ?? 0);
      const faMs = Math.round(state.fortAmmoMs.get(mapId) ?? 0);
      const v = {
        map_id: mapId,
        team: tm,
        class: num(m, A.Class) ?? null,
        kills: Math.round(kills ?? 0),
        deaths: Math.round(deaths ?? 0),
        damage_taken: Math.round(num(m, A.DamageTakenTotal) ?? 0),
        occupy_ms: occMs,
        fort_ammo_ms: faMs,
        health: num(m, A.Health) ?? null,
      };
      vehicles.push(v);
      const T = team(tm);
      T.vehicles++; T.kills += v.kills; T.deaths += v.deaths; T.damage_taken += v.damage_taken; T.occupy_ms += occMs; T.fort_ammo_ms += faMs;
    }
    const coins = num(m, A.TM_Coins);
    if (coins !== undefined) { const T = team(tm); T.coins = Math.max(T.coins ?? 0, Math.round(coins)); }
    const baseDmg = num(m, A.TM_BaseDamageCount);
    if (baseDmg !== undefined) { const T = team(tm); T.base_damage = Math.max(T.base_damage ?? 0, Math.round(baseDmg)); }
    const rebuild = num(m, A.TM_OutPostRebuildCount);
    if (rebuild !== undefined) { const T = team(tm); T.outpost_rebuild = Math.max(T.outpost_rebuild ?? 0, Math.round(rebuild)); }
    const fortAmmo = num(m, A.TM_FortAmmo);
    if (fortAmmo !== undefined) { const T = team(tm); T.fort_ammo = Math.round(fortAmmo); }
    const fortCap = num(m, A.TM_FortAmmoCapMax);
    if (fortCap !== undefined) { const T = team(tm); T.fort_ammo_cap = Math.round(fortCap); }
    const sc = (num(m, A.TM_SupportCoins_70) ?? 0) + (num(m, A.TM_SupportCoins_140) ?? 0);
    if (sc) team(tm).support_coins = Math.max(team(tm).support_coins, Math.round(sc));
    const arm = num(m, A.BigRuneBuffArmCount);
    const light = num(m, A.BigRuneBuffLightCount);
    if (arm !== undefined) team(tm).rune_arm += Math.round(arm);
    if (light !== undefined) team(tm).rune_light += Math.round(light);
  }
  return { vehicles, teams };
}

// Charge per-frame zone time to robots: occupy time (占垒 point, IsInFortressOccupyPoint) and
// fortress-ammo-leverage time (at the 堡垒增益区 with fortress ammo, HasFortressAmmo — remote teams
// exploit this to counterattack from home; melee abandons it to push).
function accumulateOccupy(state) {
  const gt = state.currentGameTimeMs;
  const delta = gt - state.lastZoneGt;
  // rbrecord/1 fix: widen the guard to 30000ms (was 5000) so normal but sparse WS frames don't
  // silently drop occupy/fort-ammo time; count deltas the guard still rejects into a meta diagnostic.
  // Off => keep the original 5000ms cap byte-for-byte (occupy_ms in the legacy summary is unchanged).
  const cap = state.cfg.rbrecordDir ? 30000 : 5000;
  if (delta > 0 && delta < cap) { // guard match resets / large gaps
    for (const [mapId, m] of state.maps) {
      const tm = num(m, A.TeamID);
      if (tm !== 0 && tm !== 1) continue;
      if (num(m, A.IsInFortressOccupyPoint)) {
        state.occupyMs.set(mapId, (state.occupyMs.get(mapId) ?? 0) + delta);
      }
      if (num(m, A.HasFortressAmmo)) {
        state.fortAmmoMs.set(mapId, (state.fortAmmoMs.get(mapId) ?? 0) + delta);
      }
    }
  } else if (state.cfg.rbrecordDir && delta !== 0) {
    // delta<0 (match reset) or delta>=cap (time jump) — record how much charged time we skipped.
    state.droppedTimeDeltas = (state.droppedTimeDeltas ?? 0) + 1;
  }
  state.lastZoneGt = gt;
}

// Snapshot the scoreboard the instant the FIRST outpost falls (堡垒增益区开启, ~outpost-kill, early).
function checkOutpostFall(state) {
  if (state.firstOutpostFallGt !== null) return;
  let g = null;
  for (const m of state.maps.values()) { if (num(m, A.G_OutpostId_0) !== undefined) { g = m; break; } }
  if (!g) return;
  for (const t of [0, 1]) {
    const oid = num(g, A.G_OutpostId_0 + t);
    const om = oid ? state.maps.get(Math.round(oid)) : null;
    const hp = om ? num(om, A.Health) : undefined;
    if (hp !== undefined && hp <= 0) {
      state.firstOutpostFallGt = state.currentGameTimeMs;
      state.scoreboardAtFall = snapshotScoreboard(state);
      return;
    }
  }
}

// Snapshot the scoreboard when the 占垒 (fortress-occupy) window actually OPENS — the correct
// boundary for the 占垒-易伤 split. Occupy opens on a ~4min time-gate AFTER the outpost fell (NOT at
// outpost-fall = 增益区), so use the first frame any robot is actually on the occupy point.
function checkOccupyOpen(state) {
  if (state.firstOccupyGt !== null) return;
  for (const m of state.maps.values()) {
    const tm = num(m, A.TeamID);
    if ((tm === 0 || tm === 1) && num(m, A.IsInFortressOccupyPoint)) {
      state.firstOccupyGt = state.currentGameTimeMs;
      state.scoreboardAtOccupy = snapshotScoreboard(state);
      return;
    }
  }
}

function applyStatus(state, mapId, prev, cur) {
  const status = num(cur, A.G_CurMatchStatus);
  if (status === undefined) return;
  const prevStatus = num(prev, A.G_CurMatchStatus, state.lastStatus);
  state.lastStatus = status;
  state.currentGameTimeMs = num(cur, A.G_CurGameTime, state.currentGameTimeMs) ?? 0;

  if ((status === 1 || status === 2) && !state.activeMatchSeen) {
    state.activeMatchSeen = true;
    state.currentMatchIndex++;
    // reset per-match root-cause accumulators
    state.occupyMs = new Map();
    state.fortAmmoMs = new Map();
    state.lastZoneGt = state.currentGameTimeMs;
    state.firstOutpostFallGt = null;
    state.scoreboardAtFall = null;
    state.firstOccupyGt = null;
    state.scoreboardAtOccupy = null;
    beginTrace(state, mapId);
    // rbrecord/1: reset per-match accumulators and open a fresh frame buffer. connect_mid_match is
    // true when we never observed a pre-match status 0 (prevStatus undefined => recorder attached
    // mid-match). beginRb must precede the match_start writeEvent so it lands in this match's slice.
    if (state.cfg.rbrecordDir) {
      state.matchTeamStats = new Map([
        [0, makeTeamStats()],
        [1, makeTeamStats()],
      ]);
      state.mapIdsSeenThisMatch = new Set();
      state.droppedTimeDeltas = 0;
      state.forceRewatch = true;
      beginRb(state, mapId, prevStatus === undefined);
    }
    writeEvent(state, {
      kind: 'match_start',
      match: state.currentMatchIndex,
      map_id: mapId,
      status,
      gt: state.currentGameTimeMs,
    });
  }

  if (
    status === 0 &&
    prevStatus !== 0 &&
    state.activeMatchSeen &&
    state.currentMatchIndex > 0
  ) {
    state.completedMatches++;
    const matchSummary = {
      index: state.currentMatchIndex,
      completed_at: new Date().toISOString(),
      end_game_time_ms: state.currentGameTimeMs,
      buildings: snapshotBuildingHp(state, cur),
      scoreboard: snapshotScoreboard(state),
      first_outpost_fall_gt: state.firstOutpostFallGt,
      scoreboard_at_fall: state.scoreboardAtFall,
      first_occupy_gt: state.firstOccupyGt,
      scoreboard_at_occupy: state.scoreboardAtOccupy,
    };
    state.matches.push(matchSummary);
    flushTrace(state, matchSummary);
    writeEvent(state, {
      kind: 'match_complete',
      match: state.currentMatchIndex,
      completed_matches: state.completedMatches,
      map_id: mapId,
      gt: state.currentGameTimeMs,
      buildings: matchSummary.buildings,
    });
    // rbrecord/1: commit AFTER match_complete is buffered so the events slice is whole.
    if (state.currentRb) {
      commitRb(state, matchSummary, { partial: false });
      state.currentRb = null;
    }
    state.activeMatchSeen = false;
  }
}

// Locate the global attribute map (carries match status + G_BaseId/G_OutpostId refs) for a
// partial-commit building-HP snapshot when finish() fires mid-match.
function findGlobalAttrs(state) {
  for (const m of state.maps.values()) {
    if (num(m, A.G_CurMatchStatus) !== undefined || num(m, A.G_BaseId_0) !== undefined) return m;
  }
  return null;
}

// rbrecord/1 fix #2: on process teardown, commit the in-flight (uncompleted) match instead of
// losing it. meta.partial=true; also appended to the legacy matches[] with a partial flag. Does NOT
// bump completedMatches (exit-code semantics unchanged).
function finishPartialRb(state) {
  if (!state.cfg.rbrecordDir) return;
  if (!state.currentRb || !state.activeMatchSeen || state.currentMatchIndex <= 0) return;
  const globalAttrs = findGlobalAttrs(state) ?? {};
  const matchSummary = {
    index: state.currentMatchIndex,
    completed_at: new Date().toISOString(),
    end_game_time_ms: state.currentGameTimeMs,
    buildings: snapshotBuildingHp(state, globalAttrs),
    scoreboard: snapshotScoreboard(state),
    first_outpost_fall_gt: state.firstOutpostFallGt,
    scoreboard_at_fall: state.scoreboardAtFall,
    first_occupy_gt: state.firstOccupyGt,
    scoreboard_at_occupy: state.scoreboardAtOccupy,
    partial: true,
  };
  state.matches.push(matchSummary);
  commitRb(state, matchSummary, { partial: true });
  state.currentRb = null;
}

function applyLaunchDelta(state, team, source, prevValue, curValue) {
  if (team !== 0 && team !== 1) return;
  if (prevValue === undefined || curValue === undefined) return;
  if (curValue < 0 || prevValue < 0) return;
  const delta = prevValue - curValue;
  if (delta <= 0) return;

  const control = state.teamControl.get(team) ?? {};
  const kind = targetKind(control.target);
  applyLaunchToStats(teamStats(state, team), source, kind, delta);
  // rbrecord/1: mirror into the per-match dart accumulator (lifetime teamStats stays untouched).
  if (state.cfg.rbrecordDir) {
    const ms = matchTeamStatsFor(state, team);
    if (ms) applyLaunchToStats(ms, source, kind, delta);
  }
  writeEvent(state, {
    kind: 'dart_launch',
    source,
    team,
    match: state.currentMatchIndex,
    count: delta,
    target: kind,
    target_raw: control.target ?? null,
    base_mode: control.baseMode ?? null,
    before: prevValue,
    after: curValue,
    gt: state.currentGameTimeMs,
  });
}

function applyDartMap(state, prev, cur) {
  const cls = num(cur, A.Class);
  const team = num(cur, A.TeamID);
  if (team !== 0 && team !== 1) return;

  if (cls === CLASS.Aerial) {
    const target = num(cur, A.DartControlTarget);
    const baseMode = num(cur, A.DartBaseTargetMode);
    const gate = num(cur, A.DartGateReady);
    state.teamControl.set(team, { target, baseMode, gate });
    applyLaunchDelta(
      state,
      team,
      'aerial_remaining',
      num(prev, A.DartRemainingShots),
      num(cur, A.DartRemainingShots)
    );
  } else if (cls === CLASS.Dart) {
    applyLaunchDelta(
      state,
      team,
      'dart_ammo',
      num(prev, A.RealDartAmmoCount, num(prev, A.AmmoDartCount)),
      num(cur, A.RealDartAmmoCount, num(cur, A.AmmoDartCount))
    );
  }
}

function addPositiveCounterDelta(prev, cur, attr, apply) {
  const before = num(prev, attr);
  const after = num(cur, attr);
  if (before === undefined || after === undefined) return;
  const delta = after - before;
  if (delta <= 0) return;
  apply(delta);
}

function bumpDartHitCounters(stats, prev, cur) {
  addPositiveCounterDelta(prev, cur, A.TM_DartOutpostHitCount, delta => {
    stats.outpost_hits += delta;
  });
  addPositiveCounterDelta(prev, cur, A.TM_DartBaseHitCount, delta => {
    stats.base_hits += delta;
  });
  addPositiveCounterDelta(prev, cur, A.TM_DartOutpostDamageTotal, delta => {
    stats.outpost_damage += delta;
  });
  addPositiveCounterDelta(prev, cur, A.TM_DartBaseDamageTotal, delta => {
    stats.base_damage += delta;
  });
  addPositiveCounterDelta(prev, cur, A.TM_DartSuppressedHitCount, delta => {
    stats.suppressed_hits += delta;
  });
}

function applyDartTeamStats(state, prev, cur) {
  const team = num(cur, A.TeamID);
  if (team !== 0 && team !== 1) return;
  bumpDartHitCounters(teamStats(state, team), prev, cur);
  // rbrecord/1: mirror hit/damage counters into the per-match accumulator.
  if (state.cfg.rbrecordDir) {
    const ms = matchTeamStatsFor(state, team);
    if (ms) bumpDartHitCounters(ms, prev, cur);
  }
}

function applyUpdate(state, update) {
  const mapId = update?.attribute_map_id;
  if (!Number.isFinite(mapId)) return;

  const prev = state.maps.get(mapId) ?? {};
  const attrs = cloneAttrs(update.attributes);
  const cur = update.sync_type === 1 ? { ...prev, ...attrs } : attrs;
  state.maps.set(mapId, cur);
  state.updates++;

  applyStatus(state, mapId, prev, cur);
  // rbrecord/1 scoreboard-bleed guard: record maps touched THIS match (after applyStatus, so a
  // match-start reset of the set doesn't drop the status map that triggered it).
  if (state.cfg.rbrecordDir) state.mapIdsSeenThisMatch.add(mapId);
  applyDartMap(state, prev, cur);
  applyDartTeamStats(state, prev, cur);
}

async function discoverUrlFromAgent(agent) {
  const httpUrl = agent.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/$/, '');
  const response = await fetch(`${httpUrl}/processes`);
  if (!response.ok) throw new Error(`agent process discovery failed: HTTP ${response.status}`);
  const data = await response.json();
  const process = data?.processes?.find?.(p => p?.wsUrl) ?? data?.processes?.[0];
  if (!process?.wsUrl) throw new Error('agent has no live process with wsUrl');
  return process.wsUrl;
}

async function main() {
  // Crash diagnostics: a bare "[record-ws] ERROR:" with an empty message is undebuggable from the
  // CI err.log — surface the real failure (stack/code) for uncaught throws, unhandled rejections,
  // and WS-level errors so a probe death names its cause.
  // onFatal is wired to the reconnect path once the socket machinery below exists: undici's
  // WebSocket can THROW from its own close handling (observed: empty-message TypeError at
  // #onSocketClose) instead of emitting 'error' — treat that exactly like a socket loss.
  let onFatal = null;
  process.on('uncaughtException', e => {
    console.error('[record-ws] UNCAUGHT:', e?.stack ?? e);
    onFatal?.(e);
  });
  process.on('unhandledRejection', e => console.error('[record-ws] UNHANDLED_REJECTION:', e?.stack ?? e));
  const cfg = parseArgs();
  if (!cfg.url && cfg.agent) cfg.url = await discoverUrlFromAgent(cfg.agent);
  if (!cfg.url) {
    console.error('usage: node record-ws.mjs --url ws://127.0.0.1:<port> [--target N] [--progress file] [--out file-or-dir]');
    process.exit(2);
  }
  if (!Number.isFinite(cfg.targetMatches) || cfg.targetMatches < 0) {
    throw new Error('--target/--count must be >= 0');
  }
  if (cfg.traceDir) await mkdir(cfg.traceDir, { recursive: true });
  if (cfg.rbrecordDir) {
    await mkdir(cfg.rbrecordDir, { recursive: true });
    sweepRbrecordDir(cfg); // FIFO to --rbrecord-cap-gb before we start writing new ones
  }

  const state = makeState(cfg);
  if (cfg.events) {
    await mkdir(path.dirname(cfg.events), { recursive: true });
    state.eventStream = createWriteStream(cfg.events, { flags: 'w', encoding: 'utf8' });
  }

  log(cfg, `connecting ${cfg.url}`);
  // Reconnect-and-resume: node's built-in (undici) WebSocket occasionally dies minutes into a
  // recording with an empty-message TypeError from #onSocketClose (observed twice across ~180
  // probe runs), and fleet runs can also hit real transient socket drops. Losing the socket must
  // not lose the run: keep in-memory state (maps/matches/rbrecord buffers survive), clear the
  // watched set, and re-subscribe on a fresh socket. Consecutive-failure budget; any received
  // frame refills it.
  const MAX_CONSECUTIVE_RECONNECTS = 5;
  let ws = null;
  let finishing = false;
  let bootstrapRetry = null;
  let reconnectsLeft = MAX_CONSECUTIVE_RECONNECTS;
  let reconnectTimer = null;
  let reconnects = 0;

  function scheduleReconnect(why) {
    if (finishing || reconnectTimer) return;
    if (bootstrapRetry) {
      clearInterval(bootstrapRetry);
      bootstrapRetry = null;
    }
    state.connected = false;
    if (reconnectsLeft <= 0) {
      const ok = cfg.targetMatches <= 0 || state.completedMatches >= cfg.targetMatches;
      void finish(ok ? 'socket_lost' : 'socket_lost_before_target', ok ? 0 : 1);
      return;
    }
    reconnectsLeft--;
    reconnects++;
    console.error(
      `[record-ws] socket lost (${why}) — reconnecting in 2s (${reconnectsLeft} attempts left, ` +
        `frames=${state.frames} completed=${state.completedMatches}/${cfg.targetMatches})`
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
    reconnectTimer.unref?.();
  }

  async function finish(reason, code) {
    if (finishing) return;
    finishing = true;
    state.closed = true;
    try {
      // rbrecord/1 fix #2: flush the in-flight match (partial=true) BEFORE finalPayload so it also
      // lands in the legacy matches[]. No-op unless rbrecord is enabled and a match is active.
      finishPartialRb(state);
      await Promise.allSettled([...state.traceWrites, ...state.rbWrites]);
      await writeJsonAtomic(cfg.progress, progressPayload(state));
      await writeJsonAtomic(cfg.summary, finalPayload(state, reason));
    } finally {
      if (state.eventStream) state.eventStream.end();
      if (bootstrapRetry) clearInterval(bootstrapRetry);
      try {
        ws.close();
      } catch {}
    }
    log(cfg, `done reason=${reason} completed=${state.completedMatches}/${cfg.targetMatches}`);
    process.exitCode = code;
  }

  const timeout =
    cfg.timeoutSec > 0
      ? setTimeout(() => {
          void finish('timeout', state.completedMatches >= cfg.targetMatches ? 0 : 1);
        }, cfg.timeoutSec * 1000)
      : null;

  function connect() {
    if (finishing) return;
    // Fresh socket => the server-side watch registrations are gone; clear our bookkeeping so
    // watch() re-subscribes everything (the FullSync snapshots then rebuild/refresh state.maps).
    state.watched.clear();
    const sock = new WebSocket(cfg.url);
    ws = sock;

  sock.addEventListener('open', () => {
    if (sock !== ws || finishing) return;
    state.connected = true;
    watch(sock, state, DEFAULT_WATCH_MAP_IDS);
    if (reconnects > 0) watch(sock, state, referencedMapIdsFromStore(state.maps), { force: true });
    bootstrapRetry = setInterval(() => {
      if (state.frames > 0 && state.connected) {
        if (bootstrapRetry) clearInterval(bootstrapRetry);
        bootstrapRetry = null;
        return;
      }
      watch(sock, state, DEFAULT_WATCH_MAP_IDS, { force: true });
    }, 1000);
    bootstrapRetry.unref?.();
    log(cfg, `open, watching ${DEFAULT_WATCH_MAP_IDS.length} bootstrap maps${reconnects > 0 ? ` (reconnect #${reconnects})` : ''}`);
  });

  sock.addEventListener('message', ev => {
    if (sock !== ws || finishing) return;
    // Healthy traffic refills the consecutive-failure budget.
    reconnectsLeft = MAX_CONSECUTIVE_RECONNECTS;
    const data = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg?.method !== METHOD_WATCH_ATTRIBUTE_MAPS_RESULT) return;
    const updates = msg.params?.watch_attribute_maps_results;
    if (!Array.isArray(updates)) return;
    state.frames++;
    if (bootstrapRetry) {
      clearInterval(bootstrapRetry);
      bootstrapRetry = null;
    }
    appendTraceFrame(state, updates);
    for (const update of updates) applyUpdate(state, update);
    // rbrecord/1: append this frame AFTER applyUpdate so gtMs reflects the frame that just arrived.
    appendRbFrame(state, updates);
    accumulateOccupy(state);
    checkOutpostFall(state);
    checkOccupyOpen(state);

    const now = Date.now();
    // rbrecord/1 fix #6: on match start, force one immediate re-watch of every referenced map so the
    // boundary keyframe/first frames aren't missing maps still stuck behind the 500ms follow throttle.
    if (state.forceRewatch) {
      state.forceRewatch = false;
      watch(sock, state, referencedMapIdsFromStore(state.maps), { force: true });
      state.lastWatchAt = now;
    }
    if (now - state.lastWatchAt >= 500) {
      state.lastWatchAt = now;
      watch(sock, state, referencedMapIdsFromStore(state.maps));
    }
    if (cfg.progress && now - state.lastProgressAt >= cfg.progressIntervalMs) {
      state.lastProgressAt = now;
      void writeJsonAtomic(cfg.progress, progressPayload(state));
    }
    if (cfg.targetMatches > 0 && state.completedMatches >= cfg.targetMatches) {
      if (timeout) clearTimeout(timeout);
      void finish('target_reached', 0);
    }
  });

  sock.addEventListener('close', () => {
    if (sock !== ws || finishing) return;
    if (cfg.targetMatches > 0 && state.completedMatches >= cfg.targetMatches) {
      if (timeout) clearTimeout(timeout);
      void finish('closed', 0);
      return;
    }
    scheduleReconnect('closed');
  });

  sock.addEventListener('error', ev => {
    if (sock !== ws) return;
    const err = ev?.error ?? ev?.message ?? ev;
    console.error(
      '[record-ws] ERROR:',
      err?.message ?? err,
      err?.code ?? '',
      err?.stack ? `\n${err.stack}` : '',
      `frames=${state.frames} updates=${state.updates} elapsed=${Math.round((Date.now() - state.startedAt) / 1000)}s`
    );
    scheduleReconnect('error');
  });
  }

  onFatal = e => {
    if (finishing) return;
    if (/undici|websocket/i.test(String(e?.stack ?? e))) scheduleReconnect('uncaught');
  };

  connect();
}

main().catch(err => {
  console.error('[record-ws] ERROR:', err?.message ?? err);
  process.exit(1);
});
