// Throwaway telemetry probe: connect to a running Gestalt System game WebSocket,
// fire a few JSON-RPC requests, and log every message (responses + unsolicited
// server pushes) for ~10s, then print a summary of all method/response keys seen.
// Run on a host with the `ws` module available:
//   node gsm-probe.mjs ws://127.0.0.1:8128
import WebSocket from 'ws';

const url = process.argv[2] || 'ws://127.0.0.1:8128';
const DURATION_MS = Number(process.argv[3] || 10000);
const ws = new WebSocket(url);
let id = 1;
const seen = new Map();

function req(method, params = {}) {
  ws.send(JSON.stringify({ type: 0, id: id++, method, params }));
}

ws.on('open', () => {
  console.log('[probe] OPEN', url);
  // Probe a few known method families.
  req('heartbeat.ping');
  req('externalAim.getState');
  req('externalAim.getFrame');
});

ws.on('message', (data) => {
  const s = data.toString();
  let m;
  try {
    m = JSON.parse(s);
  } catch {
    console.log('[non-json]', s.slice(0, 200));
    return;
  }
  const key = m.method ? `push:${m.method}` : `resp#${m.id}`;
  const n = (seen.get(key) || 0) + 1;
  seen.set(key, n);
  if (n <= 2) console.log('[msg]', key, s.length > 700 ? s.slice(0, 700) + ' …(' + s.length + 'B)' : s);
});

ws.on('error', (e) => console.log('[probe] ERROR', e.message));
ws.on('close', () => console.log('[probe] CLOSED'));

setTimeout(() => {
  console.log('[probe] SUMMARY (key -> count):');
  for (const [k, v] of [...seen.entries()].sort()) console.log('   ', k, v);
  try { ws.close(); } catch {}
  process.exit(0);
}, DURATION_MS);
