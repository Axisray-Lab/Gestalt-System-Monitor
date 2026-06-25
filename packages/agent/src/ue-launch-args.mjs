/**
 * Single source of truth for building a headless UE launch from Node.
 *
 * ── THE PITFALL THIS PREVENTS (read before "simplifying") ────────────────────
 * UE `-game` treats the FIRST bare token (one that does NOT start with `-`) after
 * the .uproject as the **map URL**. Node's `child_process.spawn` — WITHOUT
 * `windowsVerbatimArguments` — cannot emit the `-switch="value with spaces"` form
 * UE needs: passing a flag and its value as two array elements
 * (e.g. `'-abslog', logPath` or `'-exec', 'SetMatchStatus 1'`) leaves the value as
 * a stray positional. UE then tries to load THAT path/string as a map and pops:
 *
 *     "The map specified on the commandline '<...>RobotBridgeDemo.log' could not be
 *      found. Would you like to load the default map instead?"
 *
 * In headless (`-nullrhi`/`-NonInteractive`) that prompt auto-declines → no map →
 * the process exits (code 3) → recorder reports "no matches detected". We hit this
 * repeatedly. The proven launcher (gestalt_system/scripts/ai-match-selftest.ps1)
 * builds the line in EQUALS+QUOTED form:
 *
 *     "<uproject>" -game -nullrhi ... -abslog="<log>" -UserDir="<dir>"
 *     -exec="SetMatchStatus 1" -ExecCmds="..." -attrrecord -attrrecordhz=10
 *
 * We reproduce that byte-for-byte from Node by (a) pre-quoting every value-bearing
 * token and the project path, and (b) spawning with `windowsVerbatimArguments:true`
 * so Node passes our quotes through verbatim instead of re-escaping them. The ONLY
 * legitimate positional is the .uproject; the map is chosen via `-mapid` +
 * `-autostart`, never a URL.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RENDER_TOKENS = {
  // maximum-headless: no GPU/RHI. The mode the monitor records against.
  nullrhi: ['-nullrhi', '-nosound', '-maxfps=60'],
  // headless but with a GameViewport (CEF/Vue mounts); still uses the GPU.
  offscreen: ['-RenderOffscreen', '-nosound', '-maxfps=60'],
  // on-screen window (human/debug).
  windowed: [],
};

const q = (s) => `"${String(s)}"`;

/**
 * Build the verbatim arg list + spawn options for a headless AI match.
 * @returns {{ args: string[], spawnOptions: { windowsVerbatimArguments: boolean } }}
 *   ready for `spawn(exe, args, { ...yourOpts, ...spawnOptions })`.
 */
export function buildUeLaunch({
  uproject,
  mapId = 9,
  userDir,
  logPath,
  render = 'nullrhi',
  attrHz = 10,
  hudHidden = 0,
  netType = 0,
  connMethod = 0,
  autostartDelayMs = 3000,
  execDelayMs = 15000,
  exec = 'SetMatchStatus 1',
  execCmds = 'r.ObPanel.Enable 1, r.ObPanel.DebugIcons 1',
  matchIntervalSec = 0,
} = {}) {
  if (!uproject) throw new Error('buildUeLaunch: uproject is required');
  const args = [
    q(uproject), // quoted: path has spaces AND is the only legit positional
    '-game',
    ...(RENDER_TOKENS[render] ?? RENDER_TOKENS.nullrhi),
    '-log',
    // -abslog/-UserDir/-exec/-ExecCmds: EQUALS form, value quoted (paths/strings
    // contain spaces). Never flag+value as two tokens — see the header.
    ...(logPath ? [`-abslog=${q(logPath)}`] : []),
    ...(userDir ? [`-UserDir=${q(userDir)}`] : []),
    '-blockexitprogram',
    '-autostart',
    `-mapid=${mapId}`,
    `-nettype=${netType}`,
    `-connmethod=${connMethod}`,
    `-autostartdelay=${autostartDelayMs}`,
    `-execdelay=${execDelayMs}`,
    `-hudhidden=${hudHidden}`,
    ...(exec ? [`-exec=${q(exec)}`] : []),
    ...(execCmds ? [`-ExecCmds=${q(execCmds)}`] : []),
    '-attrrecord',
    `-attrrecordhz=${attrHz}`,
    ...(matchIntervalSec > 0 ? [`-matchinterval=${matchIntervalSec}`] : []),
  ];
  return { args, spawnOptions: { windowsVerbatimArguments: true } };
}

/** The exact command line (for logging / sanity-diffing against the .ps1 launchLine). */
export function ueLaunchLine(exe, args) {
  return `${exe} ${args.join(' ')}`;
}
