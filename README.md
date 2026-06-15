# Gestalt-System-Monitor

A LAN match monitor for **Gestalt System** matches. It auto-discovers running
matches on the local network and renders each one in the browser with
**Three.js** — map wireframe, vehicle point positions, and a floating info panel
above every car.

> Status: **front-end scaffold (v0)**. The SPA runs today against a built-in mock
> match. Watching *real* matches additionally needs a small amount of game-side
> support — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
> ("Game-side requirements"). The monitor is built so that work can land
> independently.

## Why an "agent"

Browsers cannot listen to UDP broadcast, and the LAN-discovery beacon is a UDP
broadcast (`udp/7999`, magic `"ECHO"`). So a thin Node **discovery agent** sniffs
the beacon and serves a live process list to the SPA over its own WebSocket. The
browser then connects **directly** to each game process's WebSocket
(`ws://<ip>:<wsPort>`) for the telemetry feed — the agent is not in the data path.

```
 game process(es)            discovery agent            browser SPA
 ┌───────────────┐  udp/7999 ┌──────────────┐  ws       ┌──────────────┐
 │ Game WS server │ ───────▶ │ sniff beacon │ ───────▶  │ process list │
 │ + LAN beacon   │  beacon  │ process list │  list     │              │
 └───────┬────────┘          └──────────────┘           │  Three.js    │
         │   ws:// live world feed (direct, passive)     │  renderer    │
         └──────────────────────────────────────────────▶              │
                                                         └──────────────┘
```

## Quick start

```bash
npm install

# Terminal A — discovery agent with a built-in fake LAN (no game build needed):
npm run agent:mock

# Terminal B — the monitor SPA:
npm run dev        # http://localhost:5180
```

- The SPA opens on the **Built-in mock match** immediately (no agent required).
- With `agent:mock` running, two fake "LAN matches" appear in the sidebar; click
  one to watch its live `ws://` feed end-to-end.
- For real matches, run `npm run agent` (no `--mock`) once the game-side
  support is in place.

## Layout

| Package | What |
|---|---|
| `packages/protocol` | Shared TS types + wire constants for the game's LAN beacon, JSON-RPC envelope, and the `monitor.*` feed. |
| `packages/agent` | Node discovery agent (UDP sniff → browser WS). `--mock` synthesizes a fake LAN. |
| `packages/web` | Vite + Vue 3 + Three.js SPA. |

## Conventions matched to the game

- **Three.js `^0.184`** — matches the game client's renderer major.
- **JSON-RPC envelope** `{type,id?,method,params}` with `type` `0=Request`,
  `1=Response` — identical to the game's in-game WebSocket bridge, so the monitor
  is just another passive client on the same socket the game UI uses.
- **Discovery**: `udp/7999`, 4-byte LE magic `0x4543484F`, `5s` room expiry.
- **Coordinates**: UE world cm / Z-up / left-handed → Three.js m / Y-up /
  right-handed (`packages/web/src/three/coords.ts`).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full wire contract and
the game-side support real matches need.
