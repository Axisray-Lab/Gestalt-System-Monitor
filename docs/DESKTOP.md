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
 │  • single-instance mutex + AppBar lease/watchdog                                  │
 │  • registers a Windows AppBar (SHAppBarMessage ABM_NEW) reserving the bottom edge │
 │  • owns a kill-on-close Windows Job and an agent ownership token                  │
 │  • supervisor thread (every 3s): ensure_local_service()                           │
 └───────────────┬──────────────────────────────────────────────────────────────────┘
                 │ owns (or safely adopts an already-compatible external service)
                 ▼
        discovery + launcher AGENT  (localhost:7788)
         dev  : Rust spawns `npm run agent` with a private `GSM_OWNER_TOKEN`
         prod : Rust spawns the bundled `gsm-agent` sidecar directly
                 │ spawns (detached)
                 ▼
        game process(es)  (the standalone / Steam build) — beacon udp/7999 + ws://
```

- **Desktop dev**: `npm run desktop:dev` → `tauri dev`. Its `beforeDevCommand`
  starts Vite in `desktop` mode on `:5180`; that mode deliberately disables Vite's
  agent plugin. Rust is therefore the only agent owner and starts `npm run agent`
  with a private token. This removes the old split ownership between Vite and Rust.
- **Web-only dev**: `npm run dev` still lets Vite own one agent child. It uses the
  same token-authenticated shutdown endpoint and only reaps the child it spawned.
- **Prod**: there is no vite. The Rust supervisor spawns the bundled `gsm-agent`
  sidecar next to `app.exe`.

If a compatible agent is already listening on `:7788`, desktop/web dev may use it,
but they never claim or kill it. A stale or foreign listener is reported and left
untouched instead of being killed by port number.

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

The dock holds an AppBar work-area reservation and may own an agent → game → recorder
process tree. The lifecycle is intentionally layered: the normal path performs an
ordered cleanup, while a Windows Job, detached AppBar watchdog and persisted lease
cover exits where application callbacks cannot run.

**Startup (ordered):**
1. Create a `KILL_ON_JOB_CLOSE` Windows Job before reserving any desktop space.
2. Acquire the single-instance mutex — a 2nd dock exits instead of stacking an
   AppBar reservation.
3. Under a cross-process lease mutex, remove a stale persisted lease, start a
   breakaway broker which creates the detached watchdog, then register `ABM_NEW`.
   Registration, WndProc subclassing, `ABM_SETPOS` and lease persistence are checked;
   any failure rolls the registration back and aborts startup.
4. Start stoppable periodic workers. AppBar work is enqueued onto the HWND-owning
   Tauri thread; the worker never calls Shell/window APIs from a background thread.
5. Supervisor loop (3s): use an already-compatible external agent without owning
   it, otherwise spawn exactly one token-owned agent child. Re-apply a persisted
   non-default launch source once it is ready.

**Normal shutdown (ordered) — runs on window Close, explicit “退出 Monitor”,
`ExitRequested` and `Exit`:**
1. Set the one-way shutdown flag, synchronously send `ABM_REMOVE`, restore Wry's
   original WndProc and delete the AppBar lease. No later reassert can re-register it.
2. Stop and join the periodic workers.
3. POST `/shutdown` with the owned agent's private token. The agent rejects non-
   loopback or wrong-token requests, synchronously stops games/recorders/sockets,
   then exits. Rust waits up to four seconds and only then tree-kills **its own**
   child as a fallback. There is no port-owner sweep.
4. Process exit closes the Job handle, which kills any owned descendant that escaped
   the cooperative path. An adopted external agent is intentionally unaffected.

**Hard-exit coverage:**

- Console C/CLOSE/BREAK removes the AppBar synchronously before posting `WM_CLOSE`.
- The final watchdog is outside both the dock's Job and its live process tree. It
  waits on the dock process handle and runs `ABM_REMOVE` if the dock is terminated or
  crashes. A broker process exits before `ABM_NEW`, so `taskkill /T` cannot sweep the
  final watchdog as a descendant.
- `appbar-lease.json` in the OS app-config directory is a second recovery layer. A
  later instance removes a matching stale registration before creating a new one;
  owner matching prevents a late old watchdog from touching the new instance.
- Job close reaps the desktop-owned agent, games and recorders even when Rust/Node
  cleanup code never runs.

**Verified stop from a terminal** first closes the dock normally, then kills only
processes proven to belong to this checkout/session. It compares every monitor's
native-pixel work area with the baseline captured by `monitor-start.ps1`; foreign
owners of `:7788`, `:5180` or `:5191` are reported and never killed:

```powershell
pwsh scripts/monitor-stop.ps1                 # dock + owned agent + owned web
pwsh scripts/monitor-stop.ps1 -IncludeGames   # also owned descendant game processes
```

### Known limitations
- Reservations leaked by a **pre-lease build** have no saved HWND for the new
  watchdog to deregister. Repair that one legacy work area once (normally by
  restarting Explorer); `monitor-start.ps1` refuses to stack a new 320px AppBar on
  top of a suspicious existing reservation.
- An adopted external agent and its games have a different owner and intentionally
  survive desktop shutdown. Stop them through their own launcher/session.
- On a forced agent/Job termination the process tree is still reaped, but a
  recorder's final buffered summary may be truncated.
