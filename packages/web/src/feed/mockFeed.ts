import type { MapWireframe, Vec3, VehicleState, WorldSnapshot } from '@gsm/protocol';
import type { FeedSource, FeedStatus } from './types';

/**
 * In-browser mock — renders a believable race immediately with zero game-side
 * work, so the front-end is fully demoable on its own. Emits the same shapes the
 * real `monitor.*` feed will.
 */
function oval(rx: number, ry: number, seg = 96): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry, z: 0 });
  }
  return pts;
}

export function createMockFeed(): FeedSource {
  // The built-in mock stands in for the RMUC2026 AI arena so its 3D sandbox model
  // loads with zero game-side work. Arena half-extent ≈ 14.6m × 16m (the RMUC
  // half-field); cars circulate on a smaller oval that stays inside it.
  const rx = 1050; // car-path half-extent X (UE cm)
  const ry = 560; // car-path half-extent Y (UE cm)
  const ax = 1400; // arena half-extent X (UE cm) — full 28m length
  const ay = 800; // arena half-extent Y (UE cm) — ~16m width
  const map: MapWireframe = {
    mapId: 'RMUC2026AI',
    lines: [oval(rx, ry), oval(rx * 0.6, ry * 0.6)],
    bounds: { min: { x: -ax, y: -ay, z: 0 }, max: { x: ax, y: ay, z: 0 } },
  };
  const teams = ['red', 'blue'];
  const cars = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    name: `Car ${i + 1}`,
    team: teams[i % 2],
    phase: i / 6,
    speed: 0.05 + Math.random() * 0.05,
    health: 1,
  }));

  let mapCb: ((m: MapWireframe) => void) | null = null;
  let snapCb: ((s: WorldSnapshot) => void) | null = null;
  let statusCb: ((s: FeedStatus) => void) | null = null;
  let timer: number | null = null;
  let t = 0;

  function tick() {
    t++;
    const dt = 1 / 30;
    const vehicles: VehicleState[] = cars.map((c) => {
      c.phase = (c.phase + c.speed * dt) % 1;
      const a = c.phase * Math.PI * 2;
      const pos: Vec3 = { x: Math.cos(a) * rx, y: Math.sin(a) * ry, z: 60 };
      const yaw = (Math.atan2(Math.cos(a) * ry, -Math.sin(a) * rx) * 180) / Math.PI;
      c.health = Math.max(0.15, Math.min(1, c.health + (Math.random() - 0.49) * 0.03));
      return {
        id: c.id,
        name: c.name,
        team: c.team,
        pos,
        yaw,
        speed: Math.round(c.speed * 5000),
        health: c.health,
        score: Math.floor(t * c.speed),
      };
    });
    snapCb?.({ t, vehicles });
  }

  return {
    label: 'mock match',
    onMap: (cb) => (mapCb = cb),
    onSnapshot: (cb) => (snapCb = cb),
    onStatus: (cb) => (statusCb = cb),
    start: () => {
      if (timer != null) return; // already running — a second start() must not leak a timer
      t = 0;
      statusCb?.('open');
      mapCb?.(map);
      timer = window.setInterval(tick, 1000 / 30);
    },
    close: () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
      statusCb?.('closed');
    },
  };
}
