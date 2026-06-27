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

import { createWriteStream, readdirSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

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
    teamStats: new Map([
      [0, makeTeamStats()],
      [1, makeTeamStats()],
    ]),
    eventsWritten: 0,
    eventStream: null,
  };
}

function teamStats(state, team) {
  if (!state.teamStats.has(team)) state.teamStats.set(team, makeTeamStats());
  return state.teamStats.get(team);
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

function summarizeDart(state) {
  const byTeam = {};
  const total = makeTeamStats();
  let totalTrueLaunches = 0;
  for (const [team, stats] of [...state.teamStats.entries()].sort((a, b) => a[0] - b[0])) {
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

function countTraceMatches(dir) {
  if (!dir) return 0;
  try {
    return readdirSync(dir).filter(name => /\.trace\.json$/i.test(name)).length;
  } catch {
    return 0;
  }
}

function writeEvent(state, event) {
  if (!state.eventStream) return;
  state.eventsWritten++;
  state.eventStream.write(`${JSON.stringify({ at: Date.now(), ...event })}\n`);
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

function appendTraceFrame(state, updates) {
  const trace = state.currentTrace;
  if (!trace) return;
  const compact = [];
  for (const update of updates) {
    const mapId = update?.attribute_map_id;
    if (!Number.isFinite(mapId)) continue;
    const flat = attrsToFlat(update.attributes);
    if (flat.length === 0) continue;
    compact.push([mapId, flat, update.sync_type === 0 ? 0 : 1]);
  }
  if (compact.length > 0) trace.frames.push(compact);
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

function applyStatus(state, mapId, prev, cur) {
  const status = num(cur, A.G_CurMatchStatus);
  if (status === undefined) return;
  const prevStatus = num(prev, A.G_CurMatchStatus, state.lastStatus);
  state.lastStatus = status;
  state.currentGameTimeMs = num(cur, A.G_CurGameTime, state.currentGameTimeMs) ?? 0;

  if ((status === 1 || status === 2) && !state.activeMatchSeen) {
    state.activeMatchSeen = true;
    state.currentMatchIndex++;
    beginTrace(state, mapId);
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
    };
    state.matches.push(matchSummary);
    flushTrace(state, matchSummary);
    writeEvent(state, {
      kind: 'match_complete',
      match: state.currentMatchIndex,
      completed_matches: state.completedMatches,
      map_id: mapId,
      gt: state.currentGameTimeMs,
    });
    state.activeMatchSeen = false;
  }
}

function applyLaunchDelta(state, team, source, prevValue, curValue) {
  if (team !== 0 && team !== 1) return;
  if (prevValue === undefined || curValue === undefined) return;
  if (curValue < 0 || prevValue < 0) return;
  const delta = prevValue - curValue;
  if (delta <= 0) return;

  const control = state.teamControl.get(team) ?? {};
  const kind = targetKind(control.target);
  const stats = teamStats(state, team);
  if (source === 'dart_ammo') {
    stats.launches_from_dart_ammo += delta;
    stats.launches_by_target_from_dart_ammo[kind] += delta;
  } else {
    stats.launches_from_aerial_remaining += delta;
    stats.launches_by_target_from_aerial_remaining[kind] += delta;
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

function applyDartTeamStats(state, prev, cur) {
  const team = num(cur, A.TeamID);
  if (team !== 0 && team !== 1) return;
  const stats = teamStats(state, team);
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

function applyUpdate(state, update) {
  const mapId = update?.attribute_map_id;
  if (!Number.isFinite(mapId)) return;

  const prev = state.maps.get(mapId) ?? {};
  const attrs = cloneAttrs(update.attributes);
  const cur = update.sync_type === 1 ? { ...prev, ...attrs } : attrs;
  state.maps.set(mapId, cur);
  state.updates++;

  applyStatus(state, mapId, prev, cur);
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

  const state = makeState(cfg);
  if (cfg.events) {
    await mkdir(path.dirname(cfg.events), { recursive: true });
    state.eventStream = createWriteStream(cfg.events, { flags: 'w', encoding: 'utf8' });
  }

  log(cfg, `connecting ${cfg.url}`);
  const ws = new WebSocket(cfg.url);
  let finishing = false;
  let bootstrapRetry = null;

  async function finish(reason, code) {
    if (finishing) return;
    finishing = true;
    state.closed = true;
    try {
      await Promise.allSettled(state.traceWrites);
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

  ws.on('open', () => {
    state.connected = true;
    watch(ws, state, DEFAULT_WATCH_MAP_IDS);
    bootstrapRetry = setInterval(() => {
      if (state.frames > 0) {
        if (bootstrapRetry) clearInterval(bootstrapRetry);
        bootstrapRetry = null;
        return;
      }
      watch(ws, state, DEFAULT_WATCH_MAP_IDS, { force: true });
    }, 1000);
    bootstrapRetry.unref?.();
    log(cfg, `open, watching ${DEFAULT_WATCH_MAP_IDS.length} bootstrap maps`);
  });

  ws.on('message', data => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
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

    const now = Date.now();
    if (now - state.lastWatchAt >= 500) {
      state.lastWatchAt = now;
      watch(ws, state, referencedMapIdsFromStore(state.maps));
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

  ws.on('close', () => {
    if (timeout) clearTimeout(timeout);
    if (!finishing) {
      const ok = cfg.targetMatches <= 0 || state.completedMatches >= cfg.targetMatches;
      void finish(ok ? 'closed' : 'closed_before_target', ok ? 0 : 1);
    }
  });

  ws.on('error', err => {
    console.error('[record-ws] ERROR:', err?.message ?? err);
    if (timeout) clearTimeout(timeout);
    if (!finishing) void finish('error', 1);
  });
}

main().catch(err => {
  console.error('[record-ws] ERROR:', err?.message ?? err);
  process.exit(1);
});
