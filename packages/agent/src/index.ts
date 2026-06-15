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
} from '@gsm/protocol';
import { startMock } from './mock';

const argv = process.argv.slice(2);
const MOCK = argv.includes('--mock');
const browserPort = numFlag('--port', AGENT_BROWSER_PORT);

function numFlag(flag: string, def: number): number {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) {
    const n = Number(argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return def;
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
const server = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url === '/processes') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(listMessage()));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('gsm-agent ok');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => ws.send(JSON.stringify(listMessage())));
server.listen(browserPort, () => log(`serving process list on ws://localhost:${browserPort}`));

function listMessage(): AgentProcessListMessage {
  const list = [...processes.values()].sort((a, b) => a.matchId.localeCompare(b.matchId));
  return { kind: 'processes', processes: list };
}
function broadcastList() {
  const msg = JSON.stringify(listMessage());
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
function log(m: string) {
  console.log(`[agent] ${m}`);
}

if (MOCK) {
  log('--mock: synthesizing fake LAN matches (beacons + feeds) on this host');
  startMock();
}
