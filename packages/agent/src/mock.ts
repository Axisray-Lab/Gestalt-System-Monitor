/**
 * Mock LAN — lets you exercise the full discovery + feed pipeline on one box
 * with no game build. It (1) broadcasts beacons (magic "ECHO") to 127.0.0.1:7999 so
 * the agent's own listener discovers them, and (2) runs one WebSocket feed server
 * per fake match, emitting the target `monitor.mapGeometry` + `monitor.worldSnapshot`
 * JSON-RPC notifications the real game is expected to add (see docs/ARCHITECTURE.md).
 *
 * With `--scenario` flag, uses realistic RMUC2026 Map-9 AI match simulation instead
 * of simple oval-loop vehicles.
 */
import dgram from 'node:dgram';
import { WebSocketServer, WebSocket } from 'ws';
import {
  DISCOVERY_PORT,
  DISCOVERY_MAGIC,
  BROADCAST_INTERVAL_MS,
  EJSONRPCType,
  METHOD_MAP_GEOMETRY,
  METHOD_WORLD_SNAPSHOT,
  type BeaconPayload,
  type MapWireframe,
  type WorldSnapshot,
  type VehicleState,
  type Vec3,
} from '@gsm/protocol';
import { MockMatchSimulator, createMatchSimulators, makeMap9Wireframe, MOCK_LINEUP } from './mock-match-data.js';

const TEAMS = ['red', 'blue'];

interface MockVehicle {
  id: number;
  name: string;
  team: string;
  phase: number; // 0..1 along the loop
  speed: number; // loop fraction / second
  health: number;
}
interface MockMatch {
  payload: BeaconPayload;
  map: MapWireframe;
  rx: number;
  ry: number;
  vehicles: MockVehicle[];
}

function oval(rx: number, ry: number, seg = 96): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry, z: 0 });
  }
  return pts;
}

function makeMatch(index: number): MockMatch {
  const rx = 4200 + index * 900;
  const ry = 2800 + index * 500;
  const count = 4 + index;
  const vehicles: MockVehicle[] = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Car ${i + 1}`,
    team: TEAMS[i % 2],
    phase: i / count,
    speed: 0.05 + Math.random() * 0.05,
    health: 1,
  }));
  return {
    rx,
    ry,
    vehicles,
    map: {
      mapId: `mock_track_${index}`,
      lines: [oval(rx, ry), oval(rx * 0.6, ry * 0.6)],
      bounds: { min: { x: -rx, y: -ry, z: 0 }, max: { x: rx, y: ry, z: 0 } },
    },
    payload: {
      matchId: `mock-${index}`,
      name: `Mock Match ${index + 1}`,
      mapId: `mock_track_${index}`,
      wsPort: 9201 + index,
      playerCount: count,
      maxPlayers: 8,
      version: '0.0.1-mock',
    },
  };
}

function snapshot(m: MockMatch, t: number): WorldSnapshot {
  const vehicles: VehicleState[] = m.vehicles.map((v) => {
    const a = v.phase * Math.PI * 2;
    const pos: Vec3 = { x: Math.cos(a) * m.rx, y: Math.sin(a) * m.ry, z: 60 };
    const yaw = (Math.atan2(Math.cos(a) * m.ry, -Math.sin(a) * m.rx) * 180) / Math.PI;
    return {
      id: v.id,
      name: v.name,
      team: v.team,
      pos,
      yaw,
      speed: Math.round(v.speed * 5000),
      health: v.health,
      score: Math.floor(t * v.speed),
    };
  });
  return { t, vehicles };
}

export function startMock(): void {
  const matches = [makeMatch(0), makeMatch(1)];

  const feeds = matches.map((match) => {
    const wss = new WebSocketServer({ port: match.payload.wsPort });
    wss.on('connection', (ws) => {
      ws.send(
        JSON.stringify({ type: EJSONRPCType.Request, method: METHOD_MAP_GEOMETRY, params: match.map })
      );
    });
    wss.on('listening', () =>
      console.log(`[mock] feed "${match.payload.name}" on ws/${match.payload.wsPort}`)
    );
    return { match, wss };
  });

  const beacon = dgram.createSocket({ type: 'udp4' });
  setInterval(() => {
    for (const m of matches) {
      const json = Buffer.from(JSON.stringify(m.payload), 'utf8');
      const buf = Buffer.alloc(4 + json.length);
      buf.writeUInt32LE(DISCOVERY_MAGIC, 0);
      json.copy(buf, 4);
      beacon.send(buf, DISCOVERY_PORT, '127.0.0.1');
    }
  }, BROADCAST_INTERVAL_MS);

  let frame = 0;
  const dt = 1 / 20;
  setInterval(() => {
    frame++;
    for (const { match, wss } of feeds) {
      for (const v of match.vehicles) v.phase = (v.phase + v.speed * dt) % 1;
      const msg = JSON.stringify({
        type: EJSONRPCType.Request,
        method: METHOD_WORLD_SNAPSHOT,
        params: snapshot(match, frame),
      });
      for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }, 1000 * dt);
}

/** Realistic RMUC2026 Map-9 AI match mock (4 parallel matches, ~420s each). */
export function startScenarioMock(): void {
  const matchCount = 4;
  const sims = createMatchSimulators(matchCount);
  const dtMs = 50; // 20Hz update
  const matchDurationMs = 430_000; // 430s (420s match + margin)
  const dtFraction = dtMs / 1000;

  const feeds = sims.map((sim, i) => {
    const port = 9201 + i;
    const wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({
        type: EJSONRPCType.Request,
        method: METHOD_MAP_GEOMETRY,
        params: sim.map,
      }));
    });
    wss.on('listening', () =>
      console.log(`[mock:scenario] "${sim.matchId}" on ws/${port}`)
    );
    return { sim, wss, port, beaconPayload: {
      matchId: sim.matchId,
      name: `Map9 AI ${i + 1}`,
      mapId: 'RMUC2026_Map9',
      wsPort: port,
      playerCount: 22,
      maxPlayers: 22,
      version: '0.1.9-AI-mock',
    }};
  });

  // UDP beacon
  const beacon = dgram.createSocket({ type: 'udp4' });
  const beaconInterval = setInterval(() => {
    for (const f of feeds) {
      const json = Buffer.from(JSON.stringify(f.beaconPayload), 'utf8');
      const buf = Buffer.alloc(4 + json.length);
      buf.writeUInt32LE(DISCOVERY_MAGIC, 0);
      json.copy(buf, 4);
      beacon.send(buf, DISCOVERY_PORT, '127.0.0.1');
    }
  }, BROADCAST_INTERVAL_MS);

  // Simulation loop
  let frame = 0;
  let elapsed = 0;
  const simLoop = setInterval(() => {
    elapsed += dtMs;
    frame++;
    if (elapsed > matchDurationMs) {
      console.log(`[mock:scenario] match duration reached (${matchDurationMs}ms); stopping.`);
      clearInterval(simLoop);
      clearInterval(beaconInterval);
      beacon.close();
      for (const f of feeds) f.wss.close();
      return;
    }
    for (const { sim, wss } of feeds) {
      sim.tick(dtMs);
      const snap = sim.snapshot(frame);
      const msg = JSON.stringify({
        type: EJSONRPCType.Request,
        method: METHOD_WORLD_SNAPSHOT,
        params: snap,
      });
      for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    }
  }, dtMs);

  console.log(`[mock:scenario] running ${matchCount} matches, ~${matchDurationMs / 1000}s duration`);
}
