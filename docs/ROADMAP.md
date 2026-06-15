# Roadmap

How **Gestalt-System-Monitor** grows from a passive match viewer into a
strategy-authoring + spectating companion for **Gestalt System**.

Two tracks run in parallel:

- **Monitor track** (this repo, public) — the SPA + discovery agent + wire protocol.
- **Game-side capabilities** (tracked separately) — support the game must expose
  for each monitor version. These are described here only at the **wire / feature**
  level (what's observable to any client); implementation lives with the game.

Each monitor version ships only when its game-side dependency is available and the
two have been integration-tested together.

---

## Versions at a glance

| Version | Theme | Game-side dependency | Status |
|---|---|---|---|
| **v0.1** | **Live watch loop** — render real matches, not just the mock | GS-1 Live telemetry & auto-discovery | ▶ next |
| **v0.2** | **Launch & control** — discover the install + start headless AI-vs-AI from the monitor | GS-2 Headless match launch | planned |
| **v0.3** | **Replay & idle farm** — post-match diagnosis + a "watch your fleet" sidebar | GS-3 AI fleet quality & reproducible matches | planned |
| **v0.4** | **Strategy co-author** — natural-language → an inspectable, editable strategy artifact | GS-4 Player-authored strategies | exploratory |
| **v0.5** | **Ladder & sharing** — rank strategies, a curated opponent gym, share via Workshop | GS-4 Strategy distribution | exploratory |

> Status legend: **▶ next** (active) · **planned** (designed, not started) ·
> **exploratory** (vision; design open — see "Design notes").

---

## Track detail

### v0.1 — Live watch loop ▶
Make the monitor render **real** matches end-to-end (today it only renders the
built-in mock).

- Consume the live `monitor.mapGeometry` + `monitor.worldSnapshot` feed in `wsFeed`.
- Auto-discover real match processes via the LAN beacon (through the agent).
- Graceful "no live match" empty state; keep the mock as an always-present demo.
- **Acceptance:** with the game running a match on the LAN, the monitor discovers
  it and renders the map + moving vehicles with zero manual config.
- **Game-side GS-1:** boot-time discovery beacon carrying the WebSocket port +
  match id; per-tick `monitor.worldSnapshot`; `monitor.mapGeometry` on connect /
  map change. (Wire contract: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).)

### v0.2 — Launch & control
Let the monitor *start* matches, not just watch them.

- Agent gains: installed-game **path discovery** + a **launch** command
  (`child_process`) + a small control endpoint. The browser drives it; the agent
  is the privileged local process.
- UI: game-path picker, "start headless AI-vs-AI" with a match-config form, launch
  status, then auto-discover + watch the match it just started.
- **Game-side GS-2:** a packaged/scriptable headless entrypoint that boots an
  AI-vs-AI match and (via GS-1) advertises + streams it.

### v0.3 — Replay & idle farm
The "raising-game" payoff: watch, understand, iterate.

- A legible **post-match report** (what each unit did / why a side won) over the
  existing telemetry.
- An **idle/farm sidebar** in the *simulation-idle* sense — run matches in the
  background and surface results to act on (not an AFK currency grind).
- **Game-side GS-3:** AI matches good enough to be worth watching, and
  **reproducible** (seeded / replayable) so a diagnosis maps to a cause and an A/B
  tweak is comparable.

### v0.4 — Strategy co-author *(exploratory)*
Lower the authoring floor without removing the skill ceiling.

- A user supplies an LLM API key; natural-language intent compiles into an
  **inspectable, editable strategy artifact** (data, schema-validated — not opaque
  generated code). The player owns and hand-tunes it.
- `generate → validate → preview` loop, with the API call brokered by the agent so
  the key never lives in browser JS.
- **Game-side GS-4:** a data-driven, player-authored strategy format the game can
  load safely.

### v0.5 — Ladder & sharing *(exploratory)*
The social long-tail.

- Rank strategies (ELO), a curated **opponent gym**, and **Workshop sharing** as
  the non-finite content source.
- **Game-side GS-4:** safe distribution + execution of player-authored strategies
  (sandboxing / anti-degeneracy / reproducibility carry over from GS-3).

---

## How we work

- **Roadmap → Milestones (versions) → Feature requests (issues) → PRs → review → release.**
- Feature requests are **small and self-contained**, each with a fixed shape:
  **Background · Acceptance criteria (checkable) · Verification command · Out of scope.**
  Low granularity keeps each unit easy to implement and review (and easy for an
  automated coding agent to digest).
- A change ships behind **CI green + acceptance met**, and is **merged by a human**
  after review — CI passing is necessary, not sufficient.
- Game-side work is coordinated separately; a monitor version is only marked done
  after **integration testing** against the real game build.

## Design notes

The v0.4/v0.5 "raising-game" direction is deliberately marked exploratory. Its
depth depends on resolving, before commitment: where the *expert* skill ceiling
lives if strategies are made legible enough for an LLM to author; match-sim
**reproducibility**; whether spectating is fast/fun enough to iterate on; and safe
execution of shared strategy logic. The near-term versions (v0.1–v0.3) deliver
standalone value and don't depend on those answers.
