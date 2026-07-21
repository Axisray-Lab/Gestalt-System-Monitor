#!/usr/bin/env node

/**
 * Build all RMUC 2026 regional GitHub Pages fixtures from the official public
 * SQLite dataset, grouped as one compressed replay per match series.
 *
 * The public dataset is 1 Hz. Position and angle attributes are deterministically
 * interpolated to the Monitor's 10 Hz consumption cadence. Current health and
 * firing heat are anchored linear projections; lifecycle, buffs, coins, levels,
 * limits and other rule states remain step/hold values.
 */

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  promises as fs,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { createGzip, gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const REPLAY_SCHEMA = 'gsm-watch-replay/2';
const CATALOG_SCHEMA = 'gsm-static-replay-catalog/2';
const OVERVIEW_TRACK_SCHEMA = 'gsm-rmuc2026-overview-track/1';
const OVERVIEW_TRACK_MAGIC = Buffer.from('GSMOVW01', 'ascii');
const OVERVIEW_TRACK_VERSION = 1;
const OVERVIEW_TRACK_HEADER_BYTES = 64;
const OVERVIEW_ROUND_HEADER_BYTES = 28;
const OVERVIEW_RECORD_BYTES = 7;
const OVERVIEW_SAMPLE_HZ = 1;
const OVERVIEW_POSITION_QUANTIZATION_CM = 1;
const AMMO_INFERENCE_SCHEMA = 'gsm-ammo-inference/1';
const BUFF_PROJECTION_SCHEMA = 'gsm-rmuc2026-buff-projection/1';
const FRAME_MS = 100;
const FRAMES_PER_SECOND = 1000 / FRAME_MS;
const ROUND_GAP_MS = 3000;
const CYCLE_EVENT_TYPE = 8_940_001;
const EXPECTED_DATABASE_SHA256 =
  '53ac64efeaf570c0e21d8c3724dcefcb0123196b3c7ef963183a911863f724a7';
const DATASET_ARTICLE_URL =
  'https://bbs.robomaster.com/article/1936220?source=1';
const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);
const BUFF_RULE_VALUES = {
  terrain: {
    road: { defenseThou: 250, durationSeconds: 5 },
    centralHighland: { defenseThou: 250, durationSeconds: 30 },
    ramp: { defenseThou: 250, durationSeconds: 30 },
    secondOverlap: {
      defenseThou: 500,
      expiry: 'max(previous expiry, new base expiry)',
    },
  },
  smallRune: { defenseThou: 250, durationSeconds: 45 },
  bigRune: {
    tier1: { defenseThou: 250, attackThou: 500, coldThou: 0 },
    tier2: { defenseThou: 250, attackThou: 500, coldThou: 1000 },
    tier3: { defenseThou: 250, attackThou: 1000, coldThou: 1000 },
    tier4: { defenseThou: 250, attackThou: 1000, coldThou: 2000 },
    tier5: { defenseThou: 500, attackThou: 2000, coldThou: 4000 },
    durationSecondsByLightCount: {
      5: 30,
      6: 35,
      7: 40,
      8: 45,
      9: 50,
      10: 60,
    },
  },
  assembly: {
    firstLevel3: { defenseThou: 250, persistent: true },
    firstLevel4: { defenseThou: 500, persistent: true },
  },
  dartCounter: {
    fixedRandomPauseSecondsByHit: [10, 5, 3, 2],
    movingRandom: 'clear active terrain and rune effects',
    assemblyUnaffected: true,
  },
};

const REGIONS = [
  {
    key: 'east',
    sourceName: '东部赛区',
    label: '东部赛区',
    expectedMatches: 88,
    expectedRounds: 203,
    rulesEffective: 'V1.5.0',
  },
  {
    key: 'south',
    sourceName: '南部赛区',
    label: '南部赛区',
    expectedMatches: 88,
    expectedRounds: 204,
    rulesEffective: 'V1.4.2',
  },
  {
    key: 'north',
    sourceName: '北部赛区',
    label: '北部赛区',
    expectedMatches: 90,
    expectedRounds: 206,
    rulesEffective: 'V1.5.0',
  },
];
const EXPECTED_SERIES_COUNT = 266;
const EXPECTED_ROUND_COUNT = 613;

const ROBOT_IDS = [1, 2, 3, 4, 6, 7, 101, 102, 103, 104, 106, 107];
const BUILDING_IDS = [10, 11, 110, 111];

const CLASS_ID = {
  Hero: 1001,
  Engineer: 1002,
  Infantry: 1003,
  Sentry: 1004,
  Aerial: 1005,
  Building: 2000,
  Base: 2001,
  Outpost: 2002,
};

const A = {
  Health: 10000003,
  ReviveCount: 10000009,
  PurchaseReviveCount: 10000010,
  FiringHeat1: 10000011,
  FiringHeat2: 10000012,
  ReviveProgress: 10000022,
  ReviveSpeed: 10000023,
  ChassisPower: 10000007,
  Ammo17mmCount: 10000033,
  Ammo42mmCount: 10000034,
  PlayerID: 10000035,
  TeamID: 10000036,
  TeamNumber: 10000037,
  RemoteRepairPendingCount: 10000057,
  RemoteRepairCountdownMs: 10000058,
  WorldPosX: 10000107,
  WorldPosY: 10000108,
  WorldPosZ: 10000109,
  ChassisYaw: 10000110,
  TurretYaw: 10000111,
  TurretPitch: 10000112,
  Weakened: 50000002,
  FiringLocked: 50000006,
  Defeated: 50000007,
  Invincible: 50000013,
  IsChassisOnline: 50000014,
  HasGun: 50000016,
  HasTerrainCrossingRoadBuff: 50000029,
  HasTerrainCrossingHighlandBuff: 50000032,
  HasTerrainCrossingRampBuff: 50000035,
  HasTerrainCrossingDefenseBuff: 50000036,
  HasTerrainCrossingRefreshBuff: 50000037,
  HasTeamDefenseBuff: 50000046,
  HasSmallRuneBuff: 50000059,
  EngineerTeamEnergyUnitStock: 50000060,
  EngineerAssemblyMaxCompletedLevel: 50000068,
  RadarDoubleVulnerabilityActive: 50000074,
  DartCounterBuffSuspended: 50000084,
  BigRuneBuffArmCount: 50000082,
  BigRuneBuffLightCount: 50000083,
  HPMainColorSwitch: 51000004,
  HPSideColorSwitch: 51000005,
  HPProgress: 51000008,
  Class: 60000002,
  Level: 60000003,
  HealthMax: 60000004,
  FiringHeatMax1: 60000011,
  FiringHeatMax2: 60000013,
  ReviveProgressMax: 60000017,
  AttackMultiplierThou: 61000000,
  DefenseMultiplierThou: 61000001,
  ColdMultiplierThou: 61000004,
  BulletFiredTotal: 63000002,
  OutpostAngularSpeed: 72000001,
  OutpostRotationStopRequested: 72000002,
  BaseState: 73000001,
  TeamCoins: 74000003,
  TeamOutpostRebuildCount: 74000011,
  TeamDartBaseHitCount: 74000024,
  RMUC2026TechL1: 10000098,
  RMUC2026TechL2: 10000099,
  RMUC2026TechL3: 10000100,
  RMUC2026TechL4: 10000101,
  GlobalMaxGameTime: 80000001,
  GlobalCurrentGameTime: 80000002,
  GlobalCurrentMapId: 80000003,
  GlobalMatchStarted: 80000005,
  GlobalBaseId0: 80001000,
  GlobalOutpostId0: 80002000,
  GlobalBuffStationId0: 80004000,
};

const HERO_LEVEL_BY_HEAT_MAX = new Map([
  [100, 1],
  [102, 2],
  [104, 3],
  [106, 4],
  [108, 5],
  [110, 6],
  [115, 7],
  [120, 8],
  [125, 9],
  [130, 10],
  [140, 1],
  [150, 2],
  [160, 3],
  [170, 4],
  [180, 5],
  [190, 6],
  [200, 7],
  [210, 8],
  [220, 9],
  [240, 10],
]);
const INFANTRY_LEVEL_BY_HEAT_MAX = new Map([
  [40, 1],
  [48, 2],
  [56, 3],
  [64, 4],
  [72, 5],
  [80, 6],
  [88, 7],
  [96, 8],
  [114, 9],
  [120, 10],
  [170, 1],
  [180, 2],
  [190, 3],
  [200, 4],
  [210, 5],
  [220, 6],
  [230, 7],
  [240, 8],
  [250, 9],
  [260, 10],
]);
const AERIAL_LEVEL_BY_HEAT_MAX = new Map([
  [100, 1],
  [110, 2],
  [120, 3],
  [130, 4],
  [140, 5],
  [150, 6],
  [160, 7],
  [170, 8],
  [180, 9],
  [200, 10],
]);

const STRUCTURES = {
  10: {
    mapId: 14,
    teamId: 0,
    kind: 'base',
    classId: CLASS_ID.Base,
    x: 8,
    y: -1130,
    z: 4,
    yaw: 90,
  },
  110: {
    mapId: 15,
    teamId: 1,
    kind: 'base',
    classId: CLASS_ID.Base,
    x: 7,
    y: 1185,
    z: 4,
    yaw: -90,
  },
  11: {
    mapId: 16,
    teamId: 0,
    kind: 'outpost',
    classId: CLASS_ID.Outpost,
    x: -381,
    y: -283,
    z: 20,
    yaw: -90,
  },
  111: {
    mapId: 17,
    teamId: 1,
    kind: 'outpost',
    classId: CLASS_ID.Outpost,
    x: 393,
    y: 333,
    z: 20,
    yaw: 90,
  },
};

const EXPECTED_SOURCE_AUDIT = {
  buffCategories: {
    小能量机关增益: 2701,
    大能量机关增益: 1816,
    飞坡: 651,
    台阶跨越: 1002,
    过中央高地: 1064,
  },
  assemblyLevels: { 1: 884, 2: 884, 3: 626, 4: 0 },
  vulnerableRobotSamples: 510805,
  robotSamples: 2990075,
  robotSeries: 7151,
  missingRobotSamples: 8,
};

const RULE_SOURCE_SHA256 = {
  V1_4_2: '3ce3b708c7889608c1ccff8330046606e2257d8db46842ee6143078e49da0f16',
  V2_0_1_WITH_V1_5_CHANGELOG:
    '2c567d4e8e8e7a20b3ffc35c99cfea2012acb9b7611916408267046bdf3385eb',
};

function fail(message) {
  throw new Error(`[rmuc2026-pages-replay] ${message}`);
}

function parseArgs(argv) {
  const options = {
    database: resolve(
      process.cwd(),
      '..',
      'Saved',
      'Temp',
      'rmuc_2026_region_dataset',
      'rmuc_2026_region_dataset.sqlite'
    ),
    outputDir: resolve(
      process.cwd(),
      'packages',
      'web',
      'public',
      'replays',
      'rmuc2026-regionals'
    ),
    catalog: resolve(
      process.cwd(),
      'packages',
      'web',
      'src',
      'feed',
      'rmuc2026ReplayCatalog.generated.json'
    ),
    validateOnly: false,
    verifyAssetsOnly: false,
    auditOnly: false,
    catalogOnly: false,
    series: null,
    region: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db')
      options.database = resolve(argv[++index] ?? fail('--db requires a path'));
    else if (arg === '--output-dir')
      options.outputDir = resolve(
        argv[++index] ?? fail('--output-dir requires a path')
      );
    else if (arg === '--catalog')
      options.catalog = resolve(
        argv[++index] ?? fail('--catalog requires a path')
      );
    else if (arg === '--series')
      options.series = argv[++index] ?? fail('--series requires region:MNNN');
    else if (arg === '--region')
      options.region = argv[++index] ?? fail('--region requires a key');
    else if (arg === '--validate-only') options.validateOnly = true;
    else if (arg === '--verify-assets-only') options.verifyAssetsOnly = true;
    else if (arg === '--audit-only') options.auditOnly = true;
    else if (arg === '--catalog-only') options.catalogOnly = true;
    else fail(`unknown argument ${arg}`);
  }
  const modes = [
    options.validateOnly,
    options.verifyAssetsOnly,
    options.auditOnly,
    options.catalogOnly,
  ].filter(Boolean).length;
  if (modes > 1) fail('validation/audit/catalog modes are mutually exclusive');
  if (options.series != null && options.region != null)
    fail('--series and --region are mutually exclusive');
  if (
    (options.catalogOnly || options.auditOnly) &&
    (options.series != null || options.region != null)
  ) {
    fail('--catalog-only and --audit-only do not accept --series or --region');
  }
  if (
    options.region != null &&
    !REGIONS.some(region => region.key === options.region)
  ) {
    fail(`--region must be east, south, or north: ${options.region}`);
  }
  return options;
}

function finite(value, context) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail(`${context} must be finite`);
  return value;
}

function nonNegativeInteger(value, context) {
  finite(value, context);
  if (!Number.isSafeInteger(value) || value < 0)
    fail(`${context} must be a non-negative integer`);
  return value;
}

function exactSecond(value, context) {
  finite(value, context);
  if (!Number.isSafeInteger(value) || value < 0)
    fail(`${context} must be an integer second`);
  return value;
}

function normalizeDegrees(value) {
  const normalized = ((((value + 180) % 360) + 360) % 360) - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function interpolateAngle(left, right, alpha) {
  return normalizeDegrees(left + normalizeDegrees(right - left) * alpha);
}

function roundNumber(value, digits = 3) {
  const scale = 10 ** digits;
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function interpolateAnchoredValue(left, right, alpha, holdUntilRight = false) {
  finite(left, 'interpolation left value');
  finite(right, 'interpolation right value');
  finite(alpha, 'interpolation alpha');
  if (alpha <= 0 || left === right) return left;
  if (alpha >= 1) return right;
  if (holdUntilRight) return left;
  return roundNumber(left + (right - left) * alpha);
}

function interpolateHealth(left, right, alpha) {
  const holdUntilRight =
    left.hpMax !== right.hpMax || (left.hp <= 0 && right.hp > 0);
  const value = interpolateAnchoredValue(
    left.hp,
    right.hp,
    alpha,
    holdUntilRight
  );
  if (alpha > 0 && alpha < 1 && left.hp > 0 && right.hp <= 0) {
    return Math.max(1, value);
  }
  return value;
}

function teamIdForRobot(robotId) {
  return robotId >= 100 ? 1 : 0;
}

function teamNumberForRobot(robotId) {
  return robotId >= 100 ? robotId - 100 : robotId;
}

function robotMapId(robotId) {
  return 1000 + robotId;
}

function classForTeamNumber(teamNumber) {
  if (teamNumber === 1) return CLASS_ID.Hero;
  if (teamNumber === 2) return CLASS_ID.Engineer;
  if (teamNumber === 3 || teamNumber === 4) return CLASS_ID.Infantry;
  if (teamNumber === 6) return CLASS_ID.Aerial;
  if (teamNumber === 7) return CLASS_ID.Sentry;
  fail(`unsupported team number ${teamNumber}`);
}

function gunCaliberForTeamNumber(teamNumber) {
  if (teamNumber === 1) return 42;
  if (
    teamNumber === 3 ||
    teamNumber === 4 ||
    teamNumber === 6 ||
    teamNumber === 7
  )
    return 17;
  return null;
}

function officialPositionToUe(state) {
  return {
    x: (state.y - 7.5) * 100 + 7.5,
    y: (state.x - 14) * 100 + 27.5,
    z: state.z * 100 - 10,
  };
}

function officialHeadingToUe(heading) {
  return normalizeDegrees(90 - heading);
}

function mappedLevel(table, heatMax, context) {
  const level = table.get(heatMax);
  if (level == null) fail(`${context} has unmapped heat maximum ${heatMax}`);
  return level;
}

function officialLevel(state) {
  const teamNumber = teamNumberForRobot(state.robotId);
  if (teamNumber === 1) {
    if (state.heat17Max !== 50)
      fail(`hero ${state.robotId} small heat max is ${state.heat17Max}`);
    return mappedLevel(
      HERO_LEVEL_BY_HEAT_MAX,
      state.heat42Max,
      `hero ${state.robotId}`
    );
  }
  if (teamNumber === 2) {
    if (![0, 40].includes(state.heat17Max) || state.heat42Max !== 0)
      fail(
        `engineer ${state.robotId} has unsupported heat limits ${state.heat17Max}/${state.heat42Max}`
      );
    if (state.fired17 != null || state.fired42 != null)
      fail(`engineer ${state.robotId} unexpectedly has a firing counter`);
    return 1;
  }
  if (teamNumber === 3 || teamNumber === 4) {
    if (state.heat42Max !== 0) fail(`infantry ${state.robotId} has 42mm heat`);
    return mappedLevel(
      INFANTRY_LEVEL_BY_HEAT_MAX,
      state.heat17Max,
      `infantry ${state.robotId}`
    );
  }
  if (teamNumber === 6) {
    if (state.heat42Max !== 0) fail(`aerial ${state.robotId} has 42mm heat`);
    return mappedLevel(
      AERIAL_LEVEL_BY_HEAT_MAX,
      state.heat17Max,
      `aerial ${state.robotId}`
    );
  }
  if (teamNumber === 7) {
    if (![100, 260].includes(state.heat17Max) || state.heat42Max !== 0)
      fail(
        `sentry ${state.robotId} has unsupported heat limits ${state.heat17Max}/${state.heat42Max}`
      );
    return 1;
  }
  fail(`cannot derive level for robot ${state.robotId}`);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', chunk => hash.update(chunk));
  await once(stream, 'end');
  return hash.digest('hex');
}

function requireTables(database) {
  const tables = new Set(
    database
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map(row => row.name)
  );
  for (const table of ['matches', 'timeseries', 'events']) {
    if (!tables.has(table)) fail(`database is missing table ${table}`);
  }
}

function paddedMatchNumber(matchNumber) {
  return String(matchNumber).padStart(3, '0');
}

function loadSeriesConfigs(database) {
  const rows = database
    .prepare(
      `
    SELECT
      赛区 AS region,
      场次号 AS matchNumber,
      赛程 AS schedule,
      局号 AS roundNumber,
      game_id AS gameId,
      web_game_id AS webGameId,
      红方学校 AS redSchool,
      蓝方学校 AS blueSchool,
      胜方 AS winner,
      开始时间 AS startedLocal,
      时长秒 AS durationSeconds
    FROM matches
    ORDER BY 赛区, 场次号, 局号
  `
    )
    .all();
  if (rows.length !== EXPECTED_ROUND_COUNT) {
    fail(
      `official catalog has ${rows.length} rounds, expected ${EXPECTED_ROUND_COUNT}`
    );
  }
  const regionBySourceName = new Map(
    REGIONS.map(region => [region.sourceName, region])
  );
  const grouped = new Map();
  const gameIds = new Set();
  const webGameIds = new Set();
  for (const row of rows) {
    const region = regionBySourceName.get(row.region);
    if (!region) fail(`catalog has unsupported region ${String(row.region)}`);
    const matchNumber = nonNegativeInteger(
      row.matchNumber,
      `${row.region} match number`
    );
    if (matchNumber <= 0)
      fail(`${row.region} has non-positive match number ${matchNumber}`);
    const roundNumber = nonNegativeInteger(
      row.roundNumber,
      `${row.region} M${matchNumber} round number`
    );
    if (roundNumber <= 0)
      fail(`${row.region} M${matchNumber} has non-positive round number`);
    const gameId = nonNegativeInteger(
      row.gameId,
      `${row.region} M${matchNumber} game_id`
    );
    const webGameId = nonNegativeInteger(
      row.webGameId,
      `${row.region} M${matchNumber} web_game_id`
    );
    if (gameIds.has(gameId) || webGameIds.has(webGameId)) {
      fail(`${row.region} M${matchNumber} duplicates a game identifier`);
    }
    gameIds.add(gameId);
    webGameIds.add(webGameId);
    for (const [field, value] of Object.entries({
      schedule: row.schedule,
      redSchool: row.redSchool,
      blueSchool: row.blueSchool,
      winner: row.winner,
      startedLocal: row.startedLocal,
    })) {
      if (typeof value !== 'string' || value.length === 0) {
        fail(`${row.region} M${matchNumber} has invalid ${field}`);
      }
    }
    row.durationSeconds = nonNegativeInteger(
      row.durationSeconds,
      `${row.region} M${matchNumber} round duration`
    );
    const key = `${region.key}:${matchNumber}`;
    const group = grouped.get(key) ?? { region, matchNumber, rows: [] };
    group.rows.push({ ...row, gameId, webGameId, roundNumber });
    grouped.set(key, group);
  }

  const configs = [];
  for (const region of REGIONS) {
    const regionGroups = [...grouped.values()]
      .filter(group => group.region === region)
      .sort((left, right) => left.matchNumber - right.matchNumber);
    if (regionGroups.length !== region.expectedMatches) {
      fail(
        `${region.sourceName} has ${regionGroups.length} matches, expected ${region.expectedMatches}`
      );
    }
    let roundCount = 0;
    for (let index = 0; index < regionGroups.length; index += 1) {
      const group = regionGroups[index];
      const expectedMatchNumber = index + 1;
      if (group.matchNumber !== expectedMatchNumber) {
        fail(
          `${region.sourceName} match sequence jumps ${expectedMatchNumber}->${group.matchNumber}`
        );
      }
      const first = group.rows[0];
      for (let roundIndex = 0; roundIndex < group.rows.length; roundIndex += 1) {
        const row = group.rows[roundIndex];
        if (
          row.roundNumber !== roundIndex + 1 ||
          row.region !== region.sourceName ||
          row.matchNumber !== group.matchNumber ||
          row.schedule !== first.schedule ||
          row.redSchool !== first.redSchool ||
          row.blueSchool !== first.blueSchool
        ) {
          fail(
            `${region.sourceName} M${group.matchNumber} round ${roundIndex + 1} identity drifted`
          );
        }
      }
      roundCount += group.rows.length;
      const padded = paddedMatchNumber(group.matchNumber);
      configs.push({
        key: `rmuc2026-${region.key}-m${padded}`,
        regionKey: region.key,
        region: region.sourceName,
        regionLabel: region.label,
        matchNumber: group.matchNumber,
        schedule: first.schedule,
        redSchool: first.redSchool,
        blueSchool: first.blueSchool,
        gameIds: group.rows.map(row => row.gameId),
        webGameIds: group.rows.map(row => row.webGameId),
        rounds: group.rows.map(row => ({
          roundNumber: row.roundNumber,
          gameId: row.gameId,
          webGameId: row.webGameId,
          winner: row.winner,
          startedLocal: row.startedLocal,
          durationSeconds: row.durationSeconds,
        })),
        roundCount: group.rows.length,
        output: `${region.key}/m${padded}.json.gzip`,
        label: `RMUC2026 ${region.label} M${padded} · ${first.redSchool} vs ${first.blueSchool} · 推断弹量`,
        rulesEffective: region.rulesEffective,
      });
    }
    if (roundCount !== region.expectedRounds) {
      fail(
        `${region.sourceName} has ${roundCount} rounds, expected ${region.expectedRounds}`
      );
    }
  }
  if (configs.length !== EXPECTED_SERIES_COUNT) {
    fail(
      `official catalog has ${configs.length} series, expected ${EXPECTED_SERIES_COUNT}`
    );
  }
  return configs;
}

function roundDescriptors(config) {
  if (
    !config.asset ||
    !Number.isSafeInteger(config.asset.frames) ||
    !Number.isSafeInteger(config.asset.durationMs)
  ) {
    fail(`${config.key} has no validated series asset for round indexing`);
  }
  const assetPath = `replays/rmuc2026-regionals/${config.output}`;
  let nextStartMs = 0;
  const rounds = config.rounds.map(identity => {
    const durationMs = identity.durationSeconds * 1000;
    const startMs = nextStartMs;
    const endMs = startMs + durationMs;
    if (
      startMs % FRAME_MS !== 0 ||
      endMs % FRAME_MS !== 0 ||
      durationMs <= 0
    ) {
      fail(`${config.key} G${identity.roundNumber} has invalid frame boundaries`);
    }
    const frameStartIndex = startMs / FRAME_MS;
    const frameCount = durationMs / FRAME_MS;
    nextStartMs = endMs + ROUND_GAP_MS;
    return {
      key: `${config.key}-g${identity.roundNumber}`,
      label: `${config.label.replace(/ · 推断弹量$/, '')} · 第 ${identity.roundNumber} 局`,
      assetKey: config.key,
      seriesKey: config.key,
      assetPath,
      encoding: 'gzip',
      regionKey: config.regionKey,
      regionLabel: config.regionLabel,
      matchNumber: config.matchNumber,
      roundNumber: identity.roundNumber,
      gameId: identity.gameId,
      webGameId: identity.webGameId,
      winner: identity.winner,
      startedLocal: identity.startedLocal,
      redSchool: config.redSchool,
      blueSchool: config.blueSchool,
      roundCount: 1,
      assetRoundCount: config.roundCount,
      startMs,
      endMs,
      durationMs,
      frameStartIndex,
      frameCount,
      frameCountInRound: frameCount,
      assetFrameCount: config.asset.frames,
      assetDurationMs: config.asset.durationMs,
      compressedBytes: config.asset.bytes,
      sha256: config.asset.sha256,
    };
  });
  if (
    rounds.length !== config.roundCount ||
    nextStartMs !== config.asset.durationMs ||
    nextStartMs / FRAME_MS !== config.asset.frames
  ) {
    fail(`${config.key} round frame index does not cover its series asset`);
  }
  return rounds;
}

function overviewPosition(value, context) {
  finite(value, context);
  const quantized = Math.round(value / OVERVIEW_POSITION_QUANTIZATION_CM);
  if (quantized < -32768 || quantized > 32767) {
    fail(`${context} is outside the signed 16-bit overview range`);
  }
  return quantized;
}

function overviewPoseAt(states, targetSecond, context) {
  const { left, right } = surroundingStates(states, targetSecond);
  const alpha =
    left.second === right.second
      ? 0
      : (targetSecond - left.second) / (right.second - left.second);
  const pose = {
    x: left.pose.x + (right.pose.x - left.pose.x) * alpha,
    y: left.pose.y + (right.pose.y - left.pose.y) * alpha,
    z: left.pose.z + (right.pose.z - left.pose.z) * alpha,
  };
  return {
    x: overviewPosition(pose.x, `${context} x`),
    y: overviewPosition(pose.y, `${context} y`),
    z: overviewPosition(pose.z, `${context} z`),
    defeated: left.hp <= 0,
  };
}

function encodeOverviewRound(config, round) {
  const identity = config.rounds[round.match.roundNumber - 1];
  if (
    !identity ||
    identity.gameId !== round.match.gameId ||
    identity.webGameId !== round.match.webGameId ||
    identity.durationSeconds !== round.match.durationSeconds
  ) {
    fail(`${config.key} G${round.match.roundNumber} overview identity drifted`);
  }
  const robotIds = [...round.byRobot.keys()].sort((left, right) => left - right);
  if (
    robotIds.length === 0 ||
    robotIds.length > 255 ||
    robotIds.some(
      (robotId, index) =>
        !Number.isSafeInteger(robotId) ||
        robotId <= 0 ||
        robotId > 65535 ||
        (index > 0 && robotIds[index - 1] >= robotId)
    )
  ) {
    fail(`${config.key} G${identity.roundNumber} has invalid overview robot ids`);
  }
  const sampleCount = identity.durationSeconds;
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || sampleCount > 65535) {
    fail(`${config.key} G${identity.roundNumber} has invalid overview sample count`);
  }
  const recordCount = sampleCount * robotIds.length;
  const robotIdBytes = robotIds.length * 2;
  const payloadBytes = robotIdBytes + recordCount * OVERVIEW_RECORD_BYTES;
  const buffer = Buffer.allocUnsafe(OVERVIEW_ROUND_HEADER_BYTES + payloadBytes);
  let offset = 0;
  buffer.writeUInt16LE(config.matchNumber, offset);
  offset += 2;
  buffer.writeUInt8(identity.roundNumber, offset);
  offset += 1;
  buffer.writeUInt8(robotIds.length, offset);
  offset += 1;
  buffer.writeBigUInt64LE(BigInt(identity.gameId), offset);
  offset += 8;
  buffer.writeUInt32LE(identity.webGameId, offset);
  offset += 4;
  buffer.writeUInt16LE(identity.durationSeconds, offset);
  offset += 2;
  buffer.writeUInt16LE(sampleCount, offset);
  offset += 2;
  buffer.writeUInt32LE(recordCount, offset);
  offset += 4;
  buffer.writeUInt32LE(payloadBytes, offset);
  offset += 4;
  for (const robotId of robotIds) {
    buffer.writeUInt16LE(robotId, offset);
    offset += 2;
  }
  for (let localSecond = 0; localSecond < sampleCount; localSecond += 1) {
    const targetSecond = Math.min(round.sampleMaxSecond, 1 + localSecond);
    for (const robotId of robotIds) {
      const pose = overviewPoseAt(
        round.byRobot.get(robotId),
        targetSecond,
        `${config.key} G${identity.roundNumber} second ${localSecond} robot ${robotId}`
      );
      buffer.writeInt16LE(pose.x, offset);
      offset += 2;
      buffer.writeInt16LE(pose.y, offset);
      offset += 2;
      buffer.writeInt16LE(pose.z, offset);
      offset += 2;
      buffer.writeUInt8(pose.defeated ? 1 : 0, offset);
      offset += 1;
    }
  }
  if (offset !== buffer.length) {
    fail(`${config.key} G${identity.roundNumber} overview byte count drifted`);
  }
  return { buffer, sampleCount, recordCount };
}

function createOverviewCollectors() {
  return new Map(
    REGIONS.map(region => [
      region.key,
      {
        region,
        chunks: [],
        seriesCount: 0,
        roundCount: 0,
        timelineSampleCount: 0,
        entitySampleCount: 0,
      },
    ])
  );
}

function addSeriesToOverviewCollectors(collectors, item) {
  const collector = collectors.get(item.config.regionKey);
  if (!collector) fail(`${item.config.key} has no overview collector`);
  if (item.config.matchNumber !== collector.seriesCount + 1) {
    fail(
      `${collector.region.key} overview match sequence drifted at ${collector.seriesCount + 1}`
    );
  }
  const rounds = item.preparedRounds
    ? item.preparedRounds.map(prepared => prepared.round)
    : item.rounds;
  if (!Array.isArray(rounds) || rounds.length !== item.config.roundCount) {
    fail(`${item.config.key} overview round count drifted`);
  }
  for (const round of rounds) {
    const encoded = encodeOverviewRound(item.config, round);
    collector.chunks.push(encoded.buffer);
    collector.roundCount += 1;
    collector.timelineSampleCount += encoded.sampleCount;
    collector.entitySampleCount += encoded.recordCount;
  }
  collector.seriesCount += 1;
}

function finalizeOverviewCollector(collector, databaseSha256) {
  const { region } = collector;
  const regionIndex = REGIONS.findIndex(item => item.key === region.key);
  if (regionIndex < 0 || region !== REGIONS[regionIndex]) {
    fail(`cannot encode unsupported overview region ${String(region?.key)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(databaseSha256)) {
    fail(`${region.key} overview database SHA-256 is invalid`);
  }
  if (collector.seriesCount !== region.expectedMatches) {
    fail(
      `${region.key} overview has ${collector.seriesCount} series, expected ${region.expectedMatches}`
    );
  }
  const {
    chunks,
    roundCount,
    timelineSampleCount,
    entitySampleCount,
  } = collector;
  if (roundCount !== region.expectedRounds) {
    fail(`${region.key} overview has ${roundCount} rounds, expected ${region.expectedRounds}`);
  }
  const payloadBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(OVERVIEW_TRACK_HEADER_BYTES);
  OVERVIEW_TRACK_MAGIC.copy(header, 0);
  header.writeUInt16LE(OVERVIEW_TRACK_VERSION, 8);
  header.writeUInt8(regionIndex, 10);
  header.writeUInt8(OVERVIEW_SAMPLE_HZ, 11);
  header.writeUInt8(OVERVIEW_RECORD_BYTES, 12);
  header.writeUInt8(OVERVIEW_POSITION_QUANTIZATION_CM, 13);
  header.writeUInt16LE(roundCount, 14);
  header.writeUInt32LE(timelineSampleCount, 16);
  header.writeUInt32LE(entitySampleCount, 20);
  header.writeUInt32LE(payloadBytes, 24);
  Buffer.from(databaseSha256, 'hex').copy(header, 28);
  header.writeUInt32LE(0, 60);
  return {
    buffer: Buffer.concat([header, ...chunks], OVERVIEW_TRACK_HEADER_BYTES + payloadBytes),
    roundCount,
    timelineSampleCount,
    entitySampleCount,
  };
}

export function encodeOverviewRegion(regionKey, series, databaseSha256) {
  const region = REGIONS.find(item => item.key === regionKey);
  if (!region) fail(`cannot encode unsupported overview region ${String(regionKey)}`);
  const collectors = createOverviewCollectors();
  for (const item of [...series].sort((left, right) => {
    if (left.config.regionKey !== right.config.regionKey) {
      return left.config.regionKey.localeCompare(right.config.regionKey);
    }
    return left.config.matchNumber - right.config.matchNumber;
  })) {
    if (item.config.regionKey === region.key) {
      addSeriesToOverviewCollectors(collectors, item);
    }
  }
  return finalizeOverviewCollector(collectors.get(region.key), databaseSha256);
}

function safeGameId(value, context) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${context} exceeds Number.MAX_SAFE_INTEGER`);
  return Number(value);
}

export function validateOverviewTrackBuffer(
  buffer,
  regionKey,
  databaseSha256,
  expectedRounds
) {
  const region = REGIONS.find(item => item.key === regionKey);
  if (!region) fail(`cannot validate unsupported overview region ${String(regionKey)}`);
  if (!Buffer.isBuffer(buffer) || buffer.length <= OVERVIEW_TRACK_HEADER_BYTES) {
    fail(`${region.key} overview track is empty or not a Buffer`);
  }
  if (!buffer.subarray(0, 8).equals(OVERVIEW_TRACK_MAGIC)) {
    fail(`${region.key} overview track magic drifted`);
  }
  const regionIndex = REGIONS.findIndex(item => item.key === region.key);
  const version = buffer.readUInt16LE(8);
  const roundCount = buffer.readUInt16LE(14);
  const timelineSampleCount = buffer.readUInt32LE(16);
  const entitySampleCount = buffer.readUInt32LE(20);
  const payloadBytes = buffer.readUInt32LE(24);
  const embeddedSha256 = buffer.subarray(28, 60).toString('hex');
  if (
    version !== OVERVIEW_TRACK_VERSION ||
    buffer.readUInt8(10) !== regionIndex ||
    buffer.readUInt8(11) !== OVERVIEW_SAMPLE_HZ ||
    buffer.readUInt8(12) !== OVERVIEW_RECORD_BYTES ||
    buffer.readUInt8(13) !== OVERVIEW_POSITION_QUANTIZATION_CM ||
    roundCount !== region.expectedRounds ||
    roundCount !== expectedRounds.length ||
    timelineSampleCount <= 0 ||
    entitySampleCount <= 0 ||
    payloadBytes !== buffer.length - OVERVIEW_TRACK_HEADER_BYTES ||
    embeddedSha256 !== databaseSha256 ||
    buffer.readUInt32LE(60) !== 0
  ) {
    fail(`${region.key} overview track header drifted`);
  }
  let offset = OVERVIEW_TRACK_HEADER_BYTES;
  let actualTimelineSamples = 0;
  let actualEntitySamples = 0;
  for (let index = 0; index < expectedRounds.length; index += 1) {
    const expected = expectedRounds[index];
    if (offset + OVERVIEW_ROUND_HEADER_BYTES > buffer.length) {
      fail(`${region.key} overview round ${index + 1} header is truncated`);
    }
    const matchNumber = buffer.readUInt16LE(offset);
    const roundNumber = buffer.readUInt8(offset + 2);
    const robotCount = buffer.readUInt8(offset + 3);
    const gameId = safeGameId(
      buffer.readBigUInt64LE(offset + 4),
      `${region.key} overview round ${index + 1} game id`
    );
    const webGameId = buffer.readUInt32LE(offset + 12);
    const durationSeconds = buffer.readUInt16LE(offset + 16);
    const sampleCount = buffer.readUInt16LE(offset + 18);
    const recordCount = buffer.readUInt32LE(offset + 20);
    const roundPayloadBytes = buffer.readUInt32LE(offset + 24);
    offset += OVERVIEW_ROUND_HEADER_BYTES;
    if (
      matchNumber !== expected.matchNumber ||
      roundNumber !== expected.roundNumber ||
      gameId !== expected.gameId ||
      webGameId !== expected.webGameId ||
      durationSeconds * 1000 !== expected.durationMs ||
      sampleCount !== durationSeconds ||
      robotCount <= 0 ||
      recordCount !== robotCount * sampleCount ||
      roundPayloadBytes !== robotCount * 2 + recordCount * OVERVIEW_RECORD_BYTES ||
      offset + roundPayloadBytes > buffer.length
    ) {
      fail(`${expected.key} overview round header drifted`);
    }
    let previousRobotId = 0;
    for (let robotIndex = 0; robotIndex < robotCount; robotIndex += 1) {
      const robotId = buffer.readUInt16LE(offset);
      offset += 2;
      if (!ROBOT_IDS.includes(robotId) || robotId <= previousRobotId) {
        fail(`${expected.key} overview robot ids drifted`);
      }
      previousRobotId = robotId;
    }
    for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
      const flags = buffer.readUInt8(offset + 6);
      if ((flags & ~1) !== 0) fail(`${expected.key} overview flags drifted`);
      offset += OVERVIEW_RECORD_BYTES;
    }
    actualTimelineSamples += sampleCount;
    actualEntitySamples += recordCount;
  }
  if (
    offset !== buffer.length ||
    actualTimelineSamples !== timelineSampleCount ||
    actualEntitySamples !== entitySampleCount
  ) {
    fail(`${region.key} overview payload totals drifted`);
  }
  return { roundCount, timelineSampleCount, entitySampleCount };
}

async function writeOverviewAssets(
  configs,
  collectors,
  databaseSha256,
  outputDir
) {
  const assets = new Map();
  for (const region of REGIONS) {
    const encoded = finalizeOverviewCollector(
      collectors.get(region.key),
      databaseSha256
    );
    const expectedRounds = configs
      .filter(config => config.regionKey === region.key)
      .flatMap(config => roundDescriptors(config));
    validateOverviewTrackBuffer(
      encoded.buffer,
      region.key,
      databaseSha256,
      expectedRounds
    );
    const compressed = await gzipAsync(encoded.buffer, { level: 9 });
    const relativePath = `overview/${region.key}.bin.gzip`;
    const path = resolve(outputDir, relativePath);
    const temporary = `${path}.${process.pid}.tmp`;
    await fs.mkdir(dirname(path), { recursive: true });
    try {
      await fs.writeFile(temporary, compressed, { flag: 'wx' });
      await fs.rm(path, { force: true });
      await fs.rename(temporary, path);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    assets.set(region.key, {
      schema: OVERVIEW_TRACK_SCHEMA,
      assetPath: `replays/rmuc2026-regionals/${relativePath}`,
      encoding: 'gzip',
      regionKey: region.key,
      sampleHz: OVERVIEW_SAMPLE_HZ,
      positionQuantizationCm: OVERVIEW_POSITION_QUANTIZATION_CM,
      roundCount: encoded.roundCount,
      timelineSampleCount: encoded.timelineSampleCount,
      entitySampleCount: encoded.entitySampleCount,
      uncompressedBytes: encoded.buffer.length,
      compressedBytes: compressed.length,
      sha256: createHash('sha256').update(compressed).digest('hex'),
    });
  }
  return assets;
}

function replayCatalog(configs, databaseSha256, overviewAssets) {
  for (const config of configs) {
    if (
      !config.asset ||
      !Number.isSafeInteger(config.asset.frames) ||
      !Number.isSafeInteger(config.asset.durationMs) ||
      !Number.isSafeInteger(config.asset.bytes) ||
      !/^[0-9a-f]{64}$/.test(config.asset.sha256)
    ) {
      fail(`${config.key} has invalid generated asset metadata`);
    }
    config.catalogRounds = roundDescriptors(config);
  }
  if (!(overviewAssets instanceof Map) || overviewAssets.size !== REGIONS.length) {
    fail('overview asset metadata does not cover every region');
  }
  for (const region of REGIONS) {
    const asset = overviewAssets.get(region.key);
    if (
      !asset ||
      asset.schema !== OVERVIEW_TRACK_SCHEMA ||
      asset.regionKey !== region.key ||
      asset.roundCount !== region.expectedRounds ||
      !Number.isSafeInteger(asset.timelineSampleCount) ||
      asset.timelineSampleCount <= 0 ||
      !Number.isSafeInteger(asset.entitySampleCount) ||
      asset.entitySampleCount <= 0 ||
      !Number.isSafeInteger(asset.uncompressedBytes) ||
      asset.uncompressedBytes <= OVERVIEW_TRACK_HEADER_BYTES ||
      !Number.isSafeInteger(asset.compressedBytes) ||
      asset.compressedBytes <= 0 ||
      !/^[0-9a-f]{64}$/.test(asset.sha256)
    ) {
      fail(`${region.key} has invalid overview asset metadata`);
    }
  }
  return {
    schema: CATALOG_SCHEMA,
    databaseSha256,
    competition: {
      key: 'rmuc2026',
      label: 'RMUC2026',
      mapKey: 'rmuc2026',
      mapLabel: 'RMUC2026',
    },
    seriesCount: configs.length,
    roundCount: configs.reduce((sum, config) => sum + config.roundCount, 0),
    regions: REGIONS.map(region => ({
      key: region.key,
      label: region.label,
      overviewTrack: overviewAssets.get(region.key),
      replays: configs
        .filter(config => config.regionKey === region.key)
        .map(config => ({
          key: config.key,
          label: config.label,
          assetPath: `replays/rmuc2026-regionals/${config.output}`,
          encoding: 'gzip',
          regionKey: config.regionKey,
          regionLabel: config.regionLabel,
          matchNumber: config.matchNumber,
          roundCount: config.roundCount,
          redSchool: config.redSchool,
          blueSchool: config.blueSchool,
          frameCount: config.asset.frames,
          durationMs: config.asset.durationMs,
          compressedBytes: config.asset.bytes,
          sha256: config.asset.sha256,
          rounds: config.catalogRounds,
        })),
    })),
  };
}

async function writeCatalog(
  configs,
  databaseSha256,
  overviewAssets,
  catalogPath
) {
  const catalog = replayCatalog(configs, databaseSha256, overviewAssets);
  const temporary = `${catalogPath}.${process.pid}.tmp`;
  await fs.mkdir(dirname(catalogPath), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.rm(catalogPath, { force: true });
    await fs.rename(temporary, catalogPath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function requireExactObjectKeys(value, expectedKeys, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${context} keys drifted`);
  }
  return value;
}

async function readGeneratedCatalog(catalogPath) {
  if (!existsSync(catalogPath) || !statSync(catalogPath).isFile()) {
    fail(`generated replay catalog does not exist: ${catalogPath}`);
  }
  let catalog;
  try {
    catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  } catch (error) {
    fail(`generated replay catalog is invalid JSON: ${error.message}`);
  }
  requireExactObjectKeys(
    catalog,
    ['schema', 'databaseSha256', 'competition', 'seriesCount', 'roundCount', 'regions'],
    `${catalogPath} root`
  );
  requireExactObjectKeys(
    catalog.competition,
    ['key', 'label', 'mapKey', 'mapLabel'],
    `${catalogPath} competition`
  );
  if (
    catalog.schema !== CATALOG_SCHEMA ||
    catalog.databaseSha256 !== EXPECTED_DATABASE_SHA256 ||
    catalog.competition?.key !== 'rmuc2026' ||
    catalog.competition?.mapKey !== 'rmuc2026' ||
    catalog.seriesCount !== EXPECTED_SERIES_COUNT ||
    catalog.roundCount !== EXPECTED_ROUND_COUNT ||
    !Array.isArray(catalog.regions) ||
    catalog.regions.length !== REGIONS.length
  ) {
    fail(`generated replay catalog header drifted: ${catalogPath}`);
  }
  const descriptors = [];
  const roundDescriptors = [];
  const overviewDescriptors = [];
  const seenKeys = new Set();
  const seenPaths = new Set();
  const seenRoundKeys = new Set();
  const seenGameIds = new Set();
  const seenWebGameIds = new Set();
  let roundCount = 0;
  for (let regionIndex = 0; regionIndex < REGIONS.length; regionIndex += 1) {
    const expectedRegion = REGIONS[regionIndex];
    const region = catalog.regions[regionIndex];
    requireExactObjectKeys(
      region,
      ['key', 'label', 'overviewTrack', 'replays'],
      `${catalogPath} region ${expectedRegion.key}`
    );
    const overview = requireExactObjectKeys(
      region.overviewTrack,
      [
        'schema',
        'assetPath',
        'encoding',
        'regionKey',
        'sampleHz',
        'positionQuantizationCm',
        'roundCount',
        'timelineSampleCount',
        'entitySampleCount',
        'uncompressedBytes',
        'compressedBytes',
        'sha256',
      ],
      `${catalogPath} region ${expectedRegion.key} overview`
    );
    if (
      !region ||
      region.key !== expectedRegion.key ||
      region.label !== expectedRegion.label ||
      !Array.isArray(region.replays) ||
      region.replays.length !== expectedRegion.expectedMatches
    ) {
      fail(`${catalogPath} region ${expectedRegion.key} drifted`);
    }
    if (
      overview.schema !== OVERVIEW_TRACK_SCHEMA ||
      overview.assetPath !==
        `replays/rmuc2026-regionals/overview/${expectedRegion.key}.bin.gzip` ||
      overview.encoding !== 'gzip' ||
      overview.regionKey !== expectedRegion.key ||
      overview.sampleHz !== OVERVIEW_SAMPLE_HZ ||
      overview.positionQuantizationCm !== OVERVIEW_POSITION_QUANTIZATION_CM ||
      overview.roundCount !== expectedRegion.expectedRounds ||
      !Number.isSafeInteger(overview.timelineSampleCount) ||
      overview.timelineSampleCount <= 0 ||
      !Number.isSafeInteger(overview.entitySampleCount) ||
      overview.entitySampleCount <= 0 ||
      !Number.isSafeInteger(overview.uncompressedBytes) ||
      overview.uncompressedBytes <= OVERVIEW_TRACK_HEADER_BYTES ||
      !Number.isSafeInteger(overview.compressedBytes) ||
      overview.compressedBytes <= 0 ||
      !/^[0-9a-f]{64}$/.test(overview.sha256)
    ) {
      fail(`${catalogPath} region ${expectedRegion.key} overview drifted`);
    }
    overviewDescriptors.push(overview);
    let regionRoundCount = 0;
    for (let index = 0; index < region.replays.length; index += 1) {
      const descriptor = region.replays[index];
      requireExactObjectKeys(
        descriptor,
        [
          'key',
          'label',
          'assetPath',
          'encoding',
          'regionKey',
          'regionLabel',
          'matchNumber',
          'roundCount',
          'redSchool',
          'blueSchool',
          'frameCount',
          'durationMs',
          'compressedBytes',
          'sha256',
          'rounds',
        ],
        `${catalogPath} ${expectedRegion.key} series ${index + 1}`
      );
      const expectedMatchNumber = index + 1;
      const expectedPath = `replays/rmuc2026-regionals/${expectedRegion.key}/m${paddedMatchNumber(expectedMatchNumber)}.json.gzip`;
      if (
        !descriptor ||
        typeof descriptor !== 'object' ||
        Array.isArray(descriptor) ||
        typeof descriptor.key !== 'string' ||
        typeof descriptor.label !== 'string' ||
        descriptor.assetPath !== expectedPath ||
        descriptor.encoding !== 'gzip' ||
        descriptor.regionKey !== expectedRegion.key ||
        descriptor.regionLabel !== expectedRegion.label ||
        descriptor.matchNumber !== expectedMatchNumber ||
        !Number.isSafeInteger(descriptor.roundCount) ||
        descriptor.roundCount < 2 ||
        descriptor.roundCount > 4 ||
        typeof descriptor.redSchool !== 'string' ||
        descriptor.redSchool.length === 0 ||
        typeof descriptor.blueSchool !== 'string' ||
        descriptor.blueSchool.length === 0 ||
        !Number.isSafeInteger(descriptor.frameCount) ||
        descriptor.frameCount <= 0 ||
        !Number.isSafeInteger(descriptor.durationMs) ||
        descriptor.durationMs !== descriptor.frameCount * FRAME_MS ||
        !Number.isSafeInteger(descriptor.compressedBytes) ||
        descriptor.compressedBytes <= 0 ||
        typeof descriptor.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(descriptor.sha256) ||
        !Array.isArray(descriptor.rounds) ||
        descriptor.rounds.length !== descriptor.roundCount ||
        seenKeys.has(descriptor.key) ||
        seenPaths.has(descriptor.assetPath)
      ) {
        fail(
          `${catalogPath} ${expectedRegion.key} M${expectedMatchNumber} descriptor drifted`
        );
      }
      seenKeys.add(descriptor.key);
      seenPaths.add(descriptor.assetPath);
      roundCount += descriptor.roundCount;
      regionRoundCount += descriptor.roundCount;
      descriptors.push(descriptor);
      let nextStartMs = 0;
      for (let roundIndex = 0; roundIndex < descriptor.rounds.length; roundIndex += 1) {
        const round = requireExactObjectKeys(
          descriptor.rounds[roundIndex],
          [
            'key',
            'label',
            'assetKey',
            'seriesKey',
            'assetPath',
            'encoding',
            'regionKey',
            'regionLabel',
            'matchNumber',
            'roundNumber',
            'gameId',
            'webGameId',
            'winner',
            'startedLocal',
            'redSchool',
            'blueSchool',
            'roundCount',
            'assetRoundCount',
            'startMs',
            'endMs',
            'durationMs',
            'frameStartIndex',
            'frameCount',
            'frameCountInRound',
            'assetFrameCount',
            'assetDurationMs',
            'compressedBytes',
            'sha256',
          ],
          `${descriptor.key} round ${roundIndex + 1}`
        );
        const expectedRoundNumber = roundIndex + 1;
        if (
          round.key !== `${descriptor.key}-g${expectedRoundNumber}` ||
          typeof round.label !== 'string' ||
          round.label.length === 0 ||
          round.assetKey !== descriptor.key ||
          round.seriesKey !== descriptor.key ||
          round.assetPath !== descriptor.assetPath ||
          round.encoding !== descriptor.encoding ||
          round.regionKey !== descriptor.regionKey ||
          round.regionLabel !== descriptor.regionLabel ||
          round.matchNumber !== descriptor.matchNumber ||
          round.roundNumber !== expectedRoundNumber ||
          !Number.isSafeInteger(round.gameId) ||
          round.gameId <= 0 ||
          !Number.isSafeInteger(round.webGameId) ||
          round.webGameId <= 0 ||
          typeof round.winner !== 'string' ||
          round.winner.length === 0 ||
          typeof round.startedLocal !== 'string' ||
          round.startedLocal.length === 0 ||
          round.redSchool !== descriptor.redSchool ||
          round.blueSchool !== descriptor.blueSchool ||
          round.roundCount !== 1 ||
          round.assetRoundCount !== descriptor.roundCount ||
          round.startMs !== nextStartMs ||
          !Number.isSafeInteger(round.endMs) ||
          round.endMs <= round.startMs ||
          round.durationMs !== round.endMs - round.startMs ||
          round.frameStartIndex !== round.startMs / FRAME_MS ||
          round.frameCount !== round.durationMs / FRAME_MS ||
          round.frameCountInRound !== round.frameCount ||
          round.assetFrameCount !== descriptor.frameCount ||
          round.assetDurationMs !== descriptor.durationMs ||
          round.compressedBytes !== descriptor.compressedBytes ||
          round.sha256 !== descriptor.sha256 ||
          seenRoundKeys.has(round.key) ||
          seenGameIds.has(round.gameId) ||
          seenWebGameIds.has(round.webGameId)
        ) {
          fail(`${descriptor.key} G${expectedRoundNumber} descriptor drifted`);
        }
        seenRoundKeys.add(round.key);
        seenGameIds.add(round.gameId);
        seenWebGameIds.add(round.webGameId);
        roundDescriptors.push(round);
        nextStartMs = round.endMs + ROUND_GAP_MS;
      }
      if (nextStartMs !== descriptor.durationMs) {
        fail(`${descriptor.key} round boundaries do not cover the series asset`);
      }
    }
    if (regionRoundCount !== expectedRegion.expectedRounds) {
      fail(`${catalogPath} region ${expectedRegion.key} round total drifted`);
    }
  }
  if (
    descriptors.length !== EXPECTED_SERIES_COUNT ||
    roundCount !== EXPECTED_ROUND_COUNT
  ) {
    fail(`${catalogPath} descriptor totals drifted`);
  }
  if (
    roundDescriptors.length !== EXPECTED_ROUND_COUNT ||
    overviewDescriptors.length !== REGIONS.length
  ) {
    fail(`${catalogPath} round or overview descriptor totals drifted`);
  }
  return { catalog, descriptors, roundDescriptors, overviewDescriptors };
}

function loadRound(database, match) {
  const stateRows = database
    .prepare(
      `
    SELECT
      时刻秒 AS second,
      robot_id AS robotId,
      机器人类型 AS robotType,
      阵营 AS team,
      学校名 AS school,
      当前血量 AS hp,
      最大血量 AS hpMax,
      x, y, z,
      枪口朝向 AS gunHeading,
      底盘功率 AS chassisPower,
      小热量 AS heat17,
      小热量上限 AS heat17Max,
      大热量 AS heat42,
      大热量上限 AS heat42Max,
      累计17mm发弹 AS fired17,
      累计42mm发弹 AS fired42,
      队伍总金币 AS teamTotalCoins,
      队伍剩余金币 AS teamRemainingCoins,
      是否易伤 AS vulnerable
    FROM timeseries
    WHERE game_id=?
    ORDER BY 时刻秒, robot_id
  `
    )
    .all(match.gameId);
  if (stateRows.length === 0)
    fail(`game ${match.gameId} has no timeseries rows`);

  const groupsBySecond = new Map();
  for (const raw of stateRows) {
    const second = exactSecond(
      raw.second,
      `game ${match.gameId} timeseries.second`
    );
    const robotId = nonNegativeInteger(
      raw.robotId,
      `game ${match.gameId} robot_id`
    );
    const group = groupsBySecond.get(second) ?? {
      second,
      robots: [],
      buildings: [],
    };
    groupsBySecond.set(second, group);
    if (
      group.robots.some(state => state.robotId === robotId) ||
      group.buildings.some(state => state.robotId === robotId)
    ) {
      fail(
        `game ${match.gameId} second ${second} duplicates robot_id ${robotId}`
      );
    }
    const expectedTeam = robotId >= 100 ? '蓝' : '红';
    const expectedSchool = robotId >= 100 ? match.blueSchool : match.redSchool;
    if (raw.team !== expectedTeam || raw.school !== expectedSchool) {
      fail(
        `game ${match.gameId} second ${second} robot ${robotId} identity drifted`
      );
    }
    const common = {
      second,
      robotId,
      robotType: raw.robotType,
      team: raw.team,
      school: raw.school,
      hp: finite(raw.hp, `game ${match.gameId} robot ${robotId} hp`),
      hpMax: finite(raw.hpMax, `game ${match.gameId} robot ${robotId} hpMax`),
      teamTotalCoins: finite(
        raw.teamTotalCoins,
        `game ${match.gameId} robot ${robotId} total coins`
      ),
      teamRemainingCoins: finite(
        raw.teamRemainingCoins,
        `game ${match.gameId} robot ${robotId} remaining coins`
      ),
    };
    if (ROBOT_IDS.includes(robotId)) {
      const state = {
        ...common,
        x: finite(raw.x, `game ${match.gameId} robot ${robotId} x`),
        y: finite(raw.y, `game ${match.gameId} robot ${robotId} y`),
        z: finite(raw.z, `game ${match.gameId} robot ${robotId} z`),
        gunHeading: finite(
          raw.gunHeading,
          `game ${match.gameId} robot ${robotId} gun heading`
        ),
        chassisPower: finite(
          raw.chassisPower,
          `game ${match.gameId} robot ${robotId} chassis power`
        ),
        heat17: finite(
          raw.heat17,
          `game ${match.gameId} robot ${robotId} 17mm heat`
        ),
        heat17Max: finite(
          raw.heat17Max,
          `game ${match.gameId} robot ${robotId} 17mm heat max`
        ),
        heat42: finite(
          raw.heat42,
          `game ${match.gameId} robot ${robotId} 42mm heat`
        ),
        heat42Max: finite(
          raw.heat42Max,
          `game ${match.gameId} robot ${robotId} 42mm heat max`
        ),
        fired17:
          raw.fired17 == null
            ? null
            : nonNegativeInteger(
                raw.fired17,
                `game ${match.gameId} robot ${robotId} fired17`
              ),
        fired42:
          raw.fired42 == null
            ? null
            : nonNegativeInteger(
                raw.fired42,
                `game ${match.gameId} robot ${robotId} fired42`
              ),
        vulnerable: nonNegativeInteger(
          raw.vulnerable,
          `game ${match.gameId} robot ${robotId} vulnerable`
        ),
      };
      if (state.hp < 0 || state.hpMax <= 0 || state.hp > state.hpMax)
        fail(`game ${match.gameId} robot ${robotId} invalid hp`);
      if (state.vulnerable !== 0 && state.vulnerable !== 1)
        fail(`game ${match.gameId} robot ${robotId} invalid vulnerable bit`);
      officialLevel(state);
      group.robots.push(state);
    } else if (BUILDING_IDS.includes(robotId)) {
      if (common.hp < 0 || common.hpMax <= 0 || common.hp > common.hpMax)
        fail(`game ${match.gameId} building ${robotId} invalid hp`);
      group.buildings.push(common);
    } else {
      fail(
        `game ${match.gameId} has unsupported timeseries robot_id ${robotId}`
      );
    }
  }

  const groups = [...groupsBySecond.values()].sort(
    (left, right) => left.second - right.second
  );
  const deployedRobotIds = [
    ...new Set(groups.flatMap(group => group.robots.map(state => state.robotId))),
  ].sort((left, right) => left - right);
  if (deployedRobotIds.length === 0)
    fail(`game ${match.gameId} has no deployed robots`);
  const missingRobotSamples = [];
  let previousSecond = 0;
  for (const group of groups) {
    if (group.second !== previousSecond + 1) {
      fail(
        `game ${match.gameId} has missing team second ${previousSecond}->${group.second}`
      );
    }
    previousSecond = group.second;
    const actualRobots = new Set(group.robots.map(state => state.robotId));
    for (const robotId of deployedRobotIds) {
      if (!actualRobots.has(robotId)) {
        missingRobotSamples.push({ robotId, second: group.second });
      }
    }
    const buildings = new Set(group.buildings.map(state => state.robotId));
    if (
      BUILDING_IDS.some(id => !buildings.has(id)) ||
      buildings.size !== BUILDING_IDS.length
    ) {
      fail(`game ${match.gameId} second ${group.second} building set drifted`);
    }
  }
  const sampleMaxSecond = groups.at(-1).second;
  if (
    groups[0].second !== 1 ||
    (sampleMaxSecond !== match.durationSeconds &&
      sampleMaxSecond !== match.durationSeconds - 1)
  ) {
    fail(
      `game ${match.gameId} sample range ${groups[0].second}..${groups.at(-1).second} does not match duration ${match.durationSeconds}`
    );
  }

  for (const robotId of deployedRobotIds) {
    const states = groups.flatMap(group =>
      group.robots.filter(state => state.robotId === robotId)
    );
    if (
      states[0]?.second !== 1 ||
      states.at(-1)?.second !== sampleMaxSecond
    ) {
      fail(
        `game ${match.gameId} robot ${robotId} coverage ${states[0]?.second}..${states.at(-1)?.second} does not span 1..${sampleMaxSecond}`
      );
    }
  }

  const events = database
    .prepare(
      `
    SELECT
      rowid,
      时刻秒 AS second,
      事件类型 AS type,
      robot_id AS robotId,
      机器人类型 AS robotType,
      阵营 AS team,
      学校名 AS school,
      目标robot_id AS targetRobotId,
      目标类型 AS targetType,
      类别 AS category,
      数值 AS value,
      备注 AS note
    FROM events
    WHERE game_id=?
    ORDER BY 时刻秒, rowid
  `
    )
    .all(match.gameId)
    .map(event => {
      const second = exactSecond(
        event.second,
        `game ${match.gameId} event.second`
      );
      if (second > match.durationSeconds) {
        fail(
          `game ${match.gameId} event second ${second} exceeds match duration`
        );
      }
      return {
        ...event,
        second,
        robotId:
          event.robotId == null
            ? null
            : nonNegativeInteger(
                event.robotId,
                `game ${match.gameId} event.robot_id`
              ),
        targetRobotId:
          event.targetRobotId == null
            ? null
            : nonNegativeInteger(
                event.targetRobotId,
                `game ${match.gameId} event.target_robot_id`
              ),
        value:
          event.value == null
            ? null
            : finite(event.value, `game ${match.gameId} event.value`),
      };
    });

  return {
    match,
    groups,
    events,
    byRobot: buildRobotSeries(match.gameId, groups),
    groupBySecond: new Map(groups.map(group => [group.second, group])),
    sampleMaxSecond,
    missingRobotSamples,
  };
}

function buildRobotSeries(gameId, groups) {
  const byRobot = new Map();
  for (const group of groups) {
    for (const state of group.robots) {
      const series = byRobot.get(state.robotId) ?? [];
      series.push(state);
      byRobot.set(state.robotId, series);
    }
  }
  for (const [robotId, states] of byRobot) {
    const caliber = gunCaliberForTeamNumber(teamNumberForRobot(robotId));
    let previousCumulative = 0;
    let previousYaw = officialHeadingToUe(states[0].gunHeading);
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index];
      const before = states[Math.max(0, index - 1)];
      const after = states[Math.min(states.length - 1, index + 1)];
      const dx = after.x - before.x;
      const dy = after.y - before.y;
      if (Math.hypot(dx, dy) >= 0.12)
        previousYaw = normalizeDegrees((Math.atan2(dx, dy) * 180) / Math.PI);
      state.pose = {
        ...officialPositionToUe(state),
        chassisYaw: previousYaw,
        turretYaw: officialHeadingToUe(state.gunHeading),
      };
      const cumulative =
        caliber === 17 ? state.fired17 : caliber === 42 ? state.fired42 : 0;
      if (caliber != null && cumulative == null)
        fail(`game ${gameId} robot ${robotId} missing ${caliber}mm counter`);
      if (caliber === 17 && state.fired42 != null)
        fail(`game ${gameId} robot ${robotId} unexpectedly has 42mm counter`);
      if (caliber === 42 && state.fired17 != null)
        fail(`game ${gameId} robot ${robotId} unexpectedly has 17mm counter`);
      if (cumulative != null && cumulative < previousCumulative)
        fail(`game ${gameId} robot ${robotId} firing counter regressed`);
      state.cumulativeShots = cumulative ?? 0;
      previousCumulative = state.cumulativeShots;
    }
  }
  return byRobot;
}

function loadSeries(database, config) {
  const rows = database
    .prepare(
      `
    SELECT
      赛区 AS region,
      场次号 AS matchNumber,
      赛程 AS schedule,
      局号 AS roundNumber,
      game_id AS gameId,
      web_game_id AS webGameId,
      红方学校 AS redSchool,
      蓝方学校 AS blueSchool,
      胜方 AS winner,
      开始时间 AS startedLocal,
      时长秒 AS durationSeconds
    FROM matches
    WHERE 赛区=? AND 场次号=?
    ORDER BY 局号
  `
    )
    .all(config.region, config.matchNumber);
  if (rows.length !== config.gameIds.length)
    fail(`${config.key} has ${rows.length} rounds`);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (
      row.roundNumber !== index + 1 ||
      row.gameId !== config.gameIds[index] ||
      row.webGameId !== config.webGameIds[index] ||
      row.redSchool !== config.redSchool ||
      row.blueSchool !== config.blueSchool
    ) {
      fail(`${config.key} round ${index + 1} identity drifted`);
    }
    row.durationSeconds = nonNegativeInteger(
      row.durationSeconds,
      `${config.key} round duration`
    );
  }
  return { config, rounds: rows.map(row => loadRound(database, row)) };
}

function teamIdFromSource(team, context) {
  if (team === '红') return 0;
  if (team === '蓝') return 1;
  fail(`${context} has invalid team ${String(team)}`);
}

function economyBucketKey(teamId, second) {
  return `${teamId}:${second}`;
}

function teamCoinsAt(group, teamId, context) {
  const buildingIds = teamId === 0 ? [10, 11] : [110, 111];
  const copies = buildingIds.map(buildingId => {
    const state = group.buildings.find(item => item.robotId === buildingId);
    if (!state) fail(`${context} misses building ${buildingId}`);
    return state;
  });
  const total = nonNegativeInteger(
    copies[0].teamTotalCoins,
    `${context} total coins`
  );
  const remaining = nonNegativeInteger(
    copies[0].teamRemainingCoins,
    `${context} remaining coins`
  );
  if (remaining > total) fail(`${context} remaining coins exceed total coins`);
  for (const copy of copies.slice(1)) {
    if (
      copy.teamTotalCoins !== total ||
      copy.teamRemainingCoins !== remaining
    ) {
      fail(`${context} building coin copies disagree`);
    }
  }
  return { total, remaining };
}

function augmentLifecycle(round) {
  for (const [robotId, states] of round.byRobot) {
    let deathCount = 0;
    let reviveCount = 0;
    let deadSince = null;
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index];
      const previous = states[index - 1];
      if (previous && previous.hp > 0 && state.hp <= 0) {
        deathCount += 1;
        deadSince = state.second;
      }
      if (previous && previous.hp <= 0 && state.hp > 0) {
        reviveCount += 1;
        deadSince = null;
      }
      state.deathCount = deathCount;
      state.reviveCount = reviveCount;
      state.purchaseReviveCount = 0;
      state.purchaseReviveActive = false;
      state.remoteRepairPendingCount = 0;
      state.remoteRepairCountdownMs = 0;
      state.deadSince = state.hp <= 0 ? (deadSince ?? state.second) : null;
      state.nextReviveSecond = null;
      state.reviveProgress = 0;
    }
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index];
      if (state.hp > 0) continue;
      const nextAlive = states
        .slice(index + 1)
        .find(candidate => candidate.hp > 0);
      if (!nextAlive || state.deadSince == null) continue;
      state.nextReviveSecond = nextAlive.second;
      const duration = nextAlive.second - state.deadSince;
      state.reviveProgress =
        duration > 0
          ? Math.max(
              0,
              Math.min(
                1000,
                Math.round(((state.second - state.deadSince) / duration) * 1000)
              )
            )
          : 0;
    }
    if (states.some(state => state.robotId !== robotId))
      fail(`robot series ${robotId} identity drifted`);
  }
}

function projectRoundEconomy(round) {
  const context = `game ${round.match.gameId}`;
  const buckets = new Map();
  const audit = {
    teamSpend: 0,
    paidSupport: 0,
    unclassifiedRemainder: 0,
    purchaseRevive: { count: 0, coins: 0 },
    confirmedRemoteRepair: { count: 0, coins: 0 },
    ambiguousRemoteRepair: { groups: 0, candidates: 0, requiredCoins: 0 },
    ambiguous: 0,
  };

  for (const teamId of [0, 1]) {
    let previousTotal;
    let previousCumulativeSpend = 0;
    for (const group of round.groups) {
      const pointContext = `${context} second ${group.second} team ${teamId}`;
      const coins = teamCoinsAt(group, teamId, pointContext);
      const cumulativeSpend = coins.total - coins.remaining;
      if (previousTotal != null && coins.total < previousTotal)
        fail(`${pointContext} total coins regressed`);
      if (cumulativeSpend < previousCumulativeSpend)
        fail(`${pointContext} cumulative spend regressed`);
      const spend =
        previousTotal == null
          ? cumulativeSpend
          : cumulativeSpend - previousCumulativeSpend;
      const remainder = spend % 10;
      if (![0, 1, 2, 5, 8].includes(remainder)) {
        fail(
          `${pointContext} unsupported non-ammo remainder ${remainder}`
        );
      }
      const paidSupport = remainder === 1 || remainder === 2 ? remainder : 0;
      const unclassifiedRemainder =
        remainder === 5 || remainder === 8 ? remainder : 0;
      buckets.set(economyBucketKey(teamId, group.second), {
        teamId,
        second: group.second,
        spend,
        unassigned: spend - remainder,
      });
      audit.teamSpend += spend;
      audit.paidSupport += paidSupport;
      audit.unclassifiedRemainder += unclassifiedRemainder;
      previousTotal = coins.total;
      previousCumulativeSpend = cumulativeSpend;
    }
  }

  const purchaseReviveSeconds = new Map();
  for (const [robotId, states] of round.byRobot) {
    for (let index = 1; index < states.length; index += 1) {
      const previous = states[index - 1];
      const current = states[index];
      if (previous.hp > 0 || current.hp <= 0) continue;
      if (current.second !== previous.second + 1) {
        fail(`${context} robot ${robotId} revive crosses a source gap`);
      }
      const restoredRatio = current.hp / current.hpMax;
      if (restoredRatio <= 0.25) continue;
      if (restoredRatio < 0.9) {
        fail(
          `${context} robot ${robotId} second ${current.second} ambiguous revive ratio ${restoredRatio}`
        );
      }
      const price =
        Math.ceil((current.second - 1) / 60) * 80 +
        officialLevel(previous) * 20;
      const bucket = buckets.get(
        economyBucketKey(teamIdForRobot(robotId), current.second)
      );
      if (!bucket || bucket.unassigned < price) {
        fail(
          `${context} robot ${robotId} purchase revive ${price} exceeds spend bucket`
        );
      }
      bucket.unassigned -= price;
      const seconds = purchaseReviveSeconds.get(robotId) ?? [];
      seconds.push(current.second);
      purchaseReviveSeconds.set(robotId, seconds);
      audit.purchaseRevive.count += 1;
      audit.purchaseRevive.coins += price;
    }
  }

  const repairCandidates = new Map();
  for (const [robotId, states] of round.byRobot) {
    const teamNumber = teamNumberForRobot(robotId);
    if (![1, 3, 4, 7].includes(teamNumber)) continue;
    for (let index = 1; index < states.length; index += 1) {
      const previous = states[index - 1];
      const current = states[index];
      if (
        current.second !== previous.second + 1 ||
        previous.hp <= 0 ||
        current.hp <= 0 ||
        previous.hpMax !== current.hpMax
      ) {
        continue;
      }
      if (Math.abs(current.hp - previous.hp - current.hpMax * 0.6) > 1e-9)
        continue;
      const purchaseSecond = current.second - 6;
      if (purchaseSecond < 1)
        fail(`${context} robot ${robotId} invalid remote-repair second`);
      const price = 50 + Math.ceil((purchaseSecond - 1) / 60) * 20;
      const key = economyBucketKey(teamIdForRobot(robotId), purchaseSecond);
      const candidates = repairCandidates.get(key) ?? [];
      candidates.push({
        robotId,
        purchaseSecond,
        effectSecond: current.second,
        price,
      });
      repairCandidates.set(key, candidates);
    }
  }

  const confirmedRemoteRepairs = [];
  for (const [key, candidates] of repairCandidates) {
    const bucket = buckets.get(key);
    const required = candidates.reduce(
      (sum, candidate) => sum + candidate.price,
      0
    );
    if (!bucket || bucket.unassigned < required) {
      audit.ambiguousRemoteRepair.groups += 1;
      audit.ambiguousRemoteRepair.candidates += candidates.length;
      audit.ambiguousRemoteRepair.requiredCoins += required;
      continue;
    }
    bucket.unassigned -= required;
    confirmedRemoteRepairs.push(...candidates);
    audit.confirmedRemoteRepair.count += candidates.length;
    audit.confirmedRemoteRepair.coins += required;
  }

  for (const [robotId, states] of round.byRobot) {
    const revives = purchaseReviveSeconds.get(robotId) ?? [];
    const repairs = confirmedRemoteRepairs.filter(
      repair => repair.robotId === robotId
    );
    for (const state of states) {
      state.purchaseReviveCount = revives.filter(
        second => second <= state.second
      ).length;
      state.purchaseReviveActive = revives.some(
        second => second <= state.second && state.second < second + 3
      );
      const pending = repairs.filter(
        repair =>
          repair.purchaseSecond <= state.second &&
          state.second < repair.effectSecond
      );
      state.remoteRepairPendingCount = pending.length;
      state.remoteRepairCountdownMs =
        pending.length === 0
          ? 0
          : Math.min(
              ...pending.map(
                repair => (repair.effectSecond - state.second) * 1000
              )
            );
    }
  }

  for (const bucket of buckets.values()) {
    if (bucket.unassigned < 0 || bucket.unassigned % 10 !== 0) {
      fail(
        `${context} invalid residual spend ${bucket.unassigned} at ${bucket.teamId}:${bucket.second}`
      );
    }
    audit.ambiguous += bucket.unassigned;
  }
  const classified =
    audit.paidSupport +
    audit.unclassifiedRemainder +
    audit.purchaseRevive.coins +
    audit.confirmedRemoteRepair.coins +
    audit.ambiguous;
  if (classified !== audit.teamSpend)
    fail(`${context} economy ledger does not balance`);
  return { buckets, audit, confirmedRemoteRepairs };
}

function surroundingStates(states, second) {
  if (states.length === 0) fail('cannot sample an empty robot series');
  let left = states[0];
  let right = states.at(-1);
  for (const state of states) {
    if (state.second <= second) left = state;
    if (state.second >= second) {
      right = state;
      break;
    }
  }
  return { left, right };
}

function cumulativeShotsAt(states, second) {
  const { left, right } = surroundingStates(states, second);
  if (left.second === right.second) return left.cumulativeShots;
  const alpha = (second - left.second) / (right.second - left.second);
  return Math.round(
    left.cumulativeShots +
      (right.cumulativeShots - left.cumulativeShots) * alpha
  );
}

function shotSupportedAmmoProjection(round, economy) {
  const schedules = new Map();
  const initialByRobot = new Map();
  const purchasedByTeamCaliber = new Map([
    ['0:17', 0],
    ['0:42', 0],
    ['1:17', 0],
    ['1:42', 0],
  ]);
  const allocatedCoinsByTeam = [0, 0];
  const unallocatedCoinsByTeam = [0, 0];

  for (const [robotId] of round.byRobot) {
    const teamNumber = teamNumberForRobot(robotId);
    const initial = teamNumber === 7 ? 300 : teamNumber === 6 ? 750 : 0;
    initialByRobot.set(robotId, initial);
    schedules.set(robotId, []);
  }

  const exhaustionSecond = (robotId, allowance, fromSecond) => {
    const states = round.byRobot.get(robotId);
    if (!states) fail(`missing series for robot ${robotId}`);
    for (
      let second = fromSecond;
      second <= round.match.durationSeconds;
      second += 1
    ) {
      if (cumulativeShotsAt(states, second) > allowance) return second;
    }
    return Number.POSITIVE_INFINITY;
  };

  const buckets = [...economy.buckets.values()]
    .filter(bucket => bucket.unassigned > 0)
    .sort(
      (left, right) => left.second - right.second || left.teamId - right.teamId
    );
  for (const bucket of buckets) {
    let credits = bucket.unassigned / 10;
    while (credits > 0) {
      const candidates = [];
      for (const [robotId, states] of round.byRobot) {
        if (teamIdForRobot(robotId) !== bucket.teamId) continue;
        const teamNumber = teamNumberForRobot(robotId);
        const caliber = gunCaliberForTeamNumber(teamNumber);
        if (caliber == null || teamNumber === 6) continue;
        const cap = caliber === 17 ? 1000 : 100;
        const key = `${bucket.teamId}:${caliber}`;
        const purchased = purchasedByTeamCaliber.get(key);
        const unit = caliber === 17 ? 10 : 1;
        if (purchased == null || purchased + unit > cap) continue;
        const schedule = schedules.get(robotId);
        if (!schedule) fail(`missing ammo schedule for robot ${robotId}`);
        const allowance =
          initialByRobot.get(robotId) +
          schedule.reduce((sum, purchase) => sum + purchase.rounds, 0);
        candidates.push({
          robotId,
          caliber,
          unit,
          exhaustion: exhaustionSecond(robotId, allowance, bucket.second),
          states,
        });
      }
      candidates.sort(
        (left, right) =>
          left.exhaustion - right.exhaustion || left.robotId - right.robotId
      );
      const selected = candidates[0];
      if (!selected || !Number.isFinite(selected.exhaustion)) break;
      schedules.get(selected.robotId).push({
        second: bucket.second,
        rounds: selected.unit,
        source: 'ambiguous-team-spend',
      });
      const key = `${bucket.teamId}:${selected.caliber}`;
      purchasedByTeamCaliber.set(
        key,
        purchasedByTeamCaliber.get(key) + selected.unit
      );
      allocatedCoinsByTeam[bucket.teamId] += 10;
      credits -= 1;
    }
    unallocatedCoinsByTeam[bucket.teamId] += credits * 10;
  }

  const anomalies = [];
  const perRobot = [];
  for (const [robotId, states] of round.byRobot) {
    const teamNumber = teamNumberForRobot(robotId);
    const caliber = gunCaliberForTeamNumber(teamNumber);
    if (caliber == null) continue;
    const initial = initialByRobot.get(robotId);
    const purchases = schedules.get(robotId);
    const purchasedRounds = purchases.reduce(
      (sum, purchase) => sum + purchase.rounds,
      0
    );
    const firstOfficialShots = states[0].cumulativeShots;
    const firstInferredPurchasedRounds = purchases
      .filter(purchase => purchase.second <= states[0].second)
      .reduce((sum, purchase) => sum + purchase.rounds, 0);
    const firstEstimatedAllowance = Math.max(
      0,
      initial + firstInferredPurchasedRounds - firstOfficialShots
    );
    const finalShots = states.at(-1).cumulativeShots;
    const unexplainedShots = Math.max(
      0,
      finalShots - initial - purchasedRounds
    );
    if (teamNumber === 6 && finalShots > 750) {
      anomalies.push({
        robotId,
        kind: 'aerial-over-allowance',
        rounds: finalShots - 750,
      });
    } else if (unexplainedShots > 0) {
      anomalies.push({
        robotId,
        kind: 'shots-beyond-observable-allocation',
        rounds: unexplainedShots,
      });
    }
    perRobot.push({
      robotId,
      caliber,
      initial,
      firstOfficialShots,
      firstInferredPurchasedRounds,
      firstEstimatedAllowance,
      inferredPurchasedRounds: purchasedRounds,
      finalOfficialShots: finalShots,
      finalEstimatedAllowance: Math.max(
        0,
        initial + purchasedRounds - finalShots
      ),
      unexplainedShots,
    });
  }

  return {
    schema: AMMO_INFERENCE_SCHEMA,
    method:
      'minimum-shot-supported deterministic allocation of ambiguous 10-coin spend',
    schedules,
    initialByRobot,
    audit: {
      allocatedCoinsByTeam,
      unallocatedCoinsByTeam,
      perRobot,
      anomalies,
    },
  };
}

function parseRuneNote(event, context) {
  const match =
    /^arm_cnt=([0-9]+(?:\.[0-9]+)?),avg_round=([0-9]+(?:\.[0-9]+)?)$/.exec(
      event.note ?? ''
    );
  if (!match) fail(`${context} has invalid rune note ${String(event.note)}`);
  const lightCount = Number(match[1]);
  const averageRound = Number(match[2]);
  if (!Number.isSafeInteger(lightCount) || !Number.isFinite(averageRound)) {
    fail(`${context} has non-integral arm count or non-finite average`);
  }
  return { lightCount, averageRound };
}

function bigRuneProjection(event, context) {
  const { lightCount, averageRound } = parseRuneNote(event, context);
  if (lightCount < 5 || lightCount > 10)
    fail(`${context} has invalid completed arm count ${lightCount}`);
  const tier =
    averageRound <= 3
      ? 1
      : averageRound <= 7
        ? 2
        : averageRound <= 8
          ? 3
          : averageRound <= 9
            ? 4
            : 5;
  const values = {
    1: { defense: 250, attack: 500, cold: 0 },
    2: { defense: 250, attack: 500, cold: 1000 },
    3: { defense: 250, attack: 1000, cold: 1000 },
    4: { defense: 250, attack: 1000, cold: 2000 },
    5: { defense: 500, attack: 2000, cold: 4000 },
  };
  const durationByLight = { 5: 30, 6: 35, 7: 40, 8: 45, 9: 50, 10: 60 };
  return {
    kind: 'big',
    tier,
    lightCount,
    defense: values[tier].defense,
    attack: values[tier].attack,
    cold: values[tier].cold,
    durationSeconds: durationByLight[lightCount],
  };
}

function completedBigRunes(round) {
  const candidatesByTeam = new Map([
    [0, []],
    [1, []],
  ]);
  for (const event of round.events) {
    if (event.type !== '能量机关' || event.category !== 'rune_type=0.0')
      continue;
    const context = `game ${round.match.gameId} second ${event.second} big rune`;
    const parsed = parseRuneNote(event, context);
    if (parsed.lightCount < 5) continue;
    const teamId = teamIdFromSource(event.team, context);
    candidatesByTeam.get(teamId).push({ event, ...parsed, teamId });
  }
  const completions = [];
  for (const [teamId, candidates] of candidatesByTeam) {
    let cluster = [];
    const flush = () => {
      if (cluster.length === 0) return;
      const final = cluster.at(-1);
      completions.push({
        event: final.event,
        teamId,
        projection: bigRuneProjection(
          final.event,
          `game ${round.match.gameId} second ${final.event.second} big rune completion`
        ),
      });
      cluster = [];
    };
    for (const candidate of candidates) {
      const previous = cluster.at(-1);
      if (
        previous &&
        candidate.lightCount > previous.lightCount &&
        candidate.event.second - previous.event.second <= 2
      ) {
        cluster.push(candidate);
      } else {
        flush();
        cluster.push(candidate);
      }
    }
    flush();
  }
  return completions.sort(
    (left, right) =>
      left.event.second - right.event.second ||
      left.event.rowid - right.event.rowid
  );
}

function completedSmallRunes(round) {
  return round.events
    .filter(event => {
      if (event.type !== '能量机关' || event.category !== 'rune_type=1.0')
        return false;
      const { lightCount } = parseRuneNote(
        event,
        `game ${round.match.gameId} second ${event.second} small rune`
      );
      return lightCount === 5;
    })
    .map(event => ({
      event,
      teamId: teamIdFromSource(
        event.team,
        `game ${round.match.gameId} second ${event.second} small rune`
      ),
      projection: {
        kind: 'small',
        tier: 0,
        lightCount: 5,
        defense: 250,
        attack: 0,
        cold: 0,
        durationSeconds: 45,
      },
    }));
}

function hpAt(round, entityId, second) {
  if (ROBOT_IDS.includes(entityId)) {
    const states = round.byRobot.get(entityId);
    if (!states) return null;
    return surroundingStates(states, second).left.hp;
  }
  const group = round.groupBySecond.get(
    Math.min(second, round.sampleMaxSecond)
  );
  const state = group?.buildings.find(item => item.robotId === entityId);
  if (!state)
    fail(
      `game ${round.match.gameId} second ${second} misses building ${entityId}`
    );
  return state.hp;
}

function projectRoundBuffs(round) {
  const bigRunes = completedBigRunes(round);
  const smallRunes = completedSmallRunes(round);
  const bigCompletionByRow = new Map(
    bigRunes.map(item => [item.event.rowid, item])
  );
  const smallCompletionByRow = new Map(
    smallRunes.map(item => [item.event.rowid, item])
  );
  const entityIds = [...round.byRobot.keys(), ...BUILDING_IDS];
  const stateByEntity = new Map(
    entityIds.map(entityId => [
      entityId,
      {
        terrain: null,
        rune: null,
        suspendedUntil: 0,
        wasAlive: hpAt(round, entityId, 1) > 0,
      },
    ])
  );
  const framesBySecond = new Map();
  const assemblyCounts = [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ];
  const assemblyMax = [0, 0];
  const dartRandomHitCount = [0, 0];
  const audit = {
    smallRuneCompletions: smallRunes.length,
    bigRuneCompletions: bigRunes.length,
    bigRuneCrossTeamRows: 0,
    bigRuneMissingRecipientGroups: 0,
    assemblyLevels: { 1: 0, 2: 0, 3: 0, 4: 0 },
    terrainOverlaps: 0,
    terrainEventsForDefeated: 0,
    dartBuffCounterEvents: 0,
  };

  for (const completion of bigRunes) {
    const recipients = round.events.filter(
      event =>
        event.type === '增益' &&
        event.category === '大能量机关增益' &&
        event.second >= completion.event.second &&
        event.second <= completion.event.second + 1
    );
    if (
      recipients.filter(
        event =>
          teamIdFromSource(event.team, 'big-rune recipient') ===
          completion.teamId
      ).length === 0
    ) {
      audit.bigRuneMissingRecipientGroups += 1;
    }
    audit.bigRuneCrossTeamRows += recipients.filter(
      event =>
        teamIdFromSource(event.team, 'big-rune recipient') !== completion.teamId
    ).length;
  }

  const eventsBySecond = new Map();
  for (const event of round.events) {
    const list = eventsBySecond.get(event.second) ?? [];
    list.push(event);
    eventsBySecond.set(event.second, list);
  }

  const applyRune = (completion, second) => {
    for (const entityId of entityIds) {
      if (
        teamIdForRobot(entityId) !== completion.teamId ||
        hpAt(round, entityId, second) <= 0
      )
        continue;
      stateByEntity.get(entityId).rune = {
        ...completion.projection,
        expires: second + completion.projection.durationSeconds,
      };
    }
  };

  for (let second = 1; second <= round.match.durationSeconds; second += 1) {
    for (const entityId of entityIds) {
      const state = stateByEntity.get(entityId);
      const alive = hpAt(round, entityId, second) > 0;
      if (state.terrain && state.terrain.expires <= second)
        state.terrain = null;
      if (state.rune && state.rune.expires <= second) state.rune = null;
      if (state.wasAlive && !alive) state.terrain = null;
      state.wasAlive = alive;
    }

    for (const event of eventsBySecond.get(second) ?? []) {
      const context = `game ${round.match.gameId} second ${second} ${event.type}`;
      if (event.type === '装配成功') {
        const match = /^等级([1-4])$/.exec(event.category ?? '');
        if (!match)
          fail(
            `${context} has invalid assembly category ${String(event.category)}`
          );
        const level = Number(match[1]);
        const teamId = teamIdFromSource(event.team, context);
        assemblyCounts[teamId][level] += 1;
        assemblyMax[teamId] = Math.max(assemblyMax[teamId], level);
        audit.assemblyLevels[level] += 1;
        continue;
      }
      const smallCompletion = smallCompletionByRow.get(event.rowid);
      if (smallCompletion) {
        applyRune(smallCompletion, second);
        continue;
      }
      const bigCompletion = bigCompletionByRow.get(event.rowid);
      if (bigCompletion) {
        applyRune(bigCompletion, second);
        continue;
      }
      if (
        event.type === '增益' &&
        ['台阶跨越', '过中央高地', '飞坡'].includes(event.category)
      ) {
        if (
          !ROBOT_IDS.includes(event.robotId) ||
          !stateByEntity.has(event.robotId)
        ) {
          fail(
            `${context} terrain buff has invalid robot ${String(event.robotId)}`
          );
        }
        const state = stateByEntity.get(event.robotId);
        if (hpAt(round, event.robotId, second) <= 0) {
          audit.terrainEventsForDefeated += 1;
          continue;
        }
        const duration =
          event.category === '台阶跨越'
            ? 5
            : event.category === '过中央高地'
              ? 30
              : 30;
        const kind =
          event.category === '台阶跨越'
            ? 'road'
            : event.category === '过中央高地'
              ? 'highland'
              : 'ramp';
        if (state.terrain && state.terrain.expires > second) {
          state.terrain.defense = 500;
          state.terrain.expires = Math.max(
            state.terrain.expires,
            second + duration
          );
          state.terrain.categoryExpiries[kind] = Math.max(
            state.terrain.categoryExpiries[kind] ?? 0,
            second + duration
          );
          state.terrain.refreshed = true;
          audit.terrainOverlaps += 1;
        } else {
          state.terrain = {
            defense: 250,
            expires: second + duration,
            categoryExpiries: { [kind]: second + duration },
            refreshed: false,
          };
        }
        continue;
      }
      if (
        event.type === '飞镖命中' &&
        [10, 110].includes(event.targetRobotId)
      ) {
        const targetTeam = event.targetRobotId >= 100 ? 1 : 0;
        if (event.value === 300) {
          const hitIndex = dartRandomHitCount[targetTeam];
          const duration = [10, 5, 3, 2][hitIndex];
          if (duration == null)
            fail(`${context} has more than four 300-damage counter hits`);
          dartRandomHitCount[targetTeam] += 1;
          audit.dartBuffCounterEvents += 1;
          for (const entityId of entityIds) {
            if (teamIdForRobot(entityId) !== targetTeam) continue;
            const state = stateByEntity.get(entityId);
            if (state.terrain || state.rune) {
              state.suspendedUntil = Math.max(
                state.suspendedUntil,
                second + duration
              );
            }
          }
        } else if (event.value === 625 || event.value === 1000) {
          audit.dartBuffCounterEvents += 1;
          for (const entityId of entityIds) {
            if (teamIdForRobot(entityId) !== targetTeam) continue;
            const state = stateByEntity.get(entityId);
            state.terrain = null;
            state.rune = null;
          }
        }
      }
    }

    const projected = new Map();
    for (const entityId of entityIds) {
      const state = stateByEntity.get(entityId);
      const teamId = teamIdForRobot(entityId);
      const teamNumber = teamNumberForRobot(entityId);
      const assemblyDefense =
        teamNumber === 6
          ? 0
          : assemblyMax[teamId] >= 4
            ? 500
            : assemblyMax[teamId] >= 3
              ? 250
              : 0;
      const suppressed = state.suspendedUntil > second;
      const terrain = !suppressed ? state.terrain : null;
      const rune = !suppressed ? state.rune : null;
      const categoryActive = kind =>
        terrain && (terrain.categoryExpiries[kind] ?? 0) > second ? 1 : 0;
      projected.set(entityId, {
        defense: Math.max(
          assemblyDefense,
          terrain?.defense ?? 0,
          rune?.defense ?? 0
        ),
        attack: rune?.attack ?? 0,
        cold: rune?.cold ?? 0,
        terrainRoad: categoryActive('road'),
        terrainHighland: categoryActive('highland'),
        terrainRamp: categoryActive('ramp'),
        terrainDefense: terrain ? 1 : 0,
        terrainRefresh: terrain?.refreshed ? 1 : 0,
        teamDefense: Math.max(
          assemblyDefense === 500 ? 2 : assemblyDefense === 250 ? 1 : 0,
          (rune?.defense ?? 0) === 500
            ? 2
            : (rune?.defense ?? 0) === 250
              ? 1
              : 0
        ),
        smallRune: rune?.kind === 'small' ? 1 : 0,
        bigRuneTier: rune?.kind === 'big' ? rune.tier : 0,
        bigRuneLightCount: rune?.kind === 'big' ? rune.lightCount : 0,
        suspended: suppressed ? 1 : 0,
        hpColorSwitch: rune ? 2 : 0,
        assemblyMaxLevel: assemblyMax[teamId],
        assemblyCounts: assemblyCounts[teamId].slice(),
      });
    }
    framesBySecond.set(second, projected);
  }

  return {
    schema: BUFF_PROJECTION_SCHEMA,
    framesBySecond,
    bigRunes,
    smallRunes,
    audit,
  };
}

function interpolateRankedShots(left, right, alpha) {
  const delta = right.cumulativeShots - left.cumulativeShots;
  if (delta < 0)
    fail(`robot ${left.robotId} firing counter regressed during interpolation`);
  if (delta === 0 || alpha <= 0) return left.cumulativeShots;
  if (alpha >= 1) return right.cumulativeShots;
  const fired = Math.min(delta, Math.floor(alpha * (delta + 1) + 1e-9));
  return left.cumulativeShots + fired;
}

function ammoAllowanceAt(ammo, robotId, targetSecond, cumulativeShots) {
  const initial = ammo.initialByRobot.get(robotId);
  const schedule = ammo.schedules.get(robotId);
  if (initial == null || !schedule)
    fail(`robot ${robotId} has no ammo inference state`);
  const replenished = schedule
    .filter(purchase => purchase.second <= targetSecond)
    .reduce((sum, purchase) => sum + purchase.rounds, 0);
  return Math.max(0, initial + replenished - cumulativeShots);
}

function robotAttributesAt(preparedRound, robotId, localMs) {
  const states = preparedRound.round.byRobot.get(robotId);
  if (!states)
    fail(
      `robot ${robotId} is not present in round ${preparedRound.round.match.gameId}`
    );
  const unclampedSecond = 1 + localMs / 1000;
  const targetSecond = Math.max(
    1,
    Math.min(preparedRound.round.sampleMaxSecond, unclampedSecond)
  );
  const { left, right } = surroundingStates(states, targetSecond);
  const alpha =
    left.second === right.second
      ? 0
      : (targetSecond - left.second) / (right.second - left.second);
  const pose = {
    x: roundNumber(left.pose.x + (right.pose.x - left.pose.x) * alpha),
    y: roundNumber(left.pose.y + (right.pose.y - left.pose.y) * alpha),
    z: roundNumber(left.pose.z + (right.pose.z - left.pose.z) * alpha),
    chassisYaw: roundNumber(
      interpolateAngle(left.pose.chassisYaw, right.pose.chassisYaw, alpha)
    ),
    turretYaw: roundNumber(
      interpolateAngle(left.pose.turretYaw, right.pose.turretYaw, alpha)
    ),
  };
  const cumulativeShots = interpolateRankedShots(left, right, alpha);
  const teamNumber = teamNumberForRobot(robotId);
  const caliber = gunCaliberForTeamNumber(teamNumber);
  const classId = classForTeamNumber(teamNumber);
  const health = interpolateHealth(left, right, alpha);
  const leftHeat = caliber === 42 ? left.heat42 : left.heat17;
  const rightHeat = caliber === 42 ? right.heat42 : right.heat17;
  const leftHeatMax = caliber === 42 ? left.heat42Max : left.heat17Max;
  const rightHeatMax = caliber === 42 ? right.heat42Max : right.heat17Max;
  const firingHeat = interpolateAnchoredValue(
    leftHeat,
    rightHeat,
    alpha,
    leftHeatMax !== rightHeatMax || (left.hp <= 0 && right.hp > 0)
  );
  const stepSecond = Math.max(
    1,
    Math.min(preparedRound.round.sampleMaxSecond, Math.floor(targetSecond))
  );
  const buffs = preparedRound.buffs.framesBySecond
    .get(stepSecond)
    ?.get(robotId);
  if (!buffs)
    fail(
      `game ${preparedRound.round.match.gameId} robot ${robotId} second ${stepSecond} lacks buff state`
    );
  const deadProgress =
    left.hp <= 0 && left.deadSince != null && left.nextReviveSecond != null
      ? Math.max(
          0,
          Math.min(
            1000,
            Math.round(
              ((targetSecond - left.deadSince) /
                (left.nextReviveSecond - left.deadSince)) *
                1000
            )
          )
        )
      : left.reviveProgress;
  const attributes = {
    [A.Health]: health,
    [A.ReviveCount]: left.reviveCount,
    [A.PurchaseReviveCount]: left.purchaseReviveCount,
    [A.FiringHeat1]: firingHeat,
    [A.FiringHeat2]: 0,
    [A.ReviveProgress]: deadProgress,
    [A.ReviveSpeed]: left.hp <= 0 ? 1 : 0,
    [A.ChassisPower]: roundNumber(left.chassisPower),
    [A.PlayerID]: robotId,
    [A.TeamID]: teamIdForRobot(robotId),
    [A.TeamNumber]: teamNumber,
    [A.RemoteRepairPendingCount]: left.remoteRepairPendingCount,
    [A.RemoteRepairCountdownMs]: left.remoteRepairCountdownMs,
    [A.WorldPosX]: pose.x,
    [A.WorldPosY]: pose.y,
    [A.WorldPosZ]: pose.z,
    [A.ChassisYaw]: pose.chassisYaw,
    [A.TurretYaw]: pose.turretYaw,
    [A.TurretPitch]: 0,
    [A.FiringLocked]: left.hp <= 0 ? 1 : 0,
    [A.Defeated]: left.hp <= 0 ? 1 : 0,
    [A.Invincible]: 0,
    [A.IsChassisOnline]: 1,
    [A.HasGun]: caliber == null ? 0 : 1,
    [A.HasTerrainCrossingRoadBuff]: buffs.terrainRoad,
    [A.HasTerrainCrossingHighlandBuff]: buffs.terrainHighland,
    [A.HasTerrainCrossingRampBuff]: buffs.terrainRamp,
    [A.HasTerrainCrossingDefenseBuff]: buffs.terrainDefense,
    [A.HasTerrainCrossingRefreshBuff]: buffs.terrainRefresh,
    [A.HasTeamDefenseBuff]: buffs.teamDefense,
    [A.HasSmallRuneBuff]: buffs.smallRune,
    [A.BigRuneBuffArmCount]: buffs.bigRuneTier,
    [A.BigRuneBuffLightCount]: buffs.bigRuneLightCount,
    [A.DartCounterBuffSuspended]: buffs.suspended,
    [A.HPMainColorSwitch]: buffs.hpColorSwitch,
    [A.HPSideColorSwitch]: buffs.hpColorSwitch,
    [A.HPProgress]: roundNumber(health / left.hpMax, 6),
    [A.Class]: classId,
    [A.Level]: officialLevel(left),
    [A.HealthMax]: left.hpMax,
    [A.FiringHeatMax1]: caliber === 42 ? left.heat42Max : left.heat17Max,
    [A.FiringHeatMax2]: 0,
    [A.ReviveProgressMax]: 1000,
    [A.AttackMultiplierThou]: buffs.attack,
    [A.DefenseMultiplierThou]: buffs.defense,
    [A.ColdMultiplierThou]: buffs.cold,
    [A.RadarDoubleVulnerabilityActive]: left.vulnerable,
    [A.BulletFiredTotal]: cumulativeShots,
  };
  if (classId === CLASS_ID.Engineer) {
    attributes[A.EngineerAssemblyMaxCompletedLevel] = buffs.assemblyMaxLevel;
  }
  if (caliber != null) {
    const allowance = ammoAllowanceAt(
      preparedRound.ammo,
      robotId,
      targetSecond,
      cumulativeShots
    );
    if (!Number.isSafeInteger(allowance) || allowance < 0)
      fail(`robot ${robotId} has invalid ammo ${allowance}`);
    if (caliber === 17) attributes[A.Ammo17mmCount] = allowance;
    else attributes[A.Ammo42mmCount] = allowance;
  }
  return attributes;
}

function structureLifecycle(round, buildingId, sampleSecond) {
  let previousHp;
  let deadSince = null;
  let reviveCount = 0;
  let nextReviveSecond = null;
  for (const group of round.groups) {
    const state = group.buildings.find(item => item.robotId === buildingId);
    if (!state)
      fail(
        `game ${round.match.gameId} second ${group.second} misses building ${buildingId}`
      );
    if (previousHp != null && previousHp > 0 && state.hp <= 0)
      deadSince = group.second;
    if (previousHp != null && previousHp <= 0 && state.hp > 0) {
      reviveCount += 1;
      deadSince = null;
    }
    previousHp = state.hp;
    if (group.second >= sampleSecond) break;
  }
  if (deadSince != null) {
    for (const group of round.groups) {
      if (group.second <= sampleSecond) continue;
      const state = group.buildings.find(item => item.robotId === buildingId);
      if (state?.hp > 0) {
        nextReviveSecond = group.second;
        break;
      }
    }
  }
  const progress =
    deadSince != null && nextReviveSecond != null
      ? Math.round(
          ((sampleSecond - deadSince) / (nextReviveSecond - deadSince)) * 1000
        )
      : 0;
  return { reviveCount, progress };
}

function prepareOutpostProjection(round) {
  const fixedHitCounts = [0, 0];
  const baseDeployMs = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  for (const event of round.events) {
    if (event.type !== '飞镖命中' || ![10, 110].includes(event.targetRobotId))
      continue;
    const targetTeam = event.targetRobotId >= 100 ? 1 : 0;
    if (event.value === 200 || event.value === 300) {
      fixedHitCounts[targetTeam] += 1;
      if (fixedHitCounts[targetTeam] >= 4) {
        baseDeployMs[targetTeam] = Math.min(
          baseDeployMs[targetTeam],
          (event.second - 1) * 1000
        );
      }
    } else if (event.value === 625 || event.value === 1000) {
      baseDeployMs[targetTeam] = Math.min(
        baseDeployMs[targetTeam],
        (event.second - 1) * 1000
      );
    }
  }
  const stopMs = [180_000, 180_000];
  for (const teamId of [0, 1]) {
    const buildingId = teamId === 0 ? 11 : 111;
    const defeated = round.groups.find(group => {
      const state = group.buildings.find(item => item.robotId === buildingId);
      if (!state)
        fail(
          `game ${round.match.gameId} second ${group.second} misses outpost ${buildingId}`
        );
      return state.hp <= 0;
    });
    if (defeated)
      stopMs[teamId] = Math.min(stopMs[teamId], (defeated.second - 1) * 1000);
  }
  for (const baseTeamId of [0, 1]) {
    if (Number.isFinite(baseDeployMs[baseTeamId])) {
      stopMs[1 - baseTeamId] = Math.min(
        stopMs[1 - baseTeamId],
        baseDeployMs[baseTeamId]
      );
    }
  }
  const sign = round.match.gameId % 2 === 0 ? 1 : -1;
  return { baseDeployMs, stopMs, sign };
}

function advanceOutpost(state, stopRequested) {
  const dt = FRAME_MS / 1000;
  state.stopRequested ||= stopRequested;
  if (!state.stopRequested) {
    state.angle += state.speed * dt;
    return;
  }
  if (Math.abs(state.speed) <= Number.EPSILON) return;
  const sign = state.speed > 0 ? 1 : -1;
  const absoluteSpeed = Math.abs(state.speed);
  if (!state.braking) {
    const brakeDistance = (absoluteSpeed * absoluteSpeed) / (2 * 72);
    const normalized = ((state.angle % 360) + 360) % 360;
    let remaining = sign > 0 ? 360 - normalized : normalized;
    if (remaining <= 0.001) remaining = 360;
    if (remaining <= brakeDistance) state.braking = true;
    else {
      state.angle += state.speed * dt;
      return;
    }
  }
  const nextSpeed = absoluteSpeed - 72 * dt;
  if (nextSpeed <= 0) {
    state.speed = 0;
    state.angle =
      sign > 0
        ? Math.ceil(state.angle / 360) * 360
        : Math.floor(state.angle / 360) * 360;
  } else {
    state.speed = sign * nextSpeed;
    state.angle += state.speed * dt;
  }
}

function structureAttributesAt(
  preparedRound,
  buildingId,
  localMs,
  rotationState
) {
  const targetSecond = Math.max(
    1,
    Math.min(
      preparedRound.round.sampleMaxSecond,
      1 + localMs / 1000
    )
  );
  const sampleSecond = Math.max(
    1,
    Math.min(
      preparedRound.round.sampleMaxSecond,
      Math.floor(targetSecond)
    )
  );
  const nextSecond = Math.min(
    preparedRound.round.sampleMaxSecond,
    Math.ceil(targetSecond)
  );
  const group = preparedRound.round.groupBySecond.get(sampleSecond);
  const nextGroup = preparedRound.round.groupBySecond.get(nextSecond);
  if (!group || !nextGroup)
    fail(
      `game ${preparedRound.round.match.gameId} misses building interpolation seconds ${sampleSecond}/${nextSecond}`
    );
  const state = group.buildings.find(item => item.robotId === buildingId);
  const nextState = nextGroup.buildings.find(
    item => item.robotId === buildingId
  );
  if (!state || !nextState)
    fail(
      `game ${preparedRound.round.match.gameId} misses building ${buildingId}`
    );
  const alpha = nextSecond === sampleSecond ? 0 : targetSecond - sampleSecond;
  const health = interpolateHealth(state, nextState, alpha);
  const definition = STRUCTURES[buildingId];
  const buffs = preparedRound.buffs.framesBySecond
    .get(sampleSecond)
    ?.get(buildingId);
  if (!definition || !buffs)
    fail(`building ${buildingId} lacks replay definition`);
  const lifecycle = structureLifecycle(
    preparedRound.round,
    buildingId,
    sampleSecond
  );
  const outpostId = definition.teamId === 0 ? 11 : 111;
  const outpostLifecycle = structureLifecycle(
    preparedRound.round,
    outpostId,
    sampleSecond
  );
  const attributes = {
    [A.Health]: health,
    [A.TeamID]: definition.teamId,
    [A.TeamNumber]: definition.kind === 'base' ? 8 : 9,
    [A.WorldPosX]: definition.x,
    [A.WorldPosY]: definition.y,
    [A.WorldPosZ]: definition.z,
    [A.ChassisYaw]: definition.yaw,
    [A.TurretYaw]: definition.yaw,
    [A.Defeated]: state.hp <= 0 ? 1 : 0,
    [A.HPMainColorSwitch]: buffs.hpColorSwitch,
    [A.HPSideColorSwitch]: buffs.hpColorSwitch,
    [A.HPProgress]: roundNumber(health / state.hpMax, 6),
    [A.Class]: definition.classId,
    [A.HealthMax]: state.hpMax,
    [A.AttackMultiplierThou]: buffs.attack,
    [A.DefenseMultiplierThou]: buffs.defense,
    [A.ColdMultiplierThou]: buffs.cold,
    [A.HasTeamDefenseBuff]: buffs.teamDefense,
    [A.HasSmallRuneBuff]: buffs.smallRune,
    [A.BigRuneBuffArmCount]: buffs.bigRuneTier,
    [A.BigRuneBuffLightCount]: buffs.bigRuneLightCount,
    [A.DartCounterBuffSuspended]: buffs.suspended,
    [A.TeamCoins]: state.teamRemainingCoins,
  };
  if (definition.kind === 'base') {
    attributes[A.BaseState] =
      localMs >= preparedRound.outpost.baseDeployMs[definition.teamId] ? 1 : 0;
    attributes[A.TeamOutpostRebuildCount] = outpostLifecycle.reviveCount;
    attributes[A.TeamDartBaseHitCount] = preparedRound.round.events.filter(
      event =>
        event.type === '飞镖命中' &&
        event.targetRobotId === buildingId &&
        event.second <= sampleSecond
    ).length;
    attributes[A.RMUC2026TechL1] = buffs.assemblyCounts[1];
    attributes[A.RMUC2026TechL2] = buffs.assemblyCounts[2];
    attributes[A.RMUC2026TechL3] = buffs.assemblyCounts[3];
    attributes[A.RMUC2026TechL4] = buffs.assemblyCounts[4];
  } else {
    attributes[A.ReviveCount] = lifecycle.reviveCount;
    attributes[A.ReviveProgress] = lifecycle.progress;
    attributes[A.ReviveProgressMax] = 1000;
    if (!rotationState) fail(`outpost ${buildingId} lacks rotation state`);
    attributes[A.OutpostAngularSpeed] = Math.round(rotationState.speed * 1000);
    attributes[A.OutpostRotationStopRequested] = rotationState.stopRequested
      ? 1
      : 0;
  }
  return attributes;
}

function globalAttributesAt(preparedRound, localMs) {
  return {
    [A.GlobalMaxGameTime]: preparedRound.round.match.durationSeconds * 1000,
    [A.GlobalCurrentGameTime]: Math.min(
      preparedRound.round.match.durationSeconds * 1000,
      Math.max(0, localMs)
    ),
    [A.GlobalCurrentMapId]: 4,
    [A.GlobalMatchStarted]: 1,
    [A.GlobalBaseId0]: STRUCTURES[10].mapId,
    [A.GlobalBaseId0 + 1]: STRUCTURES[110].mapId,
    [A.GlobalOutpostId0]: STRUCTURES[11].mapId,
    [A.GlobalOutpostId0 + 1]: STRUCTURES[111].mapId,
    [A.GlobalBuffStationId0]: 2,
  };
}

function runeAttributes() {
  return {
    [A.WorldPosX]: 0,
    [A.WorldPosY]: 0,
    [A.WorldPosZ]: 90,
    [A.Class]: CLASS_ID.Building,
    70000001: 0,
    70000003: 0,
  };
}

function attributeDiff(previous, current) {
  const diff = {};
  for (const [key, value] of Object.entries(current)) {
    if (previous?.[key] !== value) diff[key] = value;
  }
  return diff;
}

function mapSnapshotAt(preparedRound, localMs, rotationStates) {
  const maps = new Map();
  maps.set(1, globalAttributesAt(preparedRound, localMs));
  maps.set(2, runeAttributes());
  for (const [robotId] of preparedRound.round.byRobot) {
    maps.set(
      robotMapId(robotId),
      robotAttributesAt(preparedRound, robotId, localMs)
    );
  }
  for (const buildingId of BUILDING_IDS) {
    const rotationState =
      buildingId === 11
        ? rotationStates[0]
        : buildingId === 111
          ? rotationStates[1]
          : null;
    maps.set(
      STRUCTURES[buildingId].mapId,
      structureAttributesAt(preparedRound, buildingId, localMs, rotationState)
    );
  }
  return maps;
}

function update(syncType, attributeMapId, attributes) {
  return { sync_type: syncType, attribute_map_id: attributeMapId, attributes };
}

function prepareSeries(series) {
  let cursorMs = 0;
  const rounds = [];
  for (const round of series.rounds) {
    augmentLifecycle(round);
    const economy = projectRoundEconomy(round);
    const ammo = shotSupportedAmmoProjection(round, economy);
    const buffs = projectRoundBuffs(round);
    const startMs = cursorMs;
    const endMs = startMs + round.match.durationSeconds * 1000;
    rounds.push({
      round,
      economy,
      ammo,
      buffs,
      outpost: prepareOutpostProjection(round),
      startMs,
      endMs,
    });
    cursorMs = endMs + ROUND_GAP_MS;
  }
  return {
    ...series,
    preparedRounds: rounds,
    durationMs: cursorMs,
    frameCount: cursorMs / FRAME_MS,
  };
}

function* replayFrames(preparedSeries) {
  let roundIndex = 0;
  let active = null;
  let previousMaps = null;
  let rotationStates = null;
  for (let t = 0; t < preparedSeries.durationMs; t += FRAME_MS) {
    const nextRound = preparedSeries.preparedRounds[roundIndex];
    if (!active && nextRound && t === nextRound.startMs) {
      active = nextRound;
      const speed = nextRound.outpost.sign * 144;
      rotationStates = [
        {
          angle: 0,
          speed,
          stopRequested: nextRound.outpost.stopMs[0] <= 0,
          braking: false,
        },
        {
          angle: 0,
          speed,
          stopRequested: nextRound.outpost.stopMs[1] <= 0,
          braking: false,
        },
      ];
      previousMaps = null;
    }

    let updates = [];
    if (active && t < active.endMs) {
      const localMs = t - active.startMs;
      if (localMs > 0) {
        advanceOutpost(rotationStates[0], localMs >= active.outpost.stopMs[0]);
        advanceOutpost(rotationStates[1], localMs >= active.outpost.stopMs[1]);
      }
      const maps = mapSnapshotAt(active, localMs, rotationStates);
      if (previousMaps == null) {
        updates = [...maps]
          .sort((left, right) => left[0] - right[0])
          .map(([mapId, attributes]) => update(0, mapId, attributes));
      } else {
        for (const [mapId, attributes] of [...maps].sort(
          (left, right) => left[0] - right[0]
        )) {
          const diff = attributeDiff(previousMaps.get(mapId), attributes);
          const robotHeartbeat =
            mapId >= 1000 && localMs > 0 && localMs % 2000 === 0;
          if (Object.keys(diff).length > 0 || robotHeartbeat) {
            updates.push(update(1, mapId, diff));
          }
        }
      }
      previousMaps = maps;
    } else if (active && t === active.endMs) {
      updates = [...previousMaps.keys()]
        .sort((left, right) => left - right)
        .map(mapId => update(2, mapId, {}));
      active = null;
      previousMaps = null;
      rotationStates = null;
      roundIndex += 1;
    }

    yield {
      t,
      result: {
        cycle_event_type: CYCLE_EVENT_TYPE,
        watch_attribute_maps_results: updates,
      },
    };
  }
  if (roundIndex !== preparedSeries.preparedRounds.length) {
    fail(
      `${preparedSeries.config.key} frame generator ended after ${roundIndex} rounds`
    );
  }
}

function economyMetadata(economy) {
  return {
    teamSpend: economy.audit.teamSpend,
    paidSupport: economy.audit.paidSupport,
    unclassifiedRemainder: economy.audit.unclassifiedRemainder,
    purchaseRevive: economy.audit.purchaseRevive,
    confirmedRemoteRepair: economy.audit.confirmedRemoteRepair,
    ambiguousRemoteRepair: economy.audit.ambiguousRemoteRepair,
    ambiguous: economy.audit.ambiguous,
  };
}

function replayEnvelope(preparedSeries, databaseSha256) {
  const sourceAudit = preparedSeries.preparedRounds.reduce(
    (audit, prepared) => {
      for (const group of prepared.round.groups) {
        audit.robotSamples += group.robots.length;
        audit.vulnerableBooleanSamples += group.robots.filter(
          state => state.vulnerable === 1
        ).length;
      }
      audit.buffEventRows += prepared.round.events.filter(
        event => event.type === '增益'
      ).length;
      return audit;
    },
    { robotSamples: 0, vulnerableBooleanSamples: 0, buffEventRows: 0 }
  );
  const roundMetadata = preparedSeries.preparedRounds.map(prepared => ({
    roundNumber: prepared.round.match.roundNumber,
    gameId: prepared.round.match.gameId,
    webGameId: prepared.round.match.webGameId,
    winner: prepared.round.match.winner,
    startedLocal: prepared.round.match.startedLocal,
    durationSeconds: prepared.round.match.durationSeconds,
    startMs: prepared.startMs,
    endMs: prepared.endMs,
    robotIds: [...prepared.round.byRobot.keys()].sort(
      (left, right) => left - right
    ),
    missingRobotSamples: prepared.round.missingRobotSamples,
    economy: economyMetadata(prepared.economy),
    ammo: prepared.ammo.audit,
    buffs: prepared.buffs.audit,
  }));
  return {
    schema: REPLAY_SCHEMA,
    frameCount: preparedSeries.frameCount,
    durationMs: preparedSeries.durationMs,
    map: {
      mapId: 'RMUC2026',
      lines: [],
      bounds: {
        min: { x: -836, y: -1500, z: -50 },
        max: { x: 836, y: 1500, z: 300 },
      },
    },
    source: {
      competition: 'RMUC2026',
      region: preparedSeries.config.region,
      officialMatchNumber: preparedSeries.config.matchNumber,
      label: preparedSeries.config.label,
      teams: {
        red: preparedSeries.config.redSchool,
        blue: preparedSeries.config.blueSchool,
      },
      database: 'rmuc_2026_region_dataset.sqlite',
      databaseSha256,
      articleUrl: DATASET_ARTICLE_URL,
      license: 'CC BY-NC-SA 4.0',
      playbackModel: 'client-render-only',
      damageAuthority: 'official timeseries 当前血量',
      rulesEffective: preparedSeries.config.rulesEffective,
      ruleSourceSha256: RULE_SOURCE_SHA256,
      rounds: roundMetadata,
    },
    interpolation: {
      sourceCadenceHz: 1,
      outputCadenceHz: 10,
      frameMs: FRAME_MS,
      position: 'linear between adjacent official samples',
      angle: 'shortest-arc between adjacent samples',
      chassisHeading:
        'inferred by central-difference trajectory direction; holds below 0.12 m displacement',
      shots:
        'official cumulative deltas distributed at rank (shotIndex+1)/(delta+1); ammo drops on the same 100ms frame',
      continuousFields: [
        'health (except revive and max-change intervals)',
        'firing heat (except revive and max-change intervals)',
      ],
      heldFields: [
        'healthMax',
        'firingHeatMax',
        'defeated',
        'level',
        'coins',
        'buff state',
      ],
      physics: 'none',
    },
    inference: {
      ammo: {
        schema: AMMO_INFERENCE_SCHEMA,
        projection:
          'deterministic estimate, not an official remaining-ammo field',
        exact: {
          aerial:
            'max(0, 750 - official cumulative 17mm shots); excess shots are retained as an anomaly',
          initial: { hero42: 0, infantry17: 0, sentry17: 300, aerial17: 750 },
        },
        pointEstimate:
          'after exact support/buyback/repair deductions, ambiguous 10-coin credits are assigned only while future observed shots require them, earliest exhaustion first',
        safeBounds: {
          hero42: '[0, min(100, floor(cumulative residual spend / 10))]',
          infantry17: '[0, min(1000, cumulative residual spend)]',
          sentry17:
            '[max(0,300-cumulativeShots), max(0,300+min(1000,residualSpend)+100*min(6,floor(t/60))-cumulativeShots)]',
        },
        omittedUnknownSources: [
          'supply-zone occupancy',
          'sentry free-pool withdrawal timing',
          'fortress free-ammo recipient and timing',
          'price-colliding non-ammo purchases',
        ],
      },
      buffs: {
        schema: BUFF_PROJECTION_SCHEMA,
        sourceValues:
          'official 增益 rows have NULL 数值; deterministic values come from the public RMUC2026 rule tables',
        authoritativeActivation:
          'same-team 能量机关 completion, not corrupted/incomplete recipient rows',
        vulnerability:
          '是否易伤 is projected as the icon-only RadarDoubleVulnerabilityActive boolean; its source and numeric multiplier are not recoverable and DamageMultiplierThou is intentionally omitted',
        sourceAudit,
        values: BUFF_RULE_VALUES,
      },
      engineer:
        'assembly level/counts are exact from 装配成功; carried cores and unused team stock are unavailable and omitted',
      outpostRotation:
        'official dataset omits angle/direction; direction is deterministic from game-id parity, speed/braking/stops use RMUC2026 rules',
    },
  };
}

async function writeChunk(stream, text) {
  if (!stream.write(text, 'utf8')) await once(stream, 'drain');
}

async function writeReplay(preparedSeries, databaseSha256, outputPath) {
  const envelope = replayEnvelope(preparedSeries, databaseSha256);
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await fs.mkdir(dirname(outputPath), { recursive: true });
  const stream = createGzip({ level: 9 });
  const destination = createWriteStream(temporary, { flags: 'wx' });
  const completed = pipeline(stream, destination);
  try {
    const prefix = JSON.stringify(envelope);
    await writeChunk(stream, `${prefix.slice(0, -1)},"frames":[`);
    let count = 0;
    for (const frame of replayFrames(preparedSeries)) {
      if (count > 0) await writeChunk(stream, ',');
      await writeChunk(stream, JSON.stringify(frame));
      count += 1;
    }
    if (count !== preparedSeries.frameCount) {
      fail(
        `${preparedSeries.config.key} emitted ${count} frames, expected ${preparedSeries.frameCount}`
      );
    }
    await writeChunk(stream, ']}\n');
    stream.end();
    await completed;
    await fs.rm(outputPath, { force: true });
    await fs.rename(temporary, outputPath);
  } catch (error) {
    stream.destroy();
    destination.destroy();
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function validateProjectedBuffState(attributes, context) {
  const bitIds = [
    A.HasTerrainCrossingDefenseBuff,
    A.HasTerrainCrossingRefreshBuff,
    A.HasSmallRuneBuff,
    A.DartCounterBuffSuspended,
    A.RadarDoubleVulnerabilityActive,
  ];
  for (const id of bitIds) {
    if (attributes[id] !== 0 && attributes[id] !== 1)
      fail(`${context} has invalid buff bit ${id}=${String(attributes[id])}`);
  }
  const teamDefense = attributes[A.HasTeamDefenseBuff];
  if (![0, 1, 2].includes(teamDefense))
    fail(`${context} has invalid team-defense tier ${String(teamDefense)}`);
  const bigRuneTier = attributes[A.BigRuneBuffArmCount];
  if (!Number.isSafeInteger(bigRuneTier) || bigRuneTier < 0 || bigRuneTier > 5)
    fail(`${context} has invalid big-rune tier ${String(bigRuneTier)}`);
  const lightCount = attributes[A.BigRuneBuffLightCount];
  if (
    !Number.isSafeInteger(lightCount) ||
    (bigRuneTier === 0 ? lightCount !== 0 : lightCount < 5 || lightCount > 10)
  ) {
    fail(`${context} has invalid big-rune light count ${String(lightCount)}`);
  }
  if (
    attributes[A.HasTerrainCrossingRefreshBuff] === 1 &&
    attributes[A.HasTerrainCrossingDefenseBuff] !== 1
  ) {
    fail(`${context} has terrain refresh without terrain defense`);
  }
  const bigRune =
    bigRuneTier === 0
      ? { defenseThou: 0, attackThou: 0, coldThou: 0 }
      : BUFF_RULE_VALUES.bigRune[`tier${bigRuneTier}`];
  if (!bigRune)
    fail(`${context} has no rule values for big-rune tier ${bigRuneTier}`);
  const expectedDefense = Math.max(
    teamDefense * 250,
    attributes[A.HasTerrainCrossingDefenseBuff] === 1
      ? attributes[A.HasTerrainCrossingRefreshBuff] === 1
        ? 500
        : 250
      : 0,
    attributes[A.HasSmallRuneBuff] === 1 ? 250 : 0,
    bigRune.defenseThou
  );
  if (
    attributes[A.DefenseMultiplierThou] !== expectedDefense ||
    attributes[A.AttackMultiplierThou] !== bigRune.attackThou ||
    attributes[A.ColdMultiplierThou] !== bigRune.coldThou
  ) {
    fail(
      `${context} multiplier values do not match their projected source tags`
    );
  }
}

function validateRoundAmmoMetadata(round, context) {
  if (
    !round.ammo ||
    !Array.isArray(round.ammo.perRobot) ||
    !Array.isArray(round.ammo.allocatedCoinsByTeam) ||
    round.ammo.allocatedCoinsByTeam.length !== 2
  ) {
    fail(`${context} has invalid ammo audit metadata`);
  }
  const expectedRobotIds = round.robotIds
    .filter(
      robotId => gunCaliberForTeamNumber(teamNumberForRobot(robotId)) != null
    )
    .sort((left, right) => left - right);
  const seen = new Set();
  const allocatedCoinsByTeam = [0, 0];
  const purchasedByTeamCaliber = new Map();
  for (const item of round.ammo.perRobot) {
    if (
      !item ||
      !Number.isSafeInteger(item.robotId) ||
      seen.has(item.robotId) ||
      !expectedRobotIds.includes(item.robotId)
    ) {
      fail(`${context} has invalid ammo robot ${String(item?.robotId)}`);
    }
    seen.add(item.robotId);
    const teamId = teamIdForRobot(item.robotId);
    const teamNumber = teamNumberForRobot(item.robotId);
    const caliber = gunCaliberForTeamNumber(teamNumber);
    const expectedInitial = teamNumber === 7 ? 300 : teamNumber === 6 ? 750 : 0;
    for (const key of [
      'initial',
      'firstOfficialShots',
      'firstInferredPurchasedRounds',
      'firstEstimatedAllowance',
      'inferredPurchasedRounds',
      'finalOfficialShots',
      'finalEstimatedAllowance',
      'unexplainedShots',
    ]) {
      if (!Number.isSafeInteger(item[key]) || item[key] < 0)
        fail(`${context} robot ${item.robotId} has invalid ammo ${key}`);
    }
    if (item.caliber !== caliber || item.initial !== expectedInitial)
      fail(
        `${context} robot ${item.robotId} has invalid caliber or initial ammo`
      );
    if (
      item.firstEstimatedAllowance !==
        Math.max(
          0,
          item.initial +
            item.firstInferredPurchasedRounds -
            item.firstOfficialShots
        ) ||
      item.firstInferredPurchasedRounds > item.inferredPurchasedRounds
    ) {
      fail(`${context} robot ${item.robotId} has inconsistent first allowance`);
    }
    if (
      item.finalEstimatedAllowance !==
      Math.max(
        0,
        item.initial + item.inferredPurchasedRounds - item.finalOfficialShots
      )
    ) {
      fail(`${context} robot ${item.robotId} has inconsistent final allowance`);
    }
    if (teamNumber === 6 && item.inferredPurchasedRounds !== 0)
      fail(`${context} aerial ${item.robotId} has inferred purchases`);
    const key = `${teamId}:${caliber}`;
    purchasedByTeamCaliber.set(
      key,
      (purchasedByTeamCaliber.get(key) ?? 0) + item.inferredPurchasedRounds
    );
    allocatedCoinsByTeam[teamId] +=
      caliber === 17
        ? item.inferredPurchasedRounds
        : item.inferredPurchasedRounds * 10;
  }
  if (
    seen.size !== expectedRobotIds.length ||
    expectedRobotIds.some(robotId => !seen.has(robotId))
  ) {
    fail(`${context} ammo audit does not cover every firing robot`);
  }
  for (const [key, purchased] of purchasedByTeamCaliber) {
    const caliber = Number(key.split(':')[1]);
    if (purchased > (caliber === 17 ? 1000 : 100))
      fail(`${context} ammo purchases exceed the team caliber cap`);
  }
  if (
    allocatedCoinsByTeam.some(
      (coins, teamId) => coins !== round.ammo.allocatedCoinsByTeam[teamId]
    )
  ) {
    fail(`${context} allocated ammo coins do not match the per-robot audit`);
  }
}

function validateReplayIdentity(value, path, expected) {
  if (expected == null) return;
  const expectedRegion =
    typeof expected.region === 'string'
      ? expected.region
      : REGIONS.find(region => region.key === expected.regionKey)?.sourceName;
  if (expectedRegion == null)
    fail(`${path} expected replay region is invalid`);
  if (
    value.source?.competition !== 'RMUC2026' ||
    value.source?.region !== expectedRegion ||
    value.source?.officialMatchNumber !== expected.matchNumber ||
    value.source?.label !== expected.label ||
    value.source?.teams?.red !== expected.redSchool ||
    value.source?.teams?.blue !== expected.blueSchool
  ) {
    fail(`${path} replay identity does not match its catalog entry`);
  }
  const rounds = value.source?.rounds;
  if (!Array.isArray(rounds) || rounds.length !== expected.roundCount) {
    fail(`${path} replay round count does not match its catalog entry`);
  }
  if (!Array.isArray(expected.rounds)) return;
  let expectedStartMs = 0;
  for (let index = 0; index < expected.rounds.length; index += 1) {
    const actual = rounds[index];
    const identity = expected.rounds[index];
    const identityDurationSeconds =
      Number.isSafeInteger(identity.durationSeconds) && identity.durationSeconds > 0
        ? identity.durationSeconds
        : Number.isSafeInteger(identity.durationMs) &&
            identity.durationMs > 0 &&
            identity.durationMs % 1000 === 0
          ? identity.durationMs / 1000
          : fail(`${path} expected round ${index + 1} duration is invalid`);
    const expectedEndMs =
      expectedStartMs + identityDurationSeconds * 1000;
    if (
      actual?.roundNumber !== identity.roundNumber ||
      actual?.gameId !== identity.gameId ||
      actual?.webGameId !== identity.webGameId ||
      actual?.winner !== identity.winner ||
      actual?.startedLocal !== identity.startedLocal ||
      actual?.durationSeconds !== identityDurationSeconds ||
      actual?.startMs !== expectedStartMs ||
      actual?.endMs !== expectedEndMs
    ) {
      fail(`${path} round ${index + 1} identity or timing drifted`);
    }
    expectedStartMs = expectedEndMs + ROUND_GAP_MS;
  }
  if (value.durationMs !== expectedStartMs) {
    fail(`${path} duration does not match its official round timings`);
  }
}

function validateReplayObject(value, path, expected = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} root is not an object`);
  if (value.schema !== REPLAY_SCHEMA)
    fail(`${path} schema is ${String(value.schema)}`);
  if (!Array.isArray(value.frames) || value.frames.length === 0)
    fail(`${path} has no frames`);
  if (value.frameCount !== value.frames.length)
    fail(`${path} frameCount does not match frames`);
  if (
    !Number.isSafeInteger(value.durationMs) ||
    value.durationMs !== value.frames.length * FRAME_MS
  ) {
    fail(`${path} duration does not equal frameCount * ${FRAME_MS}`);
  }
  if (value.source?.databaseSha256 !== EXPECTED_DATABASE_SHA256) {
    fail(`${path} source database hash drifted`);
  }
  if (value.source?.license !== 'CC BY-NC-SA 4.0')
    fail(`${path} source license is missing`);
  validateReplayIdentity(value, path, expected);
  if (value.inference?.ammo?.schema !== AMMO_INFERENCE_SCHEMA)
    fail(`${path} ammo inference schema is missing`);
  if (value.inference?.buffs?.schema !== BUFF_PROJECTION_SCHEMA)
    fail(`${path} buff inference schema is missing`);
  if (
    value.interpolation?.sourceCadenceHz !== 1 ||
    value.interpolation?.outputCadenceHz !== 10 ||
    value.interpolation?.frameMs !== FRAME_MS ||
    JSON.stringify(value.interpolation?.continuousFields) !==
      JSON.stringify([
        'health (except revive and max-change intervals)',
        'firing heat (except revive and max-change intervals)',
      ])
  ) {
    fail(`${path} interpolation contract drifted`);
  }
  if (
    JSON.stringify(value.inference?.buffs?.values) !==
    JSON.stringify(BUFF_RULE_VALUES)
  ) {
    fail(`${path} buff rule metadata drifted`);
  }
  const vulnerabilitySamples =
    value.inference?.buffs?.sourceAudit?.vulnerableBooleanSamples;
  if (!Number.isSafeInteger(vulnerabilitySamples) || vulnerabilitySamples < 0)
    fail(`${path} vulnerability source audit is invalid`);
  if (value.map?.mapId !== 'RMUC2026' || !Array.isArray(value.map?.lines)) {
    fail(`${path} map descriptor is invalid`);
  }

  const robotLastUpdate = new Map();
  const groundAmmoBudget = new Map();
  const currentMaps = new Map();
  const roundByTime = value.source.rounds;
  if (!Array.isArray(roundByTime) || roundByTime.length === 0)
    fail(`${path} source rounds are invalid`);
  for (const round of roundByTime)
    validateRoundAmmoMetadata(
      round,
      `${path} round ${String(round?.roundNumber)}`
    );
  let sawVulnerability = false;
  for (let index = 0; index < value.frames.length; index += 1) {
    const frame = value.frames[index];
    if (frame.t !== index * FRAME_MS)
      fail(`${path} frame ${index} timestamp drifted`);
    const updates = frame.result?.watch_attribute_maps_results;
    if (!Array.isArray(updates))
      fail(`${path} frame ${index} has invalid result`);
    if (frame.result.cycle_event_type !== CYCLE_EVENT_TYPE)
      fail(`${path} frame ${index} cycle type drifted`);
    for (const item of updates) {
      if (![0, 1, 2].includes(item.sync_type))
        fail(`${path} frame ${index} invalid sync type`);
      if (
        !Number.isSafeInteger(item.attribute_map_id) ||
        item.attribute_map_id <= 0
      ) {
        fail(`${path} frame ${index} invalid attribute map id`);
      }
      if (
        !item.attributes ||
        typeof item.attributes !== 'object' ||
        Array.isArray(item.attributes)
      ) {
        fail(`${path} frame ${index} invalid attributes`);
      }
      if (item.sync_type === 2 && Object.keys(item.attributes).length !== 0) {
        fail(`${path} frame ${index} recycle carries attributes`);
      }
      if (item.attribute_map_id >= 1000 && item.sync_type !== 2) {
        robotLastUpdate.set(item.attribute_map_id, frame.t);
      }
      for (const [attributeId, attributeValue] of Object.entries(
        item.attributes
      )) {
        if (
          !/^[1-9]\d*$/.test(attributeId) ||
          !Number.isFinite(attributeValue)
        ) {
          fail(`${path} frame ${index} has invalid attribute ${attributeId}`);
        }
        const numericId = Number(attributeId);
        if (
          (numericId === A.Ammo17mmCount || numericId === A.Ammo42mmCount) &&
          (!Number.isSafeInteger(attributeValue) || attributeValue < 0)
        ) {
          fail(
            `${path} frame ${index} has invalid launch allowance ${attributeValue}`
          );
        }
        if (
          (numericId === A.Health || numericId === A.FiringHeat1) &&
          attributeValue < 0
        ) {
          fail(
            `${path} frame ${index} has negative continuous state ${numericId}=${attributeValue}`
          );
        }
        if (
          numericId === A.HPProgress &&
          (attributeValue < 0 || attributeValue > 1)
        ) {
          fail(`${path} frame ${index} has invalid HP progress ${attributeValue}`);
        }
        if (
          numericId === A.DefenseMultiplierThou &&
          ![0, 250, 500].includes(attributeValue)
        ) {
          fail(
            `${path} frame ${index} invalid defense multiplier ${attributeValue}`
          );
        }
        if (
          numericId === A.AttackMultiplierThou &&
          ![0, 500, 1000, 2000].includes(attributeValue)
        ) {
          fail(
            `${path} frame ${index} invalid attack multiplier ${attributeValue}`
          );
        }
        if (
          numericId === A.ColdMultiplierThou &&
          ![0, 1000, 2000, 4000].includes(attributeValue)
        ) {
          fail(
            `${path} frame ${index} invalid cold multiplier ${attributeValue}`
          );
        }
        if (numericId === 61000002)
          fail(`${path} fabricates unavailable vulnerability magnitude`);
        if (
          numericId === A.RadarDoubleVulnerabilityActive &&
          attributeValue !== 0 &&
          attributeValue !== 1
        ) {
          fail(`${path} frame ${index} has invalid vulnerability bit`);
        }
        if (numericId === A.EngineerTeamEnergyUnitStock) {
          fail(`${path} fabricates unavailable engineer energy-unit stock`);
        }
      }
      if (item.sync_type === 2) {
        currentMaps.delete(item.attribute_map_id);
      } else {
        const previous =
          item.sync_type === 1 ? currentMaps.get(item.attribute_map_id) : null;
        currentMaps.set(item.attribute_map_id, {
          ...(previous ?? {}),
          ...item.attributes,
        });
      }
    }
    const round = roundByTime.find(
      item => frame.t >= item.startMs && frame.t < item.endMs
    );
    if (round) {
      if (frame.t === round.startMs) {
        const fullMapIds = new Set(
          updates
            .filter(item => item.sync_type === 0)
            .map(item => item.attribute_map_id)
        );
        for (const requiredMapId of [
          1,
          2,
          ...round.robotIds.map(robotMapId),
          ...BUILDING_IDS.map(buildingId => STRUCTURES[buildingId].mapId),
        ]) {
          if (!fullMapIds.has(requiredMapId)) {
            fail(
              `${path} round ${round.roundNumber} initial snapshot misses map ${requiredMapId}`
            );
          }
        }
      }
      for (const robotId of round.robotIds) {
        const mapId = robotMapId(robotId);
        const last = robotLastUpdate.get(mapId);
        if (last == null || frame.t - last >= 3500) {
          fail(
            `${path} frame ${index} robot ${robotId} violates replay heartbeat`
          );
        }
        const attributes = currentMaps.get(mapId);
        if (!attributes)
          fail(`${path} frame ${index} robot ${robotId} is not materialized`);
        validateProjectedBuffState(
          attributes,
          `${path} frame ${index} robot ${robotId}`
        );
        if (attributes[A.RadarDoubleVulnerabilityActive] === 1)
          sawVulnerability = true;
        if (attributes[A.Class] === CLASS_ID.Aerial) {
          const fired = attributes[A.BulletFiredTotal];
          const allowance = attributes[A.Ammo17mmCount];
          if (
            !Number.isSafeInteger(fired) ||
            allowance !== Math.max(0, 750 - fired)
          ) {
            fail(
              `${path} frame ${index} aerial ${robotId} violates exact allowance projection`
            );
          }
        } else {
          const caliber = gunCaliberForTeamNumber(teamNumberForRobot(robotId));
          if (caliber != null) {
            const fired = attributes[A.BulletFiredTotal];
            const ammoId = caliber === 17 ? A.Ammo17mmCount : A.Ammo42mmCount;
            const allowance = attributes[ammoId];
            if (
              !Number.isSafeInteger(fired) ||
              !Number.isSafeInteger(allowance) ||
              allowance < 0
            ) {
              fail(
                `${path} frame ${index} robot ${robotId} has invalid ammo state`
              );
            }
            const budget = fired + allowance;
            const previous = groundAmmoBudget.get(mapId);
            let knownAllocation;
            if (frame.t === round.startMs) {
              const audit = round.ammo.perRobot.find(
                item => item.robotId === robotId
              );
              if (
                !audit ||
                fired !== audit.firstOfficialShots ||
                allowance !== audit.firstEstimatedAllowance ||
                budget !==
                  audit.firstOfficialShots + audit.firstEstimatedAllowance
              )
                fail(
                  `${path} round ${round.roundNumber} robot ${robotId} has invalid first ammo state`
                );
              knownAllocation =
                audit.initial + audit.firstInferredPurchasedRounds;
            } else if (previous?.roundStartMs === round.startMs) {
              if (budget < previous.budget) {
                fail(
                  `${path} frame ${index} robot ${robotId} ammo budget regressed`
                );
              }
              if (allowance > 0) {
                const increase = budget - previous.knownAllocation;
                if (
                  increase < 0 ||
                  increase % (caliber === 17 ? 10 : 1) !== 0
                ) {
                  fail(
                    `${path} frame ${index} robot ${robotId} has invalid inferred purchase`
                  );
                }
                knownAllocation = budget;
              } else {
                if (budget !== fired || fired < previous.knownAllocation) {
                  fail(
                    `${path} frame ${index} robot ${robotId} has inconsistent exhausted ammo`
                  );
                }
                knownAllocation = previous.knownAllocation;
              }
            } else {
              fail(`${path} frame ${index} robot ${robotId} lost ammo history`);
            }
            groundAmmoBudget.set(mapId, {
              roundStartMs: round.startMs,
              budget,
              knownAllocation,
            });
            if (frame.t === round.endMs - FRAME_MS) {
              const audit = round.ammo.perRobot.find(
                item => item.robotId === robotId
              );
              if (
                !audit ||
                fired !== audit.finalOfficialShots ||
                allowance !== audit.finalEstimatedAllowance ||
                budget !==
                  Math.max(
                    audit.initial + audit.inferredPurchasedRounds,
                    audit.finalOfficialShots
                  )
              ) {
                fail(
                  `${path} round ${round.roundNumber} robot ${robotId} final ammo does not match audit`
                );
              }
            }
          }
        }
      }
    }
  }
  if (
    !value.frames[0].result.watch_attribute_maps_results.some(
      item => item.sync_type === 0
    )
  ) {
    fail(`${path} first frame is not a full snapshot`);
  }
  if (vulnerabilitySamples > 0 && !sawVulnerability)
    fail(`${path} omits the official vulnerability boolean trajectory`);
}

async function validateReplayFile(path, expected = null) {
  if (!existsSync(path) || !statSync(path).isFile())
    fail(`replay asset does not exist: ${path}`);
  if (!path.endsWith('.json.gzip'))
    fail(`replay asset must be gzip JSON: ${path}`);
  const compressed = await fs.readFile(path);
  let decoded;
  try {
    decoded = await gunzipAsync(compressed);
  } catch (error) {
    fail(`${path} is not valid gzip: ${error.message}`);
  }
  const parsed = JSON.parse(decoded.toString('utf8'));
  validateReplayObject(parsed, path, expected);
  return {
    bytes: statSync(path).size,
    sha256: await sha256File(path),
    frames: parsed.frameCount,
    durationMs: parsed.durationMs,
  };
}

function addNestedCounts(target, source) {
  for (const [key, value] of Object.entries(source))
    target[key] = (target[key] ?? 0) + value;
}

function createDatasetAudit() {
  return {
    buffCategories: {},
    smallRuneCompletions: 0,
    bigRuneCompletions: 0,
    bigRuneTiers: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    bigRuneCrossTeamRows: 0,
    bigRuneMissingRecipientGroups: 0,
    assemblyLevels: { 1: 0, 2: 0, 3: 0, 4: 0 },
    vulnerableRobotSamples: 0,
    robotSamples: 0,
    robotSeries: 0,
    missingRobotSamples: 0,
    terrainOverlaps: 0,
    terrainEventsForDefeated: 0,
    dartBuffCounterEvents: 0,
    economy: {
      teamSpend: 0,
      paidSupport: 0,
      unclassifiedRemainder: 0,
      purchaseReviveCount: 0,
      purchaseReviveCoins: 0,
      confirmedRemoteRepairCount: 0,
      confirmedRemoteRepairCoins: 0,
      ambiguousRemoteRepairGroups: 0,
      ambiguousRemoteRepairCandidates: 0,
      ambiguousRemoteRepairRequiredCoins: 0,
      ambiguous: 0,
    },
  };
}

function addSeriesToDatasetAudit(audit, series) {
  for (const prepared of series.preparedRounds) {
    audit.robotSeries += prepared.round.byRobot.size;
    audit.missingRobotSamples += prepared.round.missingRobotSamples.length;
    for (const group of prepared.round.groups) {
      audit.robotSamples += group.robots.length;
      audit.vulnerableRobotSamples += group.robots.filter(
        state => state.vulnerable === 1
      ).length;
    }
    for (const event of prepared.round.events) {
      if (
        event.type === '增益' &&
        event.category in EXPECTED_SOURCE_AUDIT.buffCategories
      ) {
        audit.buffCategories[event.category] =
          (audit.buffCategories[event.category] ?? 0) + 1;
      }
    }
    const buffs = prepared.buffs.audit;
    audit.smallRuneCompletions += buffs.smallRuneCompletions;
    audit.bigRuneCompletions += buffs.bigRuneCompletions;
    for (const completion of prepared.buffs.bigRunes) {
      const tier = completion.projection.tier;
      if (!Number.isSafeInteger(tier) || tier < 1 || tier > 5) {
        fail(
          `game ${prepared.round.match.gameId} has invalid big-rune tier ${tier}`
        );
      }
      audit.bigRuneTiers[tier] += 1;
    }
    audit.bigRuneCrossTeamRows += buffs.bigRuneCrossTeamRows;
    audit.bigRuneMissingRecipientGroups += buffs.bigRuneMissingRecipientGroups;
    addNestedCounts(audit.assemblyLevels, buffs.assemblyLevels);
    audit.terrainOverlaps += buffs.terrainOverlaps;
    audit.terrainEventsForDefeated += buffs.terrainEventsForDefeated;
    audit.dartBuffCounterEvents += buffs.dartBuffCounterEvents;
    const economy = prepared.economy.audit;
    audit.economy.teamSpend += economy.teamSpend;
    audit.economy.paidSupport += economy.paidSupport;
    audit.economy.unclassifiedRemainder += economy.unclassifiedRemainder;
    audit.economy.purchaseReviveCount += economy.purchaseRevive.count;
    audit.economy.purchaseReviveCoins += economy.purchaseRevive.coins;
    audit.economy.confirmedRemoteRepairCount +=
      economy.confirmedRemoteRepair.count;
    audit.economy.confirmedRemoteRepairCoins +=
      economy.confirmedRemoteRepair.coins;
    audit.economy.ambiguousRemoteRepairGroups +=
      economy.ambiguousRemoteRepair.groups;
    audit.economy.ambiguousRemoteRepairCandidates +=
      economy.ambiguousRemoteRepair.candidates;
    audit.economy.ambiguousRemoteRepairRequiredCoins +=
      economy.ambiguousRemoteRepair.requiredCoins;
    audit.economy.ambiguous += economy.ambiguous;
  }
}

function validateDatasetAudit(audit) {
  for (const [key, expected] of Object.entries(EXPECTED_SOURCE_AUDIT)) {
    if (key === 'buffCategories' || key === 'assemblyLevels') continue;
    if (audit[key] !== expected)
      fail(`dataset audit ${key}=${audit[key]}, expected ${expected}`);
  }
  for (const [category, expected] of Object.entries(
    EXPECTED_SOURCE_AUDIT.buffCategories
  )) {
    if (audit.buffCategories[category] !== expected) {
      fail(
        `dataset audit buff ${category}=${audit.buffCategories[category]}, expected ${expected}`
      );
    }
  }
  for (const [level, expected] of Object.entries(
    EXPECTED_SOURCE_AUDIT.assemblyLevels
  )) {
    if (audit.assemblyLevels[level] !== expected) {
      fail(
        `dataset audit assembly L${level}=${audit.assemblyLevels[level]}, expected ${expected}`
      );
    }
  }
  const classifiedSpend =
    audit.economy.paidSupport +
    audit.economy.unclassifiedRemainder +
    audit.economy.purchaseReviveCoins +
    audit.economy.confirmedRemoteRepairCoins +
    audit.economy.ambiguous;
  if (audit.economy.teamSpend !== classifiedSpend) {
    fail(
      `dataset economy audit does not balance ${audit.economy.teamSpend}!=${classifiedSpend}`
    );
  }
  return audit;
}

function filterSeries(items, selector, regionSelector = null) {
  if (regionSelector != null) {
    const selected = items.filter(item => {
      if ('regionKey' in item) return item.regionKey === regionSelector;
      return item.key.startsWith(`rmuc2026-${regionSelector}-`);
    });
    const expected = REGIONS.find(region => region.key === regionSelector);
    if (!expected || selected.length !== expected.expectedMatches) {
      fail(
        `--region ${regionSelector} selected ${selected.length} replays, expected ${expected?.expectedMatches}`
      );
    }
    return selected;
  }
  if (selector == null) return items;
  const match = /^(east|south|north):m?(\d{1,3})$/i.exec(selector);
  if (!match) fail(`--series must use region:MNNN, received ${selector}`);
  const key = `rmuc2026-${match[1].toLowerCase()}-m${paddedMatchNumber(Number(match[2]))}`;
  const selected = items.filter(item => item.key === key);
  if (selected.length !== 1) fail(`--series does not identify one replay: ${key}`);
  return selected;
}

async function verifyReplayAssetMetadata(descriptor, outputDir) {
  const relativePath = descriptor.assetPath.replace(
    'replays/rmuc2026-regionals/',
    ''
  );
  const path = resolve(outputDir, relativePath);
  if (!existsSync(path) || !statSync(path).isFile())
    fail(`replay asset does not exist: ${path}`);
  const bytes = statSync(path).size;
  const sha256 = await sha256File(path);
  if (bytes !== descriptor.compressedBytes || sha256 !== descriptor.sha256) {
    fail(`${descriptor.key} compressed asset metadata drifted`);
  }
  return { path, bytes, sha256 };
}

async function verifyOverviewAsset(
  descriptor,
  expectedRounds,
  outputDir,
  validatePayload
) {
  const expectedPrefix = 'replays/rmuc2026-regionals/';
  if (!descriptor.assetPath.startsWith(expectedPrefix)) {
    fail(`${descriptor.regionKey} overview asset path escapes the replay directory`);
  }
  const path = resolve(outputDir, descriptor.assetPath.slice(expectedPrefix.length));
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`overview asset does not exist: ${path}`);
  }
  const compressed = await fs.readFile(path);
  const digest = createHash('sha256').update(compressed).digest('hex');
  if (
    compressed.length !== descriptor.compressedBytes ||
    digest !== descriptor.sha256
  ) {
    fail(`${descriptor.regionKey} overview compressed asset metadata drifted`);
  }
  if (validatePayload) {
    let decoded;
    try {
      decoded = await gunzipAsync(compressed);
    } catch (error) {
      fail(`${path} is not valid gzip: ${error.message}`);
    }
    if (decoded.length !== descriptor.uncompressedBytes) {
      fail(`${descriptor.regionKey} overview uncompressed byte count drifted`);
    }
    const region = REGIONS.find(item => item.key === descriptor.regionKey);
    if (!region) fail(`unsupported overview region ${descriptor.regionKey}`);
    const metadata = validateOverviewTrackBuffer(
      decoded,
      region.key,
      EXPECTED_DATABASE_SHA256,
      expectedRounds
    );
    if (
      metadata.roundCount !== descriptor.roundCount ||
      metadata.timelineSampleCount !== descriptor.timelineSampleCount ||
      metadata.entitySampleCount !== descriptor.entitySampleCount
    ) {
      fail(`${descriptor.regionKey} overview catalog metadata drifted`);
    }
  }
  return { path, bytes: compressed.length, sha256: digest };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.validateOnly || options.verifyAssetsOnly) {
    const {
      descriptors,
      roundDescriptors: catalogRounds,
      overviewDescriptors,
    } = await readGeneratedCatalog(options.catalog);
    const selected = filterSeries(
      descriptors,
      options.series,
      options.region
    );
    for (const descriptor of selected) {
      if (options.verifyAssetsOnly) {
        const result = await verifyReplayAssetMetadata(
          descriptor,
          options.outputDir
        );
        console.log(
          `verified asset ${descriptor.key}: bytes=${result.bytes} -> ${result.path}`
        );
        continue;
      }
      const relativePath = descriptor.assetPath.replace(
        'replays/rmuc2026-regionals/',
        ''
      );
      const path = resolve(options.outputDir, relativePath);
      const result = await validateReplayFile(path, descriptor);
      if (
        result.frames !== descriptor.frameCount ||
        result.durationMs !== descriptor.durationMs ||
        result.bytes !== descriptor.compressedBytes ||
        result.sha256 !== descriptor.sha256
      ) {
        fail(`${descriptor.key} does not match generated catalog metadata`);
      }
      console.log(
        `validated ${descriptor.key}: frames=${result.frames} bytes=${result.bytes} -> ${path}`
      );
    }
    const selectedRegionKeys = new Set(selected.map(descriptor => descriptor.regionKey));
    for (const overview of overviewDescriptors.filter(descriptor =>
      selectedRegionKeys.has(descriptor.regionKey)
    )) {
      const expectedRounds = catalogRounds.filter(
        round => round.regionKey === overview.regionKey
      );
      const result = await verifyOverviewAsset(
        overview,
        expectedRounds,
        options.outputDir,
        options.validateOnly
      );
      console.log(
        `${options.validateOnly ? 'validated' : 'verified'} overview ${overview.regionKey}: bytes=${result.bytes} -> ${result.path}`
      );
    }
    return;
  }
  if (!existsSync(options.database) || !statSync(options.database).isFile()) {
    fail(`official SQLite database not found: ${options.database}`);
  }
  const databaseSha256 = await sha256File(options.database);
  if (databaseSha256 !== EXPECTED_DATABASE_SHA256) {
    fail(
      `official SQLite SHA-256 is ${databaseSha256}, expected ${EXPECTED_DATABASE_SHA256}`
    );
  }
  const database = new DatabaseSync(options.database, { readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON');
    requireTables(database);
    const configs = loadSeriesConfigs(database);
    if (options.catalogOnly) {
      for (const config of configs) {
        const path = resolve(options.outputDir, config.output);
        config.asset = await validateReplayFile(path, config);
      }
      const overviewCollectors = createOverviewCollectors();
      for (const config of configs) {
        addSeriesToOverviewCollectors(
          overviewCollectors,
          loadSeries(database, config)
        );
      }
      const overviewAssets = await writeOverviewAssets(
        configs,
        overviewCollectors,
        databaseSha256,
        options.outputDir
      );
      await writeCatalog(configs, databaseSha256, overviewAssets, options.catalog);
      console.log(`generated catalog -> ${options.catalog}`);
      return;
    }
    const selected = filterSeries(configs, options.series, options.region);
    const datasetAudit = createDatasetAudit();
    const overviewCollectors = createOverviewCollectors();
    for (const config of selected) {
      const prepared = prepareSeries(loadSeries(database, config));
      if (options.series == null && options.region == null) {
        addSeriesToOverviewCollectors(overviewCollectors, prepared);
      }
      addSeriesToDatasetAudit(datasetAudit, prepared);
      if (!options.auditOnly) {
        const path = resolve(options.outputDir, config.output);
        await writeReplay(prepared, databaseSha256, path);
        const result = await validateReplayFile(path, config);
        config.asset = result;
        console.log(
          `generated ${config.key}: rounds=${prepared.preparedRounds.length} frames=${result.frames} duration_ms=${result.durationMs} bytes=${result.bytes} -> ${path}`
        );
      }
    }
    if (options.series == null && options.region == null) {
      validateDatasetAudit(datasetAudit);
      if (!options.auditOnly) {
        const overviewAssets = await writeOverviewAssets(
          configs,
          overviewCollectors,
          databaseSha256,
          options.outputDir
        );
        await writeCatalog(
          configs,
          databaseSha256,
          overviewAssets,
          options.catalog
        );
      }
      console.log(
        `dataset audit passed: series=${configs.length} rounds=${EXPECTED_ROUND_COUNT} robot_samples=${datasetAudit.robotSamples} buffs=${Object.values(datasetAudit.buffCategories).reduce((sum, value) => sum + value, 0)} ambiguous_coins=${datasetAudit.economy.ambiguous}`
      );
      if (!options.auditOnly)
        console.log(`generated catalog -> ${options.catalog}`);
    }
  } finally {
    database.close();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) await main();
