// Throwaway diagnostic: listen on the LAN-discovery channel (udp/7999, magic
// "ECHO") and print every beacon's source IP + matchId + wsPort. Groups by source
// IP so you can see, per host, how many DISTINCT matchIds are actually on the wire.
//
// This is exactly what the discovery agent keys on (`${matchId}@${ip}`), so if a
// host shows 5 processes but only 1 distinct matchId here, that is the collapse:
// the agent's Map de-dups them to one. If you see 5 distinct matchIds, the problem
// is downstream (agent not running / browser not pointed at the agent).
//
// Run on the SAME machine that runs the monitor's discovery agent:
//   node beacon-sniff.mjs            # listen forever, default 15s summary cadence
//   node beacon-sniff.mjs 30         # summarize every 30s
import dgram from 'node:dgram';

const DISCOVERY_PORT = 7999;
const DISCOVERY_MAGIC = 0x4543484f; // "ECHO", little-endian
const SUMMARY_SEC = Number(process.argv[2] || 15);

// ip -> Map<matchId, { wsPort, name, count, lastSeen }>
const byIp = new Map();

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sock.on('message', (buf, rinfo) => {
  if (buf.length < 4 || buf.readUInt32LE(0) !== DISCOVERY_MAGIC) return;
  let p;
  try {
    p = JSON.parse(buf.subarray(4).toString('utf8').replace(/\0+$/, ''));
  } catch {
    console.log(`[raw] ${rinfo.address} non-JSON payload (${buf.length}B)`);
    return;
  }
  const ip = rinfo.address;
  const matchId = String(p.matchId ?? '(no matchId field!)');
  if (!byIp.has(ip)) byIp.set(ip, new Map());
  const m = byIp.get(ip);
  const prev = m.get(matchId);
  m.set(matchId, {
    wsPort: p.wsPort ?? '(no wsPort!)',
    name: p.name ?? '',
    count: (prev?.count ?? 0) + 1,
    lastSeen: Date.now(),
  });
  if (!prev) {
    console.log(
      `[new] ${ip}  matchId=${matchId}  wsPort=${p.wsPort ?? '?'}  name="${p.name ?? ''}"`
    );
  }
});

sock.on('error', (e) => console.error('[sniff] error:', e.message));
sock.bind(DISCOVERY_PORT, () => {
  try {
    sock.setBroadcast(true);
  } catch {
    /* ignore */
  }
  console.log(`[sniff] listening for LAN beacons on udp/${DISCOVERY_PORT} …`);
  console.log('[sniff] (if nothing appears, no beacons are reaching this box at all)\n');
});

setInterval(() => {
  console.log(`\n===== summary @ ${new Date().toISOString()} =====`);
  if (byIp.size === 0) {
    console.log('  (no beacons seen yet)');
  }
  for (const [ip, m] of byIp) {
    console.log(`  ${ip}: ${m.size} distinct matchId(s)`);
    for (const [matchId, info] of m) {
      console.log(`     - ${matchId}  ws:${info.wsPort}  "${info.name}"  x${info.count}`);
    }
  }
  console.log('===============================================\n');
}, SUMMARY_SEC * 1000);
