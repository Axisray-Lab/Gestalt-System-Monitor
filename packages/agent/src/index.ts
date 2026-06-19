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
import { WebSocketServer, WebSocket } from 'ws';
import {
  DISCOVERY_PORT,
  DISCOVERY_MAGIC,
  ROOM_EXPIRY_MS,
  AGENT_BROWSER_PORT,
  type BeaconPayload,
  type DiscoveredProcess,
  type AgentProcessListMessage,
  type AgentLauncherStatusMessage,
  type LaunchHeadlessRequest,
} from '@gsm/protocol';
import { LaunchManager } from './launcher';
import { startMock } from './mock';
import { startScenarioMock } from './mock';

const argv = process.argv.slice(2);
const MOCK = argv.includes('--mock');
const MOCK_SCENARIO = argv.includes('--scenario');
const browserPort = numFlag('--port', AGENT_BROWSER_PORT);
const launcher = new LaunchManager(
  {
    gameName: stringFlag('--game-name', process.env.GSM_GAME_NAME ?? 'Gestalt System') ?? 'Gestalt System',
    steamAppId: stringFlag('--steam-app-id', process.env.GSM_STEAM_APP_ID),
    manualInstallDir: stringFlag('--game-dir', process.env.GSM_GAME_DIR),
    executablePath: stringFlag('--game-exe', process.env.GSM_GAME_EXE),
    executableName: stringFlag('--game-exe-name', process.env.GSM_GAME_EXE_NAME),
    headlessArgs: splitArgs(stringFlag('--headless-args', process.env.GSM_HEADLESS_ARGS ?? '--headless')),
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

function stringFlag(flag: string, def?: string): string | undefined {
  const prefix = `${flag}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return def;
}

function splitArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) args.push(match[1] ?? match[2] ?? match[3]);
  return args;
}

const processes = new Map<string, DiscoveredProcess>();
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
  const isNew = !processes.has(k);
  processes.set(k, {
    ...payload,
    sourceIp: ip,
    lastSeen: Date.now(),
    wsUrl: `ws://${ip}:${payload.wsPort}`,
  });
  if (isNew) {
    log(`+ ${payload.name ?? payload.matchId}  ws://${ip}:${payload.wsPort}`);
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
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
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
