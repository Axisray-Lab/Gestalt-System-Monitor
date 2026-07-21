# Gestalt-System-Monitor

A LAN match monitor for **Gestalt System** matches. It auto-discovers running
matches on the local network and renders each one in the browser with
**Three.js** — map wireframe, vehicle point positions, and a floating info panel
above every car.

> Status: **front-end scaffold (v0)**. GitHub Pages includes three static
> RMUC 2026 regional-final replay series. Watching _live_ matches additionally
> needs a small amount of game-side support — see
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ("Game-side requirements").
> The monitor is built so that work can land independently.

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
npm run desktop:dev               # web@5180 + Rust-owned agent@7788 + Tauri dock
# or, detached + clean (Windows):  pwsh scripts/monitor-start.ps1 -Restart
```

- The GitHub Pages build opens with the three **RMUC 2026 regional-final**
  replay series available without an agent.
- With `GSM_AGENT="--mock"`, two fake "LAN matches" appear in the sidebar; click one
  to watch its live `ws://` feed end-to-end.
- The dev server auto-discovers replay datasets under `./traces` — see
  [Local launcher](#local-launcher) and [`docs/DESKTOP.md`](docs/DESKTOP.md).

> **Local config** lives in a gitignored `.env.local` (copy [`.env.example`](.env.example)) —
> launch profile, the standalone exe path, agent mode, etc. See
> [`docs/DESKTOP.md`](docs/DESKTOP.md#dev-launch-source-local-standalone-vs-steam).

> **Desktop lifecycle:** use Settings → **退出 Monitor** or
> `pwsh scripts/monitor-stop.ps1` for an ordered, verified shutdown. A Windows Job,
> detached AppBar watchdog and persisted lease also cover crashes/forced exits; the
> stop script verifies that the native work area returned to its pre-launch value. See
> [`docs/DESKTOP.md`](docs/DESKTOP.md#startup--shutdown-resource-lifecycle-read-this-for-killed-but-not-released).

## RMUC 2026 GitHub Pages replays

The Pages build enables three static replay series derived from the official
RMUC 2026 regional dataset:

- East regional final M88 — Shandong University of Science and Technology vs.
  China University of Petroleum (East China), four games.
- South regional final M88 — Wuyi University vs. South China Agricultural
  University, three games.
- North regional final M90 — Northeastern University vs. Harbin Institute of
  Technology, four games.

The official robot and structure samples are 1 Hz. The fixture generator emits
the Monitor replay contract at 10 Hz: pose values use deterministic interpolation,
while health, level, economy, buff, and other discrete state use step/hold
semantics. It does not add vehicle physics or recalculate authoritative damage.

Remaining launch allowance is not an authoritative field in the public dataset.
The replay therefore labels ground-robot ammunition as a deterministic estimate
and records its derivation, bounds, and anomalies in the fixture metadata.
It must not be interpreted as an official value.

Buff event rows do not carry their numeric effects. Values that are determinate
from the public competition rules — including terrain, energy-mechanism, and
technology-level effects — are reconstructed from those rules and the official
event timeline. The dataset's vulnerability field is projected as an icon-only
boolean; these fixtures do **not** claim to recover a vulnerability multiplier.

Generate and strictly verify the fixtures with:

```bash
npm run generate:rmuc2026-pages
npm run verify:rmuc2026-pages
```

Both commands fail on missing or unexpected source data and invalid replay
output. There is no synthetic replay or silent fallback. See the
[fixture README](packages/web/public/replays/rmuc2026-regionals/README.md) for
the file-level provenance and limitations.

The derived replay data is distributed under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), following
the [official RMUC 2026 dataset release](https://bbs.robomaster.com/article/1936220?source=1).
This notice applies to the derived fixture data and does not relicense the
Monitor source code.

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
| `--mapid` / `--map-id` | `GSM_HEADLESS_MAP_ID` | `4` for the UE profile |
| `--match-memory-mb` | `GSM_HEADLESS_MEMORY_MB` | `2048` |
| `--match-cpu-cores` | `GSM_HEADLESS_CPU_CORES` | `2` |
| `--reserve-memory-mb` | `GSM_RESERVE_MEMORY_MB` | `2048` |

The SPA warns when the local service estimates there is not enough remaining
CPU/RAM for the requested parallel workers; a deliberate click still launches the
batch. When `autoSave` is enabled on the `standalone` or `ue` profile, the agent
adds `-replaytracks`, assigns per-worker `-abslog` / `-UserDir` paths, and keeps
the WebSocket recorder only for lightweight progress, summary, and event files.
The game atomically finalizes one RBREPLAY v4 file per match; the agent copies it
into the batch worker directory and does not count that match complete until the
telemetry boundary and finalized `.rbreplay` are both present. That single file
drives game 3D playback, Monitor playback, and offline AI analysis; autosave no
longer writes a second `.trace.json` or `.rbrecord` state recording. Monitor
decodes AttributeMap lifecycle events directly from the native world
packet stream, including checkpoint rebuilds and map recycling; no sampled
Attribute side track is recorded.

The real headless match entrypoint is the GS-2 game-side capability described in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

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
the game-side support real matches need. For the live + RBREPLAY AttributeMap
decode, lifecycle, semantic projection, and renderer reading path, see
[`docs/ATTRIBUTE_MAP_PIPELINE.md`](docs/ATTRIBUTE_MAP_PIPELINE.md).
