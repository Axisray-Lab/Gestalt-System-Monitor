/**
 * Realistic RMUC2026 AI match mock data for the Gestalt-System-Monitor.
 *
 * Produces realistic WorldSnapshot streams for 4 parallel Map-9 matches.
 * Each match: team0=ranged (red), team1=ground_push (blue), ~420s duration.
 *
 * Based on actual observed match data (2026-06-17 headless nullrhi run).
 */

import type { WorldSnapshot, VehicleState, Vec3, MapWireframe } from '@gsm/protocol';

// ── Map 9 arena (approximate RMUC2026 competition arena, UE cm) ──

const ARENA_BOUNDS = {
  min: { x: -1100, y: -800, z: 0 },
  max: { x: 1100, y: 800, z: 300 },
};

/** Arena wireframe (simplified Map 9 outer + inner lanes + tunnels). */
export function makeMap9Wireframe(): MapWireframe {
  // Outer rectangle (the arena wall perimeter)
  const outer: Vec3[] = [
    { x: -1000, y: -700, z: 0 }, { x: 1000, y: -700, z: 0 },
    { x: 1000, y: 700, z: 0 }, { x: -1000, y: 700, z: 0 },
    { x: -1000, y: -700, z: 0 },
  ];
  // Inner lane (highway ring)
  const inner: Vec3[] = [
    { x: -600, y: -500, z: 0 }, { x: 600, y: -500, z: 0 },
    { x: 600, y: 500, z: 0 }, { x: -600, y: 500, z: 0 },
    { x: -600, y: -500, z: 0 },
  ];
  // Red base area
  const redBase: Vec3[] = [
    { x: -900, y: -100, z: 0 }, { x: -700, y: -100, z: 0 },
    { x: -700, y: 100, z: 0 }, { x: -900, y: 100, z: 0 },
    { x: -900, y: -100, z: 0 },
  ];
  // Blue base area
  const blueBase: Vec3[] = [
    { x: 700, y: -100, z: 0 }, { x: 900, y: -100, z: 0 },
    { x: 900, y: 100, z: 0 }, { x: 700, y: 100, z: 0 },
    { x: 700, y: -100, z: 0 },
  ];
  // Red outpost area
  const redOutpost: Vec3[] = [
    { x: 393, y: 283, z: 0 }, { x: 443, y: 333, z: 0 },
    { x: 393, y: 383, z: 0 }, { x: 343, y: 333, z: 0 },
    { x: 393, y: 283, z: 0 },
  ];
  // Blue outpost area
  const blueOutpost: Vec3[] = [
    { x: -381, y: -333, z: 0 }, { x: -331, y: -283, z: 0 },
    { x: -381, y: -233, z: 0 }, { x: -431, y: -283, z: 0 },
    { x: -381, y: -333, z: 0 },
  ];
  // Tunnel corridor (simplified)
  const tunnel: Vec3[] = [
    { x: -590, y: 88, z: 0 }, { x: -490, y: -436, z: 0 },
    { x: 504, y: 480, z: 0 }, { x: 584, y: 495, z: 0 },
  ];

  return {
    mapId: 'RMUC2026_Map9',
    lines: [outer, inner, redBase, blueBase, redOutpost, blueOutpost, tunnel],
    bounds: ARENA_BOUNDS,
  };
}

// ── Vehicle configuration ──

interface MockVehicleDef {
  id: number; name: string; classId: number; team: string; teamNumber: number;
  kind: 'robot' | 'base' | 'outpost' | 'building';
  hpMax: number; startPos: Vec3; role: string;
}

/** Standard 7v7 AI lineup: team0 ranged, team1 ground_push. */
export const MOCK_LINEUP: MockVehicleDef[] = [
  // ── Team 0 (red, ranged lineup) ──
  { id: 80000, name: 'Red Hero (Range)',    classId: 1001, team: 'red',  teamNumber: 1, kind: 'robot',  hpMax: 800,  startPos: { x: -800, y: -350, z: 60 }, role: 'hero_range' },
  { id: 80001, name: 'Red Infantry #3',     classId: 1003, team: 'red',  teamNumber: 3, kind: 'robot',  hpMax: 400,  startPos: { x: -600, y: -300, z: 60 }, role: 'infantry' },
  { id: 80002, name: 'Red Infantry #4',     classId: 1003, team: 'red',  teamNumber: 4, kind: 'robot',  hpMax: 400,  startPos: { x: -400, y: -300, z: 60 }, role: 'infantry' },
  { id: 80003, name: 'Red Aerial',          classId: 1005, team: 'red',  teamNumber: 6, kind: 'robot',  hpMax: 200,  startPos: { x: -700, y: -100, z: 200 }, role: 'aerial' },
  { id: 80004, name: 'Red Sentry #7',       classId: 1004, team: 'red',  teamNumber: 7, kind: 'robot',  hpMax: 600,  startPos: { x: -500, y: -500, z: 60 }, role: 'sentry' },
  { id: 80010, name: 'Red Radar #8',        classId: 1006, team: 'red',  teamNumber: 8, kind: 'robot',  hpMax: 180,  startPos: { x: -400, y: 400, z: 60 }, role: 'radar' },
  { id: 80011, name: 'Red Radar #9',        classId: 1006, team: 'red',  teamNumber: 9, kind: 'robot',  hpMax: 180,  startPos: { x: -800, y: 200, z: 60 }, role: 'radar' },
  // ── Team 1 (blue, ground_push lineup) ──
  { id: 80005, name: 'Blue Hero (Melee)',   classId: 1001, team: 'blue', teamNumber: 1, kind: 'robot',  hpMax: 800,  startPos: { x: 700, y: 300, z: 60 }, role: 'hero_melee' },
  { id: 80006, name: 'Blue Infantry (TwoLeg)', classId: 1003, team: 'blue', teamNumber: 3, kind: 'robot', hpMax: 400, startPos: { x: 600, y: 300, z: 60 }, role: 'infantry_twoleg' },
  { id: 80007, name: 'Blue Infantry #4',    classId: 1003, team: 'blue', teamNumber: 4, kind: 'robot',  hpMax: 400,  startPos: { x: 400, y: 300, z: 60 }, role: 'infantry' },
  { id: 80008, name: 'Blue Aerial',         classId: 1005, team: 'blue', teamNumber: 6, kind: 'robot',  hpMax: 200,  startPos: { x: 700, y: 100, z: 200 }, role: 'aerial' },
  { id: 80009, name: 'Blue Sentry #7',      classId: 1004, team: 'blue', teamNumber: 7, kind: 'robot',  hpMax: 600,  startPos: { x: 500, y: 500, z: 60 }, role: 'sentry' },
  { id: 80012, name: 'Blue Radar #8',       classId: 1006, team: 'blue', teamNumber: 8, kind: 'robot',  hpMax: 180,  startPos: { x: 400, y: -400, z: 60 }, role: 'radar' },
  { id: 80013, name: 'Blue Radar #9',       classId: 1006, team: 'blue', teamNumber: 9, kind: 'robot',  hpMax: 180,  startPos: { x: 800, y: -200, z: 60 }, role: 'radar' },
  // ── Buildings ──
  { id: 90000, name: 'Red Base',            classId: 0, team: 'red',  teamNumber: 0, kind: 'base',    hpMax: 5000, startPos: { x: -800, y: 0, z: 0 }, role: 'base' },
  { id: 90001, name: 'Blue Base',           classId: 0, team: 'blue', teamNumber: 0, kind: 'base',    hpMax: 5000, startPos: { x: 800, y: 0, z: 0 }, role: 'base' },
  { id: 90002, name: 'Red Outpost',         classId: 0, team: 'red',  teamNumber: 0, kind: 'outpost', hpMax: 500,  startPos: { x: 393, y: 333, z: 0 }, role: 'outpost' },
  { id: 90003, name: 'Blue Outpost',        classId: 0, team: 'blue', teamNumber: 0, kind: 'outpost', hpMax: 500,  startPos: { x: -381, y: -283, z: 0 }, role: 'outpost' },
  { id: 90004, name: 'Fortress Red',        classId: 0, team: 'red',  teamNumber: 0, kind: 'building', hpMax: 1,   startPos: { x: 0, y: 500, z: 0 }, role: 'fortress' },
  { id: 90005, name: 'Fortress Blue',       classId: 0, team: 'blue', teamNumber: 0, kind: 'building', hpMax: 1,   startPos: { x: 0, y: -500, z: 0 }, role: 'fortress' },
];

// ── Movement path generators ──

interface PathNode { pos: Vec3; dwellMs: number; label: string; }

/** Red hero range: goes to lob point -> stays there firing at enemy outpost/base. */
function redHeroRangePath(): PathNode[] {
  return [
    { pos: { x: -800, y: -350, z: 60 }, dwellMs: 3000, label: 'spawn' },
    { pos: { x: -500, y: -200, z: 60 }, dwellMs: 2000, label: 'approach_lob' },
    { pos: { x: 300, y: 300, z: 60 }, dwellMs: 300000, label: 'lob_station' }, // stay at lob point
  ];
}

/** Red infantry: protects hero -> push through tunnel -> engage. */
function redInfantryPath(index: number): PathNode[] {
  const base = index === 0
    ? [
      { pos: { x: -600, y: -300, z: 60 }, dwellMs: 5000, label: 'spawn' },
      { pos: { x: -490, y: -300, z: 60 }, dwellMs: 3000, label: 'approach_tunnel1' },
      { pos: { x: -564, y: -445, z: 60 }, dwellMs: 8000, label: 'tunnel1_entry' },
      { pos: { x: 0, y: -200, z: 60 }, dwellMs: 10000, label: 'post_tunnel_mid' },
    ]
    : [
      { pos: { x: -400, y: -300, z: 60 }, dwellMs: 5000, label: 'spawn' },
      { pos: { x: -200, y: -400, z: 60 }, dwellMs: 3000, label: 'push_lane' },
      { pos: { x: 100, y: -300, z: 60 }, dwellMs: 8000, label: 'midfield' },
    ];
  return [
    ...base,
    { pos: { x: 393, y: 250, z: 60 }, dwellMs: 200000, label: 'enemy_outpost_area' },
    { pos: { x: 600, y: 0, z: 60 }, dwellMs: 100000, label: 'enemy_base_push' },
  ];
}

/** Red aerial: flies high, darts enemy outpost -> base. */
function redAerialPath(): PathNode[] {
  return [
    { pos: { x: -700, y: -100, z: 200 }, dwellMs: 3000, label: 'spawn' },
    { pos: { x: -100, y: -100, z: 250 }, dwellMs: 5000, label: 'fly_mid' },
    { pos: { x: 393, y: 333, z: 250 }, dwellMs: 150000, label: 'dart_outpost' },
    { pos: { x: 700, y: 100, z: 250 }, dwellMs: 150000, label: 'dart_base' },
  ];
}

/** Red sentry: defends outpost area -> push forward slowly. */
function redSentryPath(): PathNode[] {
  return [
    { pos: { x: -500, y: -500, z: 60 }, dwellMs: 5000, label: 'spawn' },
    { pos: { x: -200, y: -300, z: 60 }, dwellMs: 10000, label: 'defend_lane' },
    { pos: { x: 200, y: 0, z: 60 }, dwellMs: 80000, label: 'push_mid' },
    { pos: { x: 500, y: 200, z: 60 }, dwellMs: 150000, label: 'support_base_push' },
  ];
}

/** Red radar: stationary AA positions. */
function redRadarPath(index: number): PathNode[] {
  const pos = index === 0
    ? { x: -400, y: 400, z: 60 }
    : { x: -800, y: 200, z: 60 };
  return [{ pos, dwellMs: 420000, label: 'stationary' }];
}

/** Blue hero melee: push through line -> stuck at no-path spots -> resupply cycles. */
function blueHeroMeleePath(): PathNode[] {
  return [
    { pos: { x: 700, y: 300, z: 60 }, dwellMs: 5000, label: 'spawn' },
    { pos: { x: 620, y: -28, z: 60 }, dwellMs: 8000, label: 'no_path_hotspot' }, // known no-path coord
    { pos: { x: 400, y: -200, z: 60 }, dwellMs: 15000, label: 'retry_nav' },
    { pos: { x: 600, y: 300, z: 60 }, dwellMs: 5000, label: 'resupply_loop' },
    { pos: { x: 620, y: -28, z: 60 }, dwellMs: 30000, label: 'no_path_again' },
    { pos: { x: 300, y: 0, z: 60 }, dwellMs: 60000, label: 'finally_pushing' },
  ];
}

/** Blue infantry TwoLeg: terrain explorer -> steps -> road. */
function blueTwoLegPath(): PathNode[] {
  return [
    { pos: { x: 600, y: 300, z: 60 }, dwellMs: 5000, label: 'spawn' },
    { pos: { x: -494, y: -556, z: 60 }, dwellMs: 12000, label: 'step_road_low' },
    { pos: { x: -556, y: -556, z: 60 }, dwellMs: 8000, label: 'step_road_high' },
    { pos: { x: -590, y: 146, z: 60 }, dwellMs: 10000, label: 'tunnel4_approach' },
    { pos: { x: -200, y: 200, z: 60 }, dwellMs: 200000, label: 'terrain_patrol' },
  ];
}

/** Blue infantry #4: heavy no-path -> push attempts. */
function blueInfantryPath(): PathNode[] {
  return [
    { pos: { x: 400, y: 300, z: 60 }, dwellMs: 5000, label: 'spawn' },
    { pos: { x: 521, y: 1367, z: 60 }, dwellMs: 15000, label: 'no_path_worst' },
    { pos: { x: 300, y: 500, z: 60 }, dwellMs: 10000, label: 'retry' },
    { pos: { x: 0, y: 200, z: 60 }, dwellMs: 80000, label: 'mid_push' },
    { pos: { x: -300, y: -100, z: 60 }, dwellMs: 100000, label: 'enemy_zone_push' },
  ];
}

/** Blue aerial: flies, does damage but can't carry the push. */
function blueAerialPath(): PathNode[] {
  return [
    { pos: { x: 700, y: 100, z: 200 }, dwellMs: 3000, label: 'spawn' },
    { pos: { x: 100, y: 100, z: 250 }, dwellMs: 5000, label: 'fly_mid' },
    { pos: { x: -393, y: -333, z: 250 }, dwellMs: 100000, label: 'dart_red_outpost' },
    { pos: { x: -700, y: -100, z: 250 }, dwellMs: 150000, label: 'dart_red_base' },
  ];
}

/** Blue sentry: some output, but supply issues drag efficiency. */
function blueSentryPath(): PathNode[] {
  return [
    { pos: { x: 500, y: 500, z: 60 }, dwellMs: 5000, label: 'spawn' },
    { pos: { x: 200, y: 300, z: 60 }, dwellMs: 10000, label: 'push_front' },
    { pos: { x: -100, y: 100, z: 60 }, dwellMs: 50000, label: 'midfight' },
    { pos: { x: 500, y: 500, z: 60 }, dwellMs: 15000, label: 'resupply_back' },
    { pos: { x: -200, y: -100, z: 60 }, dwellMs: 150000, label: 'push_again' },
  ];
}

/** Blue radar: stationary AA. */
function blueRadarPath(index: number): PathNode[] {
  const pos = index === 0
    ? { x: 400, y: -400, z: 60 }
    : { x: 800, y: -200, z: 60 };
  return [{ pos, dwellMs: 420000, label: 'stationary' }];
}

function forBuildings(): Vec3[] {
  // Buildings stay at their start positions
  return [{ x: 0, y: 0, z: 0 }];
}

export function getPathForRole(role: string, index: number = 0): PathNode[] {
  switch (role) {
    case 'hero_range': return redHeroRangePath();
    case 'hero_melee': return blueHeroMeleePath();
    case 'infantry': return redInfantryPath(index);
    case 'infantry_twoleg': return blueTwoLegPath();
    case 'infantry_melee': return blueInfantryPath();
    case 'aerial': return index < 7 ? redAerialPath() : blueAerialPath();
    case 'sentry': return index < 7 ? redSentryPath() : blueSentryPath();
    case 'radar': {
      const paths = [redRadarPath(0), redRadarPath(1), blueRadarPath(0), blueRadarPath(1)];
      const idx = Math.min(index, paths.length - 1);
      return paths[idx];
    }
    case 'base':
    case 'outpost':
    case 'fortress':
      return [{ pos: { x: 0, y: 0, z: 0 }, dwellMs: 420000, label: 'static' }];
    default: return [{ pos: { x: 0, y: 0, z: 60 }, dwellMs: 5000, label: 'unknown' }];
  }
}

// ── Snapshot generator ──

interface MockVehicleRuntime {
  def: MockVehicleDef;
  path: PathNode[];
  pathIdx: number;
  pathEnteredMs: number;
  health: number;
  hp: number;
  bulletsFired: number;
  damageDealt: number;
  ammo17: number;
  ammo42: number;
  heat: number;
  aimoveMode: number;
  defeated: boolean;
  deployed: boolean;
}

export class MockMatchSimulator {
  private vehicles: MockVehicleRuntime[];
  private elapsedMs: number = 0;
  readonly matchId: string;
  readonly map: MapWireframe;
  private baseHp = { red: 5000, blue: 5000 };
  private outpostHp = { red: 500, blue: 500 };
  public winner: string | null = null;

  constructor(matchId: string, lineup: MockVehicleDef[] = MOCK_LINEUP) {
    this.matchId = matchId;
    this.map = makeMap9Wireframe();
    this.vehicles = lineup.map((def) => {
      const path = getPathForRole(def.role, def.teamNumber || 0);
      return {
        def,
        path,
        pathIdx: 0,
        pathEnteredMs: 0,
        health: 1.0,
        hp: def.hpMax,
        bulletsFired: 0,
        damageDealt: 0,
        ammo17: def.classId === 1001 ? 0 : 200 + Math.floor(Math.random() * 300),
        ammo42: def.classId === 1001 ? 85 : 0,
        heat: 0,
        aimoveMode: 1, // engage
        defeated: false,
        deployed: false,
      };
    });
  }

  tick(dtMs: number): void {
    this.elapsedMs += dtMs;

    // ── Building state progression ──
    // Red outpost: killed by blue aerial around 120s
    if (this.elapsedMs > 120_000 && this.outpostHp.red > 0) {
      this.outpostHp.red = Math.max(0, this.outpostHp.red - dtMs * 4);
    }
    // Blue outpost: killed by red aerial + ranged hero around 60-80s
    if (this.elapsedMs > 60_000 && this.outpostHp.blue > 0) {
      this.outpostHp.blue = Math.max(0, this.outpostHp.blue - dtMs * 8);
    }
    // Blue base: slowly eroded by red ranged team
    if (this.outpostHp.blue <= 0 && this.elapsedMs > 180_000) {
      this.baseHp.blue = Math.max(0, this.baseHp.blue - dtMs * 12);
    }
    // Red base: minimal damage from ground push
    if (this.outpostHp.red <= 0 && this.elapsedMs > 250_000) {
      this.baseHp.red = Math.max(0, this.baseHp.red - dtMs * 3);
    }

    // Determine winner
    if (this.baseHp.blue <= 0) this.winner = 'red';
    else if (this.baseHp.red <= 0) this.winner = 'blue';

    // ── Vehicle state updates ──
    for (const v of this.vehicles) {
      if (v.defeated || v.def.kind !== 'robot') continue;

      const node = v.path[v.pathIdx];
      if (!node) continue;

      const timeOnNode = this.elapsedMs - v.pathEnteredMs;
      if (timeOnNode > node.dwellMs && v.pathIdx < v.path.length - 1) {
        v.pathIdx++;
        v.pathEnteredMs = this.elapsedMs;
      }

      // Update combat state based on role
      this.updateCombat(v, dtMs);
    }
  }

  private updateCombat(v: MockVehicleRuntime, dtMs: number): void {
    const sec = dtMs / 1000;
    const def = v.def;

    // Health: drones die more, melee hero takes chip damage
    if (def.role === 'aerial') {
      v.health -= sec * 0.001; // slow attrition
      if (Math.random() < sec * 0.003) v.health = Math.max(0.05, v.health - 0.3); // spike damage
    }
    if (def.role === 'hero_melee') {
      v.health -= sec * 0.0003;
    }
    if (def.role === 'hero_range') {
      if (this.elapsedMs > 60_000) v.health -= sec * 0.0002;
    }
    if (def.role.includes('infantry')) {
      v.health -= sec * 0.0004;
    }
    if (def.role === 'sentry') {
      v.health -= sec * 0.0006;
    }
    v.health = Math.max(0, Math.min(1, v.health));
    v.hp = Math.floor(v.health * def.hpMax);

    // Fire bullets
    if (def.role === 'aerial') {
      v.bulletsFired += Math.floor(sec * 2);
      v.damageDealt += sec * 8;
    } else if (def.role === 'hero_range') {
      if (this.elapsedMs > 60_000) {
        v.bulletsFired += Math.floor(sec * 0.2);
        v.damageDealt += sec * 3;
      }
    } else if (def.role.includes('infantry') || def.role === 'sentry') {
      v.bulletsFired += Math.floor(sec * 1.2);
      v.damageDealt += sec * 1.5;
    } else if (def.role === 'hero_melee') {
      v.bulletsFired += Math.floor(sec * 0.02);
      v.damageDealt += sec * 0.1;
    }

    // Ammo depletion
    if (def.role.includes('infantry') || def.role === 'sentry') {
      v.ammo17 = Math.max(0, v.ammo17 - sec * 1.5);
    }
    if (def.role === 'hero_range') {
      v.ammo42 = Math.max(0, v.ammo42 - sec * 0.05);
    }

    // Heat
    v.heat = Math.min(1, v.heat + sec * 0.1);
    if (v.bulletsFired % 10 === 0) v.heat *= 0.7; // cooling bursts

    // AIMoveMode
    const node = v.path[v.pathIdx];
    if (node) {
      if (node.label.includes('tunnel')) v.aimoveMode = 31; // tunnel mode
      else if (node.label.includes('step')) v.aimoveMode = 16; // step mode
      else if (node.label.includes('spawn') || node.label.includes('approach')) v.aimoveMode = 1; // engage
      else if (node.label.includes('lob') || node.label.includes('station')) v.aimoveMode = 5; // lob
      else if (node.label.includes('resupply')) v.aimoveMode = 3; // home
      else if (node.label.includes('push') || node.label.includes('dart')) v.aimoveMode = 9; // fortress/push
      else v.aimoveMode = 1; // default engage
    }
  }

  snapshot(frame: number): WorldSnapshot {
    const states: VehicleState[] = [];

    for (const v of this.vehicles) {
      const def = v.def;
      const node = v.path[Math.min(v.pathIdx, v.path.length - 1)];
      const pos = node ? { ...node.pos } : { ...def.startPos };

      // Add slight jitter for realism
      pos.x += (Math.random() - 0.5) * 30;
      pos.y += (Math.random() - 0.5) * 30;

      // Compute yaw from position delta if moving
      const nextNode = v.path[Math.min(v.pathIdx + 1, v.path.length - 1)];
      let yaw = 0;
      if (nextNode && nextNode !== node) {
        const dx = nextNode.pos.x - node.pos.x;
        const dy = nextNode.pos.y - node.pos.y;
        yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
      }

      const isBuilding = def.kind === 'base' || def.kind === 'outpost' || def.kind === 'building';
      const buildingHp = def.team === 'red'
        ? (def.kind === 'base' ? this.baseHp.red : def.kind === 'outpost' ? this.outpostHp.red : 1)
        : (def.kind === 'base' ? this.baseHp.blue : def.kind === 'outpost' ? this.outpostHp.blue : 1);

      const state: VehicleState = {
        id: def.id,
        kind: def.kind,
        classId: def.classId,
        name: def.name,
        team: def.team,
        teamNumber: def.teamNumber,
        pos,
        yaw,
        turretYaw: yaw + (Math.random() - 0.5) * 20,
        turretPitch: isBuilding ? 0 : -2 + Math.random() * 4,
        speed: isBuilding ? 0 : 200 + Math.random() * 400,
        health: isBuilding ? buildingHp / def.hpMax : v.health,
        hp: isBuilding ? buildingHp : v.hp,
        hpMax: def.hpMax,
        defeated: isBuilding ? buildingHp <= 0 : v.defeated,
        deployed: v.def.role === 'hero_range' && this.elapsedMs > 70_000 && this.outpostHp.blue <= 0,
        ammo: isBuilding ? undefined : v.ammo17 + v.ammo42,
        ammo17: isBuilding ? undefined : v.ammo17,
        ammo42: isBuilding ? undefined : v.ammo42,
        heat: isBuilding ? undefined : v.heat,
        firingLocked: isBuilding ? undefined : v.ammo17 <= 0 && v.ammo42 <= 0,
        buffs: isBuilding ? undefined : this.computeBuffs(v),
        level: isBuilding ? undefined : Math.min(4, 1 + Math.floor(this.elapsedMs / 120_000)),
        score: isBuilding ? undefined : Math.floor(v.damageDealt),
        repairProgress: def.kind === 'outpost' && buildingHp <= 0 ? 0.3 : undefined,
        repairCount: def.kind === 'outpost' ? 1 : undefined,
        dartTargetId: v.def.role === 'aerial'
          ? (this.outpostHp.blue > 0 ? 90003 : 90001)
          : undefined,
      };

      states.push(state);
    }

    return { t: frame, vehicles: states };
  }

  private computeBuffs(v: MockVehicleRuntime): string[] {
    const buffs: string[] = [];
    if (v.defeated) buffs.push('defeated');
    if (v.deployed) buffs.push('deployed');
    if (v.heat > 0.8) buffs.push('overheated');
    if (v.ammo17 <= 0 && v.ammo42 <= 0) buffs.push('firing_locked');
    if (v.health < 0.3) buffs.push('weakened');
    if (v.def.role === 'sentry') {
      buffs.push('sentry_attack');
      if (v.health < 0.2) buffs.push('sentry_defense_enhanced');
    }
    return buffs;
  }
}

/** Create multiple parallel match simulators with slightly staggered timing. */
export function createMatchSimulators(count: number): MockMatchSimulator[] {
  return Array.from({ length: count }, (_, i) =>
    new MockMatchSimulator(`gsm-mock-${i}`)
  );
}
