#!/usr/bin/env node

/**
 * Build the three RMUC 2026 regional-final GitHub Pages fixtures from the
 * official public SQLite dataset.
 *
 * The public dataset is 1 Hz. Position and angle attributes are deterministically
 * interpolated to the Monitor's 10 Hz consumption cadence. Damage, buffs, coins,
 * levels and other rule states remain step/hold values.
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
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const REPLAY_SCHEMA = 'gsm-watch-replay/2';
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

const SERIES = [
  {
    key: 'east',
    region: '东部赛区',
    matchNumber: 88,
    redSchool: '山东科技大学',
    blueSchool: '中国石油大学（华东）',
    gameIds: [1779693823256, 1779694694514, 1779696117794, 1779697007200],
    output: 'east-final-m88.json',
    label: 'RMUC2026 东部决赛 M88',
    rulesEffective: 'V1.5.0',
  },
  {
    key: 'south',
    region: '南部赛区',
    matchNumber: 88,
    redSchool: '五邑大学',
    blueSchool: '华南农业大学',
    gameIds: [1779001883111, 1779002815710, 1779004144178],
    output: 'south-final-m88.json',
    label: 'RMUC2026 南部决赛 M88',
    rulesEffective: 'V1.4.2',
  },
  {
    key: 'north',
    region: '北部赛区',
    matchNumber: 90,
    redSchool: '东北大学',
    blueSchool: '哈尔滨工业大学',
    gameIds: [1780389108168, 1780389810101, 1780391063510, 1780391866389],
    output: 'north-final-m90.json',
    label: 'RMUC2026 北部决赛 M90',
    rulesEffective: 'V1.5.0',
  },
];

const ROBOT_IDS = [1, 2, 3, 4, 6, 7, 101, 102, 103, 104, 106, 107];
const BUILDING_IDS = [10, 11, 110, 111];
const KNOWN_ALL_MISSING = new Set([
  '1779696117794:102',
  '1779697007200:102',
  '1780391866389:106',
]);
const KNOWN_POINT_MISSING = new Set(['1780391866389:107:253']);

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

const EXPECTED_AUDIT = {
  buffCategories: {
    小能量机关增益: 207,
    大能量机关增益: 74,
    飞坡: 60,
    台阶跨越: 22,
    过中央高地: 16,
  },
  smallRuneCompletions: 30,
  bigRuneCompletions: 8,
  bigRuneCrossTeamRows: 35,
  bigRuneMissingRecipientGroups: 3,
  assemblyLevels: { 1: 15, 2: 17, 3: 15, 4: 0 },
  vulnerableRobotSamples: 16257,
  robotSamples: 53330,
  terrainOverlaps: 5,
  dartBuffCounterEvents: 6,
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
    validateOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db')
      options.database = resolve(argv[++index] ?? fail('--db requires a path'));
    else if (arg === '--output-dir')
      options.outputDir = resolve(
        argv[++index] ?? fail('--output-dir requires a path')
      );
    else if (arg === '--validate-only') options.validateOnly = true;
    else fail(`unknown argument ${arg}`);
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
    if (state.heat17Max !== 0 || state.heat42Max !== 0)
      fail(`engineer ${state.robotId} has heat limits`);
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
    if (state.heat17Max !== 260 || state.heat42Max !== 0)
      fail(`sentry ${state.robotId} heat limits drifted`);
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
  let previousSecond = 0;
  for (const group of groups) {
    if (group.second !== previousSecond + 1) {
      fail(
        `game ${match.gameId} has missing team second ${previousSecond}->${group.second}`
      );
    }
    previousSecond = group.second;
    const actualRobots = new Set(group.robots.map(state => state.robotId));
    for (const robotId of ROBOT_IDS) {
      const allMissing = KNOWN_ALL_MISSING.has(`${match.gameId}:${robotId}`);
      const pointMissing = KNOWN_POINT_MISSING.has(
        `${match.gameId}:${robotId}:${group.second}`
      );
      if (!allMissing && !pointMissing && !actualRobots.has(robotId)) {
        fail(
          `game ${match.gameId} second ${group.second} unexpectedly misses robot ${robotId}`
        );
      }
      if ((allMissing || pointMissing) && actualRobots.has(robotId)) {
        fail(
          `game ${match.gameId} second ${group.second} known gap robot ${robotId} is no longer missing`
        );
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
    purchaseRevive: { count: 0, coins: 0 },
    confirmedRemoteRepair: { count: 0, coins: 0 },
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
      const paidSupport = spend % 10;
      if (![0, 1, 2].includes(paidSupport)) {
        fail(
          `${pointContext} unsupported paid-support remainder ${paidSupport}`
        );
      }
      buckets.set(economyBucketKey(teamId, group.second), {
        teamId,
        second: group.second,
        spend,
        unassigned: spend - paidSupport,
      });
      audit.teamSpend += spend;
      audit.paidSupport += paidSupport;
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
      if (restoredRatio <= 0.2) continue;
      if (restoredRatio < 0.8) {
        fail(
          `${context} robot ${robotId} second ${current.second} ambiguous revive ratio ${restoredRatio}`
        );
      }
      const price =
        Math.ceil((current.second - 1) / 60) * 80 + officialLevel(current) * 20;
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
      fail(`${context} remote repairs ${required} exceed spend bucket ${key}`);
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
        if (hpAt(round, event.robotId, second) <= 0)
          fail(`${context} terrain buff targets defeated robot`);
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
    [A.Health]: left.hp,
    [A.ReviveCount]: left.reviveCount,
    [A.PurchaseReviveCount]: left.purchaseReviveCount,
    [A.FiringHeat1]: caliber === 42 ? left.heat42 : left.heat17,
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
    [A.HPProgress]: roundNumber(left.hp / left.hpMax, 6),
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
  const sampleSecond = Math.max(
    1,
    Math.min(
      preparedRound.round.sampleMaxSecond,
      Math.floor(1 + localMs / 1000)
    )
  );
  const group = preparedRound.round.groupBySecond.get(sampleSecond);
  if (!group)
    fail(
      `game ${preparedRound.round.match.gameId} misses second ${sampleSecond}`
    );
  const state = group.buildings.find(item => item.robotId === buildingId);
  if (!state)
    fail(
      `game ${preparedRound.round.match.gameId} misses building ${buildingId}`
    );
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
    [A.Health]: state.hp,
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
    [A.HPProgress]: roundNumber(state.hp / state.hpMax, 6),
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
    purchaseRevive: economy.audit.purchaseRevive,
    confirmedRemoteRepair: economy.audit.confirmedRemoteRepair,
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
    winner: prepared.round.match.winner,
    startedLocal: prepared.round.match.startedLocal,
    durationSeconds: prepared.round.match.durationSeconds,
    startMs: prepared.startMs,
    endMs: prepared.endMs,
    robotIds: [...prepared.round.byRobot.keys()].sort(
      (left, right) => left - right
    ),
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
      heldFields: ['health', 'healthMax', 'level', 'coins', 'buff state'],
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
  const stream = createWriteStream(temporary, {
    encoding: 'utf8',
    flags: 'wx',
  });
  try {
    await once(stream, 'open');
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
    await once(stream, 'finish');
    await fs.rename(temporary, outputPath);
  } catch (error) {
    stream.destroy();
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

function validateReplayObject(value, path) {
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
  if (value.inference?.ammo?.schema !== AMMO_INFERENCE_SCHEMA)
    fail(`${path} ammo inference schema is missing`);
  if (value.inference?.buffs?.schema !== BUFF_PROJECTION_SCHEMA)
    fail(`${path} buff inference schema is missing`);
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

async function validateReplayFile(path) {
  if (!existsSync(path) || !statSync(path).isFile())
    fail(`replay asset does not exist: ${path}`);
  const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
  validateReplayObject(parsed, path);
  return {
    bytes: statSync(path).size,
    frames: parsed.frameCount,
    durationMs: parsed.durationMs,
  };
}

function addNestedCounts(target, source) {
  for (const [key, value] of Object.entries(source))
    target[key] = (target[key] ?? 0) + value;
}

function validateDatasetAudit(preparedSeries) {
  const audit = {
    buffCategories: {},
    smallRuneCompletions: 0,
    bigRuneCompletions: 0,
    bigRuneCrossTeamRows: 0,
    bigRuneMissingRecipientGroups: 0,
    assemblyLevels: { 1: 0, 2: 0, 3: 0, 4: 0 },
    vulnerableRobotSamples: 0,
    robotSamples: 0,
    terrainOverlaps: 0,
    dartBuffCounterEvents: 0,
    economy: {
      teamSpend: 0,
      paidSupport: 0,
      purchaseReviveCount: 0,
      purchaseReviveCoins: 0,
      confirmedRemoteRepairCount: 0,
      confirmedRemoteRepairCoins: 0,
      ambiguous: 0,
    },
  };
  for (const series of preparedSeries) {
    for (const prepared of series.preparedRounds) {
      for (const group of prepared.round.groups) {
        audit.robotSamples += group.robots.length;
        audit.vulnerableRobotSamples += group.robots.filter(
          state => state.vulnerable === 1
        ).length;
      }
      for (const event of prepared.round.events) {
        if (
          event.type === '增益' &&
          event.category in EXPECTED_AUDIT.buffCategories
        ) {
          audit.buffCategories[event.category] =
            (audit.buffCategories[event.category] ?? 0) + 1;
        }
      }
      const buffs = prepared.buffs.audit;
      audit.smallRuneCompletions += buffs.smallRuneCompletions;
      audit.bigRuneCompletions += buffs.bigRuneCompletions;
      audit.bigRuneCrossTeamRows += buffs.bigRuneCrossTeamRows;
      audit.bigRuneMissingRecipientGroups +=
        buffs.bigRuneMissingRecipientGroups;
      addNestedCounts(audit.assemblyLevels, buffs.assemblyLevels);
      audit.terrainOverlaps += buffs.terrainOverlaps;
      audit.dartBuffCounterEvents += buffs.dartBuffCounterEvents;
      if (
        prepared.buffs.bigRunes.some(
          completion => completion.projection.tier !== 2
        )
      ) {
        fail(
          `game ${prepared.round.match.gameId} has a non-T2 big rune completion`
        );
      }
      const economy = prepared.economy.audit;
      audit.economy.teamSpend += economy.teamSpend;
      audit.economy.paidSupport += economy.paidSupport;
      audit.economy.purchaseReviveCount += economy.purchaseRevive.count;
      audit.economy.purchaseReviveCoins += economy.purchaseRevive.coins;
      audit.economy.confirmedRemoteRepairCount +=
        economy.confirmedRemoteRepair.count;
      audit.economy.confirmedRemoteRepairCoins +=
        economy.confirmedRemoteRepair.coins;
      audit.economy.ambiguous += economy.ambiguous;
    }
  }
  for (const [key, expected] of Object.entries(EXPECTED_AUDIT)) {
    if (key === 'buffCategories' || key === 'assemblyLevels') continue;
    if (audit[key] !== expected)
      fail(`dataset audit ${key}=${audit[key]}, expected ${expected}`);
  }
  for (const [category, expected] of Object.entries(
    EXPECTED_AUDIT.buffCategories
  )) {
    if (audit.buffCategories[category] !== expected) {
      fail(
        `dataset audit buff ${category}=${audit.buffCategories[category]}, expected ${expected}`
      );
    }
  }
  for (const [level, expected] of Object.entries(
    EXPECTED_AUDIT.assemblyLevels
  )) {
    if (audit.assemblyLevels[level] !== expected) {
      fail(
        `dataset audit assembly L${level}=${audit.assemblyLevels[level]}, expected ${expected}`
      );
    }
  }
  const expectedEconomy = {
    teamSpend: 43683,
    paidSupport: 4413,
    purchaseReviveCount: 40,
    purchaseReviveCoins: 20180,
    confirmedRemoteRepairCount: 5,
    confirmedRemoteRepairCoins: 750,
    ambiguous: 18340,
  };
  for (const [key, expected] of Object.entries(expectedEconomy)) {
    if (audit.economy[key] !== expected) {
      fail(
        `dataset economy audit ${key}=${audit.economy[key]}, expected ${expected}`
      );
    }
  }
  return audit;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.validateOnly) {
    for (const config of SERIES) {
      const path = resolve(options.outputDir, config.output);
      const result = await validateReplayFile(path);
      console.log(
        `validated ${config.key}: frames=${result.frames} bytes=${result.bytes} -> ${path}`
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
  let rawSeries;
  try {
    database.exec('PRAGMA query_only=ON');
    requireTables(database);
    rawSeries = SERIES.map(config => loadSeries(database, config));
  } finally {
    database.close();
  }
  const preparedSeries = rawSeries.map(series => prepareSeries(series));
  const datasetAudit = validateDatasetAudit(preparedSeries);
  console.log(
    `dataset audit passed: robot_samples=${datasetAudit.robotSamples} buffs=${Object.values(datasetAudit.buffCategories).reduce((sum, value) => sum + value, 0)} ambiguous_coins=${datasetAudit.economy.ambiguous}`
  );
  for (const series of preparedSeries) {
    const path = resolve(options.outputDir, series.config.output);
    await writeReplay(series, databaseSha256, path);
    const result = await validateReplayFile(path);
    console.log(
      `generated ${series.config.key}: rounds=${series.preparedRounds.length} frames=${result.frames} duration_ms=${result.durationMs} bytes=${result.bytes} -> ${path}`
    );
  }
}

await main();
