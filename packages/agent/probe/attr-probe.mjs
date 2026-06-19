// Attribute-wire probe: subscribe to `attribute.watchAttributeMaps` exactly the way
// the monitor's wsFeed does, and report which attribute_map_ids + attribute ids the
// running game actually streams back. Validates the parse chain against a real match.
//   node attr-probe.mjs ws://127.0.0.1:8128 [durationMs] [idLo] [idHi]
import WebSocket from 'ws';

const url = process.argv[2] || 'ws://127.0.0.1:8128';
const DURATION_MS = Number(process.argv[3] || 12000);
const idLo = Number(process.argv[4] || 80000);
const idHi = Number(process.argv[5] || 80063);

const ws = new WebSocket(url);
let reqId = 1;
const mapIds = new Map(); // attribute_map_id -> frame count
const attrIds = new Set(); // attribute id seen
let resultFrames = 0;

ws.on('open', () => {
  console.log('[attr-probe] OPEN', url, `watching maps ${idLo}..${idHi}`);
  const attribute_map_ids = [];
  for (let i = idLo; i <= idHi; i++) attribute_map_ids.push(i);
  ws.send(JSON.stringify({ type: 0, id: reqId++, method: 'attribute.watchAttributeMaps', params: { attribute_map_ids, watch_type: 2 } }));
});

ws.on('message', (data) => {
  let m;
  try { m = JSON.parse(data.toString()); } catch { return; }
  if (m.method !== 'watchAttributeMaps.result') return;
  resultFrames++;
  const arr = m.params?.watch_attribute_maps_results || [];
  for (const r of arr) {
    mapIds.set(r.attribute_map_id, (mapIds.get(r.attribute_map_id) || 0) + 1);
    const a = r.attributes || {};
    for (const k of Object.keys(a)) attrIds.add(Number(k));
    // Any entity carrying Health / Class / PlayerID — print full identity once.
    if ((a['10000003'] !== undefined || a['60000002'] !== undefined || a['10000035'] !== undefined) && mapIds.get(r.attribute_map_id) === 1) {
      const pos = a['10000107'] !== undefined ? `(${Math.round(a['10000107'])},${Math.round(a['10000108'])},${Math.round(a['10000109'])})` : 'NONE';
      console.log(`[ent] map=${r.attribute_map_id} class=${a['60000002']} team=${a['10000036']} tnum=${a['10000037']} pid=${a['10000035']} hp=${a['10000003']}/${a['60000004']} pos=${pos}`);
    }
  }
});

ws.on('error', (e) => console.log('[attr-probe] ERROR', e.message));
ws.on('close', () => console.log('[attr-probe] CLOSED'));

setTimeout(() => {
  console.log(`[attr-probe] SUMMARY: ${resultFrames} result frames`);
  console.log('  attribute_map_ids streamed:', [...mapIds.keys()].sort((a, b) => a - b).join(', ') || '(none)');
  console.log('  attribute ids seen:', [...attrIds].sort((a, b) => a - b).join(', ') || '(none)');
  try { ws.close(); } catch {}
  process.exit(0);
}, DURATION_MS);
