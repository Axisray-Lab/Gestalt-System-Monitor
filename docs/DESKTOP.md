# Desktop dock — architecture, dev runbook & resource lifecycle

`packages/desktop` is the **Gestalt System Monitor** desktop app: a Tauri window
that docks to the bottom edge of a chosen monitor as a Windows **AppBar** and loads
the monitor's `deck.html` deck UI. It is deliberately *not* a floating always-on-top
overlay — as an AppBar it **reserves a strip of the desktop work area** (like a
second taskbar), so maximized windows stop above it.

This doc covers the dock's process model, the dev runbook, the dev launch-source
toggle (local standalone vs Steam), and — most importantly — the **startup/shutdown
resource-release contract**, because an ungraceful kill is what leaves the reserved
screen edge and orphaned game windows behind.

---

## Process model

```
 ┌───────────────────────────────── desktop dock (app.exe, Tauri) ──────────────────┐
 │  • single-instance named mutex (no 2nd dock → no stacked AppBar reservation)      │
 │  • registers a Windows AppBar (SHAppBarMessage ABM_NEW) reserving the bottom edge │
 │  • supervisor thread (every 3s): ensure_local_service()                           │
 └───────────────┬──────────────────────────────────────────────────────────────────┘
                 │ spawns / adopts
                 ▼
        discovery + launcher AGENT  (localhost:7788)
         dev  : the web dev server's vite `gsm-agent` plugin spawns it
                (`npm run agent`); Rust only spawns it as a FALLBACK if 7788 is free
         prod : Rust spawns the bundled `gsm-agent` sidecar directly
                 │ spawns (detached)
                 ▼
        game process(es)  (the standalone / Steam build) — beacon udp/7999 + ws://
```

- **Dev**: `npm run desktop:dev` → `tauri dev`. Its `beforeDevCommand`
  (`tauri.conf.json`) starts the web dev server on `:5180`, whose vite `gsm-agent`
  plugin (`packages/web/vite.config.ts`) auto-spawns the **real** agent on `:7788`.
  The Rust supervisor sees that agent as "current" and does **not** spawn a second
  one. So in dev the agent is owned by the web dev server — **do not also run
  `npm run agent` yourself**.
- **Prod**: there is no vite. The Rust supervisor spawns the bundled `gsm-agent`
  sidecar next to `app.exe`.

---

## Dev runbook

Prereqs: Node + npm, the Rust toolchain, and the Tauri v2 CLI deps (WebView2 is
present on Windows 10/11).

```powershell
# From the submodule root (Monitor/):
npm install
npm run desktop:dev          # web@5180 + auto agent@7788 + the Tauri dock
```

Or use the helper that runs detached + waits for readiness, and refuses to stack a
second instance:

```powershell
pwsh scripts/monitor-start.ps1 -Restart   # stop any old instance first, then start
pwsh scripts/monitor-start.ps1 -Mock      # agent against the built-in fake LAN
```

Web-only (no dock):

```powershell
npm run dev                       # SPA + auto agent (same as desktop, minus the dock)
$env:GSM_AGENT='--mock'; npm run dev   # SPA + fake LAN
$env:GSM_AGENT='off';   npm run dev    # SPA only; run the agent yourself
```

The agent's local config (which game to launch) is read from a **gitignored**
`Monitor/.env.local` — see [Dev launch source](#dev-launch-source-local-standalone-vs-steam)
and [`.env.example`](../.env.example).

---

## Dev launch source: local standalone vs Steam

On a dev machine you usually want the dock to launch **this repo's editor-built
standalone**, not a Steam install. Two layers control this:

1. **Default (config).** `Monitor/.env.local` sets the agent's launch profile:

   ```ini
   GSM_HEADLESS_PROFILE=standalone
   GSM_STANDALONE_EXE=...\gestalt_system\Binaries\Win64\RobotBridgeDemo.exe
   GSM_STANDALONE_CWD=...\gestalt_system\Binaries\Win64
   GSM_STANDALONE_LOG=...\gestalt_system\Saved\Logs\RobotBridgeDemo.log
   ```

   This file is per-machine and gitignored (`*.local` / `.env.*`), so the private
   game path never enters this public repo.

2. **Runtime toggle.** The dock's **Desktop settings → 启动源** switch lets you flip
   between **本地 standalone** and **Steam** without editing files. The choice
   persists to `desktop-settings.json` (in the OS app-config dir, *outside* the
   repo), and the dock POSTs it to the running agent (`POST /launch/source`). It
   takes effect on the **next launch** — the agent is **not** respawned, so no
   in-flight match is interrupted and no game window is orphaned.

Both sources reuse the same `standalone` launch profile and differ only in
exe/cwd (the Steam source resolves the discovered Steam install's executable). This
matters because clearing the profile entirely would disable launching, and because
a per-launch `installId` is **ignored** under the `standalone` profile — the profile
forces the executable, so the toggle must live at the profile/exe level (which is how
the agent's `launchSourceOverride` works).

> Spectating a dev standalone match relies on the agent reading the game's
> `WebSocket server started on <host>:<port>` log line (`GSM_STANDALONE_LOG`) or the
> udp/7999 beacon to learn the per-process ws port.

---

## Startup / shutdown resource lifecycle (read this for "killed but not released")

The dock holds **OS-level resources that only release on a graceful shutdown**: the
AppBar work-area reservation, the agent process tree (which owns port 7788 and is the
parent of every launched game), and the recorder children. A hard `taskkill /F` on
the dock — or `tauri dev`'s rebuild `TerminateProcess` — skips the cleanup and leaves
the reserved screen edge + orphaned game windows behind. That is the
"killed the game but Windows didn't free the window" symptom.

**Startup (ordered):**
1. Single-instance named mutex — a 2nd dock exits instead of stacking a 2nd AppBar.
2. Register the AppBar (`ABM_NEW`) on the selected monitor.
3. Supervisor loop (3s): spawn/adopt the agent; skip if a managed child is already
   alive (prevents the cold-start duplicate-spawn) or if 7788 is already "current".
4. Re-apply a persisted non-default launch source to the agent once it is up.

**Shutdown (ordered) — runs on window Close / `RunEvent::Exit`:**
1. `ABM_REMOVE` releases the reserved screen edge (`appbar::remove`).
2. Tree-kill the managed agent (`taskkill /T /F` on the whole `npm → node → games`
   tree), then reap it.
3. Sweep any agent still holding port 7788 (e.g. one spawned by the web dev server).
4. The agent's own `SIGINT`/`SIGTERM`/`SIGHUP` handler runs `shutdownAll()`:
   force-kills every still-running game (each launches with `-blockexitprogram`, so
   only a forced kill frees it) and every recorder child.

**Clean stop from a terminal** (does all of the above the right way — graceful close
first so the AppBar is released, then tree-kills the rest and frees the ports):

```powershell
pwsh scripts/monitor-stop.ps1                 # dock + agent + web
pwsh scripts/monitor-stop.ps1 -IncludeGames   # also sweep orphaned game windows
```

### Known limitations
- A true hard-kill of `app.exe` (crash, `taskkill /F`, kill from Task Manager)
  cannot run the in-process cleanup, so it can still leak the AppBar strip. Recover
  with `scripts/monitor-stop.ps1` (it gracefully closes any surviving dock) or by
  re-launching the dock (single-instance + a fresh `ABM_NEW`). Prefer closing the
  dock window normally, or `monitor-stop.ps1`, over `taskkill /F`.
- Recorder telemetry on agent-death is best-effort: the process is always reaped
  (no leak), but its final summary write may be truncated.
