/**
 * Gestalt-System-Monitor — LAN discovery agent.
 *
 * Browsers cannot listen to UDP broadcast, so this thin Node process sniffs the
 * LAN beacon (udp/7999, magic "ECHO") and serves a live process list to the
 * monitor SPA over its own WebSocket. The browser then connects *directly* to
 * each game process's WebSocket (ws://<ip>:<wsPort>) for the telemetry feed.
 *
 *   npm run agent          # real discovery only
 *   npm run agent:mock     # also synthesize fake LAN matches on this box
 */
import dgram from 'node:dgram';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  DISCOVERY_PORT,
  DISCOVERY_MAGIC,
  ROOM_EXPIRY_MS,
  BROADCAST_INTERVAL_MS,
  AGENT_BROWSER_PORT,
  type BeaconPayload,
  type DiscoveredProcess,
  type AgentProcessListMessage,
  type AgentLauncherStatusMessage,
  type HeadlessLaunch,
  type LaunchHeadlessRequest,
  type StopHeadlessRequest,
  type LauncherAutoSaveStatus,
} from '@gsm/protocol';
import { LaunchManager, type HeadlessLaunchContext } from './launcher';
import {
  buildStandaloneHeadlessLaunch,
  buildUeHeadlessLaunch,
  splitArgs,
  type HeadlessLaunchConfig,
} from './headless-launch';
import { startMock } from './mock';
import { startScenarioMock } from './mock';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { TraceReplayer } from './trace-replayer';

const argv = process.argv.slice(2);
const workspaceRoot = findWorkspaceRoot();
loadLocalEnv(workspaceRoot);
const MOCK = argv.includes('--mock');
const MOCK_SCENARIO = argv.includes('--scenario');
const browserPort = numFlag('--port', AGENT_BROWSER_PORT);
const headlessLaunch = buildHeadlessLaunchConfig();
const defaultSaveDir = path.resolve(
  workspaceRoot,
  stringFlag('--autosave-dir', process.env.GSM_AUTOSAVE_DIR ?? 'traces/autosave') ?? 'traces/autosave',
);
const launcher = new LaunchManager(
  {
    gameName: stringFlag('--game-name', process.env.GSM_GAME_NAME ?? 'Gestalt System') ?? 'Gestalt System',
    steamAppId: stringFlag('--steam-app-id', process.env.GSM_STEAM_APP_ID),
    manualInstallDir: stringFlag('--game-dir', process.env.GSM_GAME_DIR),
    executablePath: stringFlag('--game-exe', process.env.GSM_GAME_EXE ?? headlessLaunch.executablePath),
    executableName: stringFlag('--game-exe-name', process.env.GSM_GAME_EXE_NAME),
    createLaunchConfig: buildHeadlessLaunchConfig,
    autoSave: autoSaveStatus(headlessLaunch, defaultSaveDir),
    defaultSaveDir,
    resourceBudget: {
      perMatchMemoryBytes:
        numFlag('--match-memory-mb', numEnv('GSM_HEADLESS_MEMORY_MB', 2048)) * 1024 * 1024,
      perMatchCpuCores: numFlag('--match-cpu-cores', numEnv('GSM_HEADLESS_CPU_CORES', 2)),
      reservedMemoryBytes:
        numFlag('--reserve-memory-mb', numEnv('GSM_RESERVE_MEMORY_MB', 2048)) * 1024 * 1024,
    },
  },
  () => broadcastLauncherStatus(),
);

function buildHeadlessLaunchConfig(context: HeadlessLaunchContext = {}): HeadlessLaunchConfig {
  const explicitArgs = stringFlag('--headless-args', process.env.GSM_HEADLESS_ARGS);
  if (explicitArgs?.trim()) {
    const verbatim = boolFlag('--headless-verbatim', boolEnv('GSM_HEADLESS_VERBATIM', false));
    return {
      args: splitArgs(explicitArgs, verbatim),
      windowsVerbatimArguments: verbatim,
      autoSaveAvailable: false,
      autoSaveEnabled: explicitArgs.includes('-attrrecord'),
      autoSaveMode: 'configured-args',
    };
  }

  const profile = stringFlag('--headless-profile', process.env.GSM_HEADLESS_PROFILE)
    ?.trim()
    .toLowerCase();
  if (profile === 'ue') {
    return buildUeHeadlessLaunch({
      executablePath: stringFlag('--ue-exe', process.env.GSM_UE_EXE ?? process.env.GSM_GAME_EXE),
      projectPath:
        stringFlag('--ue-project', process.env.GSM_UE_PROJECT) ??
        stringFlag('--uproject', process.env.GSM_UPROJECT),
      mapId: numFlag('--mapid', numFlag('--map-id', numEnv('GSM_HEADLESS_MAP_ID', 9))),
      render: renderFlag(),
      attrRecord: context.autoSave ?? boolFlag('--attrrecord', boolEnv('GSM_HEADLESS_ATTR_RECORD', false)),
      attrHz: numFlag('--attr-hz', numEnv('GSM_HEADLESS_ATTR_HZ', 10)),
      logPath: context.autoSave ? context.logPath : undefined,
      userDir: context.autoSave ? context.userDir : undefined,
      hudHidden: numFlag('--hud-hidden', numEnv('GSM_HEADLESS_HUD_HIDDEN', 0)),
      netType: numFlag('--net-type', numEnv('GSM_HEADLESS_NET_TYPE', 0)),
      connMethod: numFlag('--conn-method', numEnv('GSM_HEADLESS_CONN_METHOD', 0)),
      autostartDelayMs: numFlag('--autostart-delay-ms', numEnv('GSM_HEADLESS_AUTOSTART_DELAY_MS', 3000)),
      execDelayMs: numFlag('--exec-delay-ms', numEnv('GSM_HEADLESS_EXEC_DELAY_MS', 15000)),
      exec: optionalStringFlag('--headless-exec', process.env.GSM_HEADLESS_EXEC),
      execCmds: optionalStringFlag('--headless-exec-cmds', process.env.GSM_HEADLESS_EXEC_CMDS),
      matchIntervalSec: numFlag('--match-interval', numEnv('GSM_HEADLESS_MATCH_INTERVAL_SEC', 0)),
    });
  }

  if (profile === 'standalone') {
    return buildStandaloneHeadlessLaunch({
      executablePath: stringFlag(
        '--standalone-exe',
        process.env.GSM_STANDALONE_EXE ?? process.env.GSM_GAME_EXE,
      ),
      cwd: optionalStringFlag('--standalone-cwd', process.env.GSM_STANDALONE_CWD),
      mapId: numFlag('--mapid', numFlag('--map-id', numEnv('GSM_HEADLESS_MAP_ID', 9))),
      render: renderFlag(),
      attrRecord: context.autoSave ?? boolFlag('--attrrecord', boolEnv('GSM_HEADLESS_ATTR_RECORD', false)),
      attrHz: numFlag('--attr-hz', numEnv('GSM_HEADLESS_ATTR_HZ', 10)),
      logPath: context.autoSave ? context.logPath : undefined,
      userDir: context.autoSave ? context.userDir : undefined,
      hudHidden: numFlag('--hud-hidden', numEnv('GSM_HEADLESS_HUD_HIDDEN', 0)),
      netType: numFlag('--net-type', numEnv('GSM_HEADLESS_NET_TYPE', 0)),
      connMethod: numFlag('--conn-method', numEnv('GSM_HEADLESS_CONN_METHOD', 0)),
      autostartDelayMs: numFlag('--autostart-delay-ms', numEnv('GSM_HEADLESS_AUTOSTART_DELAY_MS', 3000)),
      execDelayMs: numFlag('--exec-delay-ms', numEnv('GSM_HEADLESS_EXEC_DELAY_MS', 15000)),
      exec: optionalStringFlag('--headless-exec', process.env.GSM_HEADLESS_EXEC),
      execCmds: optionalStringFlag('--headless-exec-cmds', process.env.GSM_HEADLESS_EXEC_CMDS),
      matchIntervalSec: numFlag('--match-interval', numEnv('GSM_HEADLESS_MATCH_INTERVAL_SEC', 0)),
    });
  }

  if (profile) {
    return { args: [], error: `Unknown headless launch profile "${profile}".` };
  }

  return {
    args: [],
    error:
      'Headless auto-battle launch is not configured. Set GSM_HEADLESS_ARGS or GSM_HEADLESS_PROFILE=standalone.',
  };
}

function autoSaveStatus(config: HeadlessLaunchConfig, defaultSaveDir: string): LauncherAutoSaveStatus {
  const available = config.autoSaveAvailable === true;
  return {
    available,
    enabledByDefault: available && config.autoSaveEnabled === true,
    mode: config.autoSaveMode ?? (available ? 'attrrecord-log' : 'off'),
    defaultSaveDir,
    reason: available
      ? undefined
      : config.autoSaveMode === 'configured-args'
        ? 'Autosave needs the standalone or ue headless profile so the agent can assign per-run logs.'
        : 'Autosave is unavailable until a headless launch profile is configured.',
  };
}

function findWorkspaceRoot(): string {
  let current = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (
      existsSync(path.join(current, 'package.json')) &&
      existsSync(path.join(current, 'packages'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function loadLocalEnv(root: string): void {
  const candidates = [
    path.resolve(root, '.env.local'),
    path.resolve(process.cwd(), '.env.local'),
  ];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] != null) continue;
      process.env[key] = unquoteEnvValue(trimmed.slice(eq + 1).trim());
    }
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function numFlag(flag: string, def: number): number {
  const raw = stringFlag(flag);
  const n = raw == null ? Number.NaN : Number(raw);
  if (Number.isFinite(n)) return n;
  return def;
}

function numEnv(key: string, def: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : def;
}

function boolEnv(key: string, def: boolean): boolean {
  return parseBool(process.env[key], def);
}

function boolFlag(flag: string, def: boolean): boolean {
  const i = argv.indexOf(flag);
  if (i < 0) return def;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) return true;
  return parseBool(next, def);
}

function parseBool(value: string | undefined, def: boolean): boolean {
  if (value == null || value.trim() === '') return def;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return def;
}

function stringFlag(flag: string, def?: string): string | undefined {
  const prefix = `${flag}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return def;
}

function optionalStringFlag(flag: string, def?: string): string | undefined {
  const value = stringFlag(flag, def)?.trim();
  return value ? value : undefined;
}

function renderFlag(): 'nullrhi' | 'offscreen' | 'windowed' {
  const value = stringFlag('--headless-render', process.env.GSM_HEADLESS_RENDER ?? 'nullrhi')
    ?.trim()
    .toLowerCase();
  if (value === 'offscreen' || value === 'windowed') return value;
  return 'nullrhi';
}

const processes = new Map<string, DiscoveredProcess>();
const localLaunchProcesses = new Map<
  string,
  { launch: HeadlessLaunch; process?: DiscoveredProcess; loggedPending?: boolean }
>();
const keyOf = (matchId: string, ip: string) => `${matchId}@${ip}`;

// --- UDP beacon listener (mirrors the game's LAN beacon semantics) ------------
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udp.on('message', (buf, rinfo) => {
  if (buf.length < 4 || buf.readUInt32LE(0) !== DISCOVERY_MAGIC) return;
  let payload: BeaconPayload;
  try {
    payload = JSON.parse(buf.subarray(4).toString('utf8'));
  } catch {
    return;
  }
  if (typeof payload?.matchId !== 'string' || typeof payload?.wsPort !== 'number') return;

  const ip = rinfo.address;
  const k = keyOf(payload.matchId, ip);
  const previous = processes.get(k);
  const localLaunch = localLaunchForBeacon(payload);
  const nextProcess: DiscoveredProcess = {
    ...payload,
    sourceIp: ip,
    lastSeen: Date.now(),
    wsUrl: `ws://${ip}:${payload.wsPort}`,
    ...(localLaunch
      ? { localLaunchId: localLaunch.id, localLaunchPid: localLaunch.pid }
      : {}),
  };
  processes.set(k, nextProcess);
  if (!previous) {
    log(`+ ${payload.name ?? payload.matchId}  ws://${ip}:${payload.wsPort}`);
    broadcastList();
  } else if (previous.localLaunchId !== nextProcess.localLaunchId || previous.localLaunchPid !== nextProcess.localLaunchPid) {
    broadcastList();
  }
});

udp.on('error', (err) => console.error('[agent] udp error:', err.message));
udp.bind(DISCOVERY_PORT, () => {
  try {
    udp.setBroadcast(true);
  } catch {
    /* ignore */
  }
  log(`listening for LAN beacons on udp/${DISCOVERY_PORT}`);
});

// --- expiry sweep -------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [k, p] of processes) {
    if (isLocalLaunchProcessKey(k)) continue;
    if (now - p.lastSeen > ROOM_EXPIRY_MS) {
      processes.delete(k);
      changed = true;
      log(`- ${p.name ?? p.matchId} (expired)`);
    }
  }
  if (changed) broadcastList();
}, 1000);

// --- browser-facing HTTP + WS -------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (!setCorsHeaders(req, res)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('origin not allowed');
    return;
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/processes') {
    writeJson(res, 200, listMessage());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/launcher') {
    writeJson(res, 200, launcherMessage());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/launch') {
    try {
      const request = await readJsonBody<LaunchHeadlessRequest>(req);
      const response = launcher.launch(request);
      registerLocalLaunches(response.launched);
      writeJson(res, response.ok ? 200 : 409, response);
    } catch (err) {
      writeJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: launcher.status(),
        launched: [],
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/launch/stop') {
    try {
      const request = await readJsonBody<StopHeadlessRequest>(req);
      const response = launcher.stop(request);
      if (response.stopped) removeLocalLaunchProcess(response.stopped);
      refreshLocalLaunches();
      writeJson(res, response.ok ? 200 : 404, response);
    } catch (err) {
      writeJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: launcher.status(),
      });
    }
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('gsm-agent ok');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    ws.close();
    return;
  }
  sendJson(ws, listMessage());
  sendJson(ws, launcherMessage());
});
server.listen(browserPort, 'localhost', () => log(`serving process list on ws://localhost:${browserPort}`));
const launcherBroadcastTimer = setInterval(() => broadcastLauncherStatus(), 2000);
launcherBroadcastTimer.unref?.();
const localLaunchHeartbeat = setInterval(() => refreshLocalLaunches(), BROADCAST_INTERVAL_MS);
localLaunchHeartbeat.unref?.();

function listMessage(): AgentProcessListMessage {
  const list = [...processes.values()].sort((a, b) => a.matchId.localeCompare(b.matchId));
  return { kind: 'processes', processes: list };
}
function launcherMessage(): AgentLauncherStatusMessage {
  return { kind: 'launcherStatus', status: launcher.status() };
}
function broadcastList() {
  broadcastJson(listMessage());
}
function broadcastLauncherStatus() {
  broadcastJson(launcherMessage());
}

function registerLocalLaunches(launches: HeadlessLaunch[]) {
  if (launches.length === 0) return;
  if (launches.length > 1) {
    log('local standalone ws fallback maps only the first launch until the LAN beacon provides per-match ports');
  }

  const launch = launches[0];
  const entry = { launch };
  localLaunchProcesses.set(launch.id, entry);
  refreshLocalLaunchEntry(launch.id, entry);
}

function refreshLocalLaunches() {
  if (localLaunchProcesses.size === 0) return;
  let changed = false;
  for (const [key, entry] of localLaunchProcesses) {
    if (entry.launch.status !== 'running') {
      changed = removeLocalLaunchProcess(entry.launch) || changed;
      continue;
    }
    changed = refreshLocalLaunchEntry(key, entry) || changed;
  }
  if (changed) broadcastList();
}

function refreshLocalLaunchEntry(
  key: string,
  entry: { launch: HeadlessLaunch; process?: DiscoveredProcess; loggedPending?: boolean },
): boolean {
  const wsPort = localStandaloneWsPort(entry.launch.startedAt, entry.launch.logPath);
  const now = Date.now();
  if (wsPort == null) {
    if (!entry.loggedPending) {
      log(
        `local standalone ${entry.launch.pid} is waiting for GSM_STANDALONE_LOG or --standalone-ws-port to expose a ws port`,
      );
      entry.loggedPending = true;
    }
    return false;
  }

  if (!entry.process) {
    entry.process = {
      matchId: `local-standalone-${entry.launch.id}`,
      name: `Local standalone ${entry.launch.pid}`,
      mapId: numFlag('--mapid', numFlag('--map-id', numEnv('GSM_HEADLESS_MAP_ID', 9))),
      wsPort,
      sourceIp: '127.0.0.1',
      lastSeen: now,
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      localLaunchId: entry.launch.id,
      localLaunchPid: entry.launch.pid,
    };
    processes.set(keyOf(entry.process.matchId, entry.process.sourceIp), entry.process);
    log(`+ ${entry.process.name}  ${entry.process.wsUrl} (local launch fallback)`);
    return true;
  }

  const previousUrl = entry.process.wsUrl;
  entry.process.wsPort = wsPort;
  entry.process.wsUrl = `ws://127.0.0.1:${wsPort}`;
  entry.process.lastSeen = now;
  entry.process.localLaunchId = entry.launch.id;
  entry.process.localLaunchPid = entry.launch.pid;
  processes.set(keyOf(entry.process.matchId, entry.process.sourceIp), entry.process);
  if (entry.process.wsUrl !== previousUrl) {
    log(`~ ${entry.process.name}  ${previousUrl} -> ${entry.process.wsUrl} (local launch fallback)`);
  }
  return true;
}

function isLocalLaunchProcessKey(key: string): boolean {
  for (const entry of localLaunchProcesses.values()) {
    if (!entry.process) continue;
    if (keyOf(entry.process.matchId, entry.process.sourceIp) === key) return true;
  }
  return false;
}

function localLaunchForBeacon(payload: BeaconPayload): HeadlessLaunch | null {
  const pid = pidFromMatchId(payload.matchId);
  for (const entry of localLaunchProcesses.values()) {
    if (entry.launch.status !== 'running') continue;
    if (pid != null && entry.launch.pid === pid) return entry.launch;
    const wsPort = localStandaloneWsPort(entry.launch.startedAt, entry.launch.logPath);
    if (wsPort != null && wsPort === payload.wsPort) return entry.launch;
  }
  return null;
}

function pidFromMatchId(matchId: string): number | undefined {
  const match = matchId.match(/(?:^|[-_])(\d+)$/);
  const pid = Number(match?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function removeLocalLaunchProcess(launch: HeadlessLaunch): boolean {
  let changed = false;
  for (const [key, process] of processes) {
    if (process.localLaunchId !== launch.id && process.localLaunchPid !== launch.pid) continue;
    processes.delete(key);
    changed = true;
  }
  const entry = localLaunchProcesses.get(launch.id);
  if (entry?.process) {
    const key = keyOf(entry.process.matchId, entry.process.sourceIp);
    if (processes.delete(key)) changed = true;
  }
  localLaunchProcesses.delete(launch.id);
  if (changed) broadcastList();
  return changed;
}

function localStandaloneWsPort(startedAt?: number, launchLogPath?: string): number | undefined {
  const logPort = localStandaloneWsPortFromLog(startedAt, launchLogPath);
  if (logPort != null) return logPort;
  const port = numFlag('--standalone-ws-port', numEnv('GSM_STANDALONE_WS_PORT', 0));
  return port > 0 ? port : undefined;
}

function localStandaloneWsPortFromLog(startedAt?: number, launchLogPath?: string): number | undefined {
  const logPath = launchLogPath ?? optionalStringFlag('--standalone-log', process.env.GSM_STANDALONE_LOG);
  if (!logPath) return undefined;
  try {
    const stat = statSync(logPath);
    if (startedAt != null && stat.mtimeMs + 1000 < startedAt) return undefined;
    const bytes = readFileSync(logPath);
    const tail = bytes.subarray(Math.max(0, bytes.length - 256 * 1024)).toString('utf8');
    const matches = [...tail.matchAll(/WebSocket server started on port\s+(\d+)/gi)];
    const port = Number(matches.at(-1)?.[1]);
    return Number.isFinite(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function broadcastJson(value: unknown) {
  const msg = JSON.stringify(value);
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
function sendJson(ws: WebSocket, value: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}
function writeJson(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin)) return false;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  return true;
}
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}
function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}
function log(m: string) {
  console.log(`[agent] ${m}`);
}

if (MOCK) {
  log('--mock: synthesizing fake LAN matches (beacons + feeds) on this host');
  startMock();
}
if (MOCK_SCENARIO) {
  log('--scenario: running realistic Map-9 AI match simulation (4 matches, ~420s)');
  startScenarioMock();
}
const TRACE_PATH = stringFlag('--trace');
const TRACE_DIR = stringFlag('--trace-dir', process.env.GSM_TRACE_DIR);
const TRACE_DIRS = stringFlag('--trace-dirs', process.env.GSM_TRACE_DIRS); // comma-separated: dir1,dir2,dir3
const TRACE_ROOT = stringFlag('--trace-root', process.env.GSM_TRACE_ROOT ?? path.join(workspaceRoot, 'traces'));
const TRACE_AUTO_DISCOVERY = !TRACE_PATH && !TRACE_DIR && !TRACE_DIRS;
const TRACE_LOOP = boolFlag('--trace-loop', boolEnv('GSM_TRACE_LOOP', TRACE_AUTO_DISCOVERY));
if (TRACE_PATH) {
  log(`--trace: replaying recorded trace: ${TRACE_PATH}`);
  const replayer = new TraceReplayer({
    tracePath: TRACE_PATH,
    speed: numFlag('--trace-speed', 1),
    loop: TRACE_LOOP,
  });
  // Register the replayed match directly in the agent's process list
  // (UDP loopback beacon is unreliable on Windows)
  const replayerProcess: DiscoveredProcess = {
    matchId: 'trace-replay',
    name: `Trace Replay — Map 9`,
    mapId: 9,
    wsPort: 9240,
    sourceIp: '127.0.0.1',
    lastSeen: Date.now(),
    wsUrl: 'ws://127.0.0.1:9240',
  };
  processes.set(keyOf(replayerProcess.matchId, replayerProcess.sourceIp), replayerProcess);
  broadcastList();

  // Keep the trace process alive in the list
  const keepAlive = setInterval(() => {
    const k = keyOf(replayerProcess.matchId, replayerProcess.sourceIp);
    const existing = processes.get(k);
    if (existing) {
      existing.lastSeen = Date.now();
      broadcastList();
    }
  }, BROADCAST_INTERVAL_MS);

  replayer.start().catch((err) => {
    console.error('[agent] trace replayer failed:', err);
    process.exit(1);
  });
  // Graceful shutdown
  const shutdown = () => {
    clearInterval(keepAlive);
    const k = keyOf(replayerProcess.matchId, replayerProcess.sourceIp);
    processes.delete(k);
    broadcastList();
    replayer.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// --- trace replay (supports --trace, --trace-dir, --trace-dirs) --------------
function loadTraceDir(dirPath: string, packetLabel: string, portBase: number) {
  const files = readdirSync(dirPath)
    .filter(f => f.includes('.iter-') && f.endsWith('.trace.json'))
    .sort();
  if (files.length === 0) {
    log(`--trace-dir: no iter-*.trace.json files found in ${dirPath}`);
    return { replayers: [] as TraceReplayer[], procs: [] as DiscoveredProcess[] };
  }
  log(`--trace-dir: loading ${files.length} iterations from ${dirPath} (packet=${packetLabel})`);

  const replayers: TraceReplayer[] = [];
  const procs: DiscoveredProcess[] = [];

  for (let i = 0; i < files.length; i++) {
    const tracePath = path.join(dirPath, files[i]);
    const iterMatch = files[i].match(/iter-(\d+)/);
    const iterNum = iterMatch ? parseInt(iterMatch[1], 10) : i + 1;

    let winnerMark = '';
    let mapId = 9;
    try {
      const trace = TraceReplayer.inspect(tracePath);
      mapId = trace.mapId;
      const w = trace.summary?.winner;
      if (w === 'team0') winnerMark = ' (R win)';
      else if (w === 'team1') winnerMark = ' (B win)';
      else if (w === 'team0_hp') winnerMark = ' (R+)';
      else if (w === 'team1_hp') winnerMark = ' (B+)';
    } catch { /* ignore */ }

    const wsPort = portBase + i;
    const matchId = `${packetLabel}-iter-${iterNum}`;
    const replayer = new TraceReplayer({
      tracePath,
      wsPort,
      speed: numFlag('--trace-speed', 1),
      loop: TRACE_LOOP,
    });

    const proc: DiscoveredProcess = {
      matchId,
      name: `Iter ${iterNum}${winnerMark}`,
      mapId,
      wsPort,
      sourceIp: '127.0.0.1',
      lastSeen: Date.now(),
      wsUrl: `ws://127.0.0.1:${wsPort}`,
    };
    processes.set(keyOf(proc.matchId, proc.sourceIp), proc);

    replayer.start().catch(err => console.error(`[agent] ${matchId} failed:`, err));
    replayers.push(replayer);
    procs.push(proc);
  }
  return { replayers, procs };
}

// Build list of {dir, label} from explicit flags, or auto-discover the default
// replay library under ./traces when no trace flags are supplied.
const traceLoads: { dir: string; label: string; port: number }[] = [];
let nextTracePort = 9240;

function appendTraceLoad(dir: string, label = path.basename(dir).replace(/\\/g, '/')): void {
  const resolvedDir = resolveTraceDir(dir);
  const count = traceFileCount(resolvedDir);
  if (count === 0) return;
  traceLoads.push({ dir: resolvedDir, label, port: nextTracePort });
  nextTracePort += count + 1;
}

if (TRACE_DIR) {
  appendTraceLoad(TRACE_DIR);
}
if (TRACE_DIRS) {
  for (const dir of TRACE_DIRS.split(',').map(s => s.trim()).filter(Boolean)) {
    appendTraceLoad(dir);
  }
}
if (TRACE_AUTO_DISCOVERY && TRACE_ROOT) {
  for (const dir of discoverTraceDirs(TRACE_ROOT)) {
    appendTraceLoad(dir);
  }
}

if (traceLoads.length > 0) {
  const allReplayers: TraceReplayer[] = [];
  const allProcs: DiscoveredProcess[] = [];

  for (const tl of traceLoads) {
    const { replayers, procs } = loadTraceDir(tl.dir, tl.label, tl.port);
    allReplayers.push(...replayers);
    allProcs.push(...procs);
  }
  const loadTs = Date.now();
  for (const p of allProcs) p.lastSeen = loadTs;
  broadcastList();

  // One shared heartbeat re-asserts every replay process (self-healing if one
  // briefly expired under load) and broadcasts once per interval. The old design
  // gave each of the N replays its own interval that broadcast the whole list —
  // O(N^2) work that, with 66 matches, drifted past the 5s expiry and dropped
  // matches for good (the per-replay timer only refreshed an *existing* entry, so
  // once expired it never came back).
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const p of allProcs) {
      p.lastSeen = now;
      processes.set(keyOf(p.matchId, p.sourceIp), p);
    }
    broadcastList();
  }, BROADCAST_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(heartbeat);
    for (const r of allReplayers) r.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('beforeExit', shutdown);
}

function traceFileCount(dirPath: string): number {
  try {
    return readdirSync(dirPath).filter(f => f.includes('.iter-') && f.endsWith('.trace.json')).length;
  } catch {
    return 0;
  }
}

function resolveTraceDir(dirPath: string): string {
  if (path.isAbsolute(dirPath)) return dirPath;
  const fromWorkspace = path.resolve(workspaceRoot, dirPath);
  if (existsSync(fromWorkspace)) return fromWorkspace;
  return path.resolve(process.cwd(), dirPath);
}

function discoverTraceDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  if (traceFileCount(root) > 0) dirs.push(root);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      if (traceFileCount(dir) > 0) dirs.push(dir);
    }
  } catch {
    /* ignore unreadable trace roots */
  }
  return dirs.sort((a, b) => a.localeCompare(b));
}
