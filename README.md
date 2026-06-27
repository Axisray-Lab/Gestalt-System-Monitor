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

# The SPA — `npm run dev` ALSO auto-spawns the real discovery/launcher agent
# (no second terminal needed):
npm run dev                       # http://localhost:5180  (+ agent on :7788)

# Built-in fake LAN instead of real discovery:
GSM_AGENT="--mock" npm run dev    # PowerShell: $env:GSM_AGENT='--mock'; npm run dev

# Run the agent yourself (don't let the dev server spawn one):
GSM_AGENT=off npm run dev
```

For the **full product** — the desktop dock that docks to the screen edge and
launches matches — see [`docs/DESKTOP.md`](docs/DESKTOP.md):

```bash
npm run desktop:dev               # web@5180 + auto agent@7788 + the Tauri dock
# or, detached + clean (Windows):  pwsh scripts/monitor-start.ps1 -Restart
```

- The SPA opens on the **Built-in mock match** immediately (no agent required).
- With `GSM_AGENT="--mock"`, two fake "LAN matches" appear in the sidebar; click one
  to watch its live `ws://` feed end-to-end.
- The dev server auto-discovers replay datasets under `./traces` — see
  [Local launcher](#local-launcher) and [`docs/DESKTOP.md`](docs/DESKTOP.md).

> **Local config** lives in a gitignored `.env.local` (copy [`.env.example`](.env.example)) —
> launch profile, the standalone exe path, agent mode, etc. See
> [`docs/DESKTOP.md`](docs/DESKTOP.md#dev-launch-source-local-standalone-vs-steam).

> **Clean shutdown matters:** the desktop dock reserves a screen edge (a Windows
> AppBar) and parents the agent + any launched game. Close the dock window normally,
> or run `pwsh scripts/monitor-stop.ps1`, so those resources are released — a hard
> `taskkill /F` leaks the reserved strip and orphans game windows. See
> [`docs/DESKTOP.md`](docs/DESKTOP.md#startup--shutdown-resource-lifecycle-read-this-for-killed-but-not-released).

## Local launcher

The same agent also owns privileged local actions for the browser: it scans Steam
libraries or a configured standalone executable for **Gestalt System**, reports
host CPU/RAM headroom, and can start headless match batches through the configured
headless entrypoint.

By default it looks for a Steam app manifest named `Gestalt System`, but launching
is disabled until a real headless auto-battle command is configured. Public
configuration can provide that launch shape without baking game-side implementation
details into this repo:

```bash
npm run agent -- --game-exe "C:\Games\Gestalt System\Gestalt System.exe" --headless-args "--your-headless-auto-battle-args"
```

For local development against an editor-built standalone, prefer the standalone
profile. If `GSM_GAME_EXE` is not set, `GSM_STANDALONE_EXE` is also used as the
configured install candidate, so the launcher does not depend on Steam discovery:

```bash
GSM_HEADLESS_PROFILE=standalone
GSM_STANDALONE_EXE=D:\Builds\GestaltSystem\RobotBridgeDemo\Binaries\Win64\RobotBridgeDemo.exe
GSM_HEADLESS_MATCH_INTERVAL_SEC=5
GSM_HEADLESS_ATTR_RECORD=1
```

Launch requests separate total work from concurrency:

```json
{ "targetMatches": 50, "parallelism": 1, "autoSave": true }
```

`targetMatches` is the number of matches the batch should run before the agent
stops its worker process(es). `parallelism` is the number of standalone/UE worker
processes to run at the same time. The older `{ "count": N }` shape is still
accepted for compatibility, but the desktop UI now sends the explicit batch shape.

Useful overrides:

| Flag | Environment variable | Default |
|---|---|---|
| `--steam-app-id` | `GSM_STEAM_APP_ID` | app manifest name match |
| `--game-dir` | `GSM_GAME_DIR` | Steam library scan |
| `--game-exe` | `GSM_GAME_EXE` | executable inferred from install name |
| `--game-exe-name` | `GSM_GAME_EXE_NAME` | executable inferred from install name |
| `--headless-args` | `GSM_HEADLESS_ARGS` | disabled until configured |
| `--headless-profile` | `GSM_HEADLESS_PROFILE` | optional; `standalone` or `ue` build common headless commands |
| `--standalone-exe` | `GSM_STANDALONE_EXE` | required for `GSM_HEADLESS_PROFILE=standalone` |
| `--standalone-cwd` | `GSM_STANDALONE_CWD` | executable directory |
| `--standalone-log` | `GSM_STANDALONE_LOG` | optional dev fallback; reads the latest standalone WebSocket port from the local log |
| `--standalone-ws-port` | `GSM_STANDALONE_WS_PORT` | optional fixed-port dev fallback when the launched process does not beacon |
| `--autosave-dir` | `GSM_AUTOSAVE_DIR` | `traces/autosave` |
| `--ue-exe` | `GSM_UE_EXE` | required for `GSM_HEADLESS_PROFILE=ue` |
| `--ue-project` | `GSM_UE_PROJECT` | required for `GSM_HEADLESS_PROFILE=ue` |
| `--mapid` / `--map-id` | `GSM_HEADLESS_MAP_ID` | `9` for the UE profile |
| `--match-memory-mb` | `GSM_HEADLESS_MEMORY_MB` | `2048` |
| `--match-cpu-cores` | `GSM_HEADLESS_CPU_CORES` | `2` |
| `--reserve-memory-mb` | `GSM_RESERVE_MEMORY_MB` | `2048` |

The SPA warns when the local service estimates there is not enough remaining
CPU/RAM for the requested parallel workers; a deliberate click still launches the
batch. When `autoSave` is enabled on the
`standalone` or `ue` profile, the agent adds `-attrrecord`, assigns per-worker
`-abslog` / `-UserDir` paths, counts completed matches from `[ATTR-RECORD]` game
time resets, writes `combined.log`, and runs the local trace analyzer into the
batch save directory. The real headless match entrypoint is the GS-2 game-side
capability described in [`docs/ROADMAP.md`](docs/ROADMAP.md).

If another agent already owns `7788`, run a second one with `--port 7790` and open
the SPA with `?agent=ws://localhost:7790`.

## Layout

| Package | What |
|---|---|
| `packages/protocol` | Shared TS types + wire constants for the game's LAN beacon, JSON-RPC envelope, and the `monitor.*` feed. |
| `packages/agent` | Node discovery agent (UDP sniff → browser WS). `--mock` synthesizes a fake LAN. |
| `packages/web` | Vite + Vue 3 + Three.js SPA (the `index.html` monitor + the `deck.html` dock UI). |
| `packages/desktop` | Tauri bottom-edge **AppBar dock** that loads the deck UI and auto-spawns the agent as a background local service. See [`docs/DESKTOP.md`](docs/DESKTOP.md). |

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
