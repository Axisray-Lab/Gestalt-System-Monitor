# Architecture & wire contract

This monitor connects to **Gestalt System** match processes over the LAN and
renders live match state with Three.js. This doc records (a) the monitor's own
architecture, (b) the wire contract it speaks — all of which is observable on the
LAN — and (c) the game-side support that *real* (non-mock) matches need.

---

## Topology

Browsers cannot listen to UDP broadcast, so a thin Node **discovery agent** does
it for them, and is otherwise out of the data path:

- **Discovery agent** — sniffs the `udp/7999` LAN beacon, tracks live matches,
  and serves the resulting process list to the browser over its own WebSocket
  (`ws://localhost:7788` by default). With `--mock` it also synthesizes a fake LAN
  (beacons + feeds) so the front-end runs with zero game-side work.
- **Browser SPA** — reads the process list from the agent, then connects
  **directly** to each match's WebSocket (`ws://<ip>:<wsPort>`) and renders the
  passive telemetry feed. The agent never relays match data.

---

## Wire contract (what the monitor speaks)

Defined in `packages/protocol`. The mock agent emits exactly these shapes, and
the live `wsFeed` consumes them.

### Discovery beacon — `udp/7999`

4-byte little-endian magic `0x4543484F` (`"ECHO"`) followed by UTF-8 JSON:

```ts
interface BeaconPayload {
  matchId: string;   // stable per-process id
  name?: string;
  mapId?: string | number;
  wsPort: number;    // the WebSocket port to connect to (randomized per process)
  httpPort?: number;
  playerCount?: number;
  maxPlayers?: number;
  version?: string;
}
```

The agent injects `sourceIp` from the datagram and derives `wsUrl =
ws://<sourceIp>:<wsPort>`. The WS port is randomized per process, which is exactly
why the beacon has to announce it.

### Telemetry — JSON-RPC notifications on the game WebSocket

Envelope `{ type: 0, method, params }` (`type 0 = Request`, notification = no `id`).
The game broadcasts these to every connected client, so the monitor receives them
passively without sending anything.

```ts
// method "monitor.mapGeometry" — once on connect / map change
interface MapWireframe { mapId?: string|number; lines: Vec3[][]; bounds?: {min:Vec3; max:Vec3}; }

// method "monitor.worldSnapshot" — per tick
interface WorldSnapshot { t: number; vehicles: VehicleState[]; }
interface VehicleState {
  id: number;            // stable per-vehicle id
  name?: string; team?: string|number;
  pos: Vec3;             // UE world cm, Z-up
  yaw?: number;          // degrees
  speed?: number; health?: number; score?: number;
}
interface Vec3 { x: number; y: number; z: number; }   // UE cm, Z-up, left-handed
```

### Coordinate mapping

`packages/web/src/three/coords.ts`: `three.x = ue.x`, `three.y = ue.z`,
`three.z = -ue.y`, scaled cm → m (`0.01`). Uniform scale preserves directions, so
the same transform is reused for vehicle headings.

---

## Game-side requirements (for real, non-mock matches)

The mock agent emulates the end state so front-end work isn't blocked. Watching
real matches needs the game side to:

1. **Advertise the LAN beacon at boot** (including headless processes), with the
   payload carrying `wsPort` + `matchId` — so matches are auto-discoverable
   without any UI interaction.
2. **Push `monitor.mapGeometry`** on connect / on map change.
3. **Push `monitor.worldSnapshot`** per tick (e.g. 20–30 Hz) with each vehicle's
   `id` / `pos` / `yaw` / `team` / `health`.

For *launching* matches from the monitor, a headless launch entrypoint is also
needed. These items are coordinated on the game side and tracked separately; the
monitor is built so they can land independently.

> Security: the game WebSocket has no auth / origin check. Exposing it on the LAN
> is fine for a trusted network; consider a bind-allowlist before wider exposure.

---

## Repo layout & sharing

Monorepo with npm workspaces; `@gsm/protocol` is consumed straight from source
(Vite alias + tsx), no build step — it is the single source of truth for the wire
shapes both the agent and the SPA use.
