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

### Telemetry — the in-game `attribute.watchAttributeMaps` channel

The monitor consumes the **same** attribute-map stream the in-game HUD uses (plain
JSON over the match WebSocket), rather than a bespoke push. On connect it sends one
subscribe request, then receives `watchAttributeMaps.result` notifications; each is
folded into a per-map store and projected to the renderer's `WorldSnapshot`. The
single subscribe is the only thing it ever sends — otherwise it stays passive.

```ts
// request — "attribute.watchAttributeMaps" (sent once on connect)
interface WatchAttributeMapsParams { attribute_map_ids: number[]; watch_type: WatchType; }

// notification — "watchAttributeMaps.result" (server push)
interface WatchAttributeMapsResult { cycle_event_type?: number; watch_attribute_maps_results: AttributeMapUpdate[]; }
interface AttributeMapUpdate {
  sync_type: number;             // 0 = full replace, 1 = incremental patch
  attribute_map_id: number;      // one per entity (a "vehicle" carries PlayerID/Health)
  attributes: Record<string, number>;  // "<AttrId>" -> value
}
```

`AttrId` (`packages/protocol/src/attributes.ts`) is a subset of the game's
player-observable attribute ids — `Health`, `HealthMax`, `TeamID`, `PlayerID`,
firing heat, ammo counts, `Defeated`, … The monitor parses exactly the ids the HUD
does. The store projects the attribute maps into the renderer's internal shape:

```ts
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

> **Pending attribute ids:** world **position** and **chassis/turret heading** are
> not in the attribute map yet. Until the game writes them in (see *Game-side
> requirements* below), `VehicleState.pos` uses a deterministic placeholder layout
> so the parse chain and per-unit panels stay testable.

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
2. **Expose per-robot state on the `attribute.watchAttributeMaps` channel** — the
   same channel the in-game HUD already streams. Health / max-health / team /
   player-id are already present; the monitor additionally needs **world position**
   and **chassis + turret heading** written into each robot's attribute map so it
   can place and orient pieces on the board.

Map geometry needs **no** game-side push: the monitor places the arena client-side
from the beacon's `mapId` plus the static placement config, falling back to a
wireframe only for maps it has no model for.

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
