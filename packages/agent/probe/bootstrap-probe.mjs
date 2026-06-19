// Bootstrap-chain probe: mirror the in-game HUD's attributeWatch flow.
//   global map (registry) --[player_id -> player_map_id]--> player maps
//   player map --[PlayerBattleAttributeMapID=1000001]--> battle map (Health lives here)
// Watch a broad low span, learn the CURRENT battle-map ids from the live chain
// (they get recycled as bots die/respawn, so static ids go stale), then watch those.
//   node bootstrap-probe.mjs ws://127.0.0.1:8128 [durationMs]
import WebSocket from 'ws';

const url = process.argv[2] || 'ws://127.0.0.1:8128';
const DURATION_MS = Number(process.argv[3] || 12000);

const G_BASEID_0 = 80001000;        // global-map attr key whose presence marks the global map
const AI_PID_LO = 80000, AI_PID_HI = 81000; // global-map attr keys in this band are player_id -> player_map_id
const PLAYER_BATTLE_MAP_ATTR = '1000001'; // PlayerBattleAttributeMapID
const HEALTH = '10000003', HMAX = '60000004', TEAM = '10000036', CLASS = '60000002';

const ws = new WebSocket(url);
let reqId = 1;
const maps = new Map();            // id -> attributes
const playerMapIds = new Set();
const battleMapIds = new Set();
const watched = new Set();

function watch(ids) {
  const fresh = ids.filter((i) => !watched.has(i));
  if (!fresh.length) return;
  fresh.forEach((i) => watched.add(i));
  ws.send(JSON.stringify({ type: 0, id: reqId++, method: 'attribute.watchAttributeMaps', params: { attribute_map_ids: fresh, watch_type: 2 } }));
}

ws.on('open', () => {
  console.log('[bootstrap] OPEN', url);
  watch(Array.from({ length: 300 }, (_, i) => i + 1)); // broad low span to find global + player maps
});

ws.on('message', (data) => {
  let m; try { m = JSON.parse(data.toString()); } catch { return; }
  if (m.method !== 'watchAttributeMaps.result') return;
  for (const r of m.params?.watch_attribute_maps_results || []) {
    const a = (maps.get(r.attribute_map_id) || {});
    Object.assign(a, r.attributes || {});
    maps.set(r.attribute_map_id, a);

    // Global map: has the base-id attr key. Its 80000..81000 keys map player_id -> player_map_id.
    if (a[String(G_BASEID_0)] !== undefined) {
      for (const [k, v] of Object.entries(a)) {
        const key = Number(k);
        if (key >= AI_PID_LO && key <= AI_PID_HI && v > 0) { if (!playerMapIds.has(v)) { playerMapIds.add(v); watch([v]); } }
      }
    }
    // Player map: carries PlayerBattleAttributeMapID -> battle map id.
    if (a[PLAYER_BATTLE_MAP_ATTR] !== undefined) {
      const b = a[PLAYER_BATTLE_MAP_ATTR];
      if (b > 0 && !battleMapIds.has(b)) { battleMapIds.add(b); watch([b]); }
    }
  }
});

ws.on('error', (e) => console.log('[bootstrap] ERROR', e.message));

setTimeout(() => {
  console.log(`[bootstrap] global maps: ${[...maps].filter(([, a]) => a[String(G_BASEID_0)] !== undefined).map(([id]) => id).join(',') || '(none)'}`);
  console.log(`[bootstrap] player map ids: ${[...playerMapIds].sort((x, y) => x - y).join(',') || '(none)'}`);
  console.log(`[bootstrap] battle map ids (current): ${[...battleMapIds].sort((x, y) => x - y).join(',') || '(none)'}`);
  console.log('[bootstrap] ROBOTS (battle maps with Health):');
  for (const b of [...battleMapIds].sort((x, y) => x - y)) {
    const a = maps.get(b) || {};
    const pos = `(${a['10000107']},${a['10000108']},${a['10000109']})`;
    console.log(`   battleMap=${b} hp=${a[HEALTH]}/${a[HMAX]} team=${a[TEAM]} class=${a[CLASS]} pos=${pos} chassisYaw=${a['10000110']} turretYaw=${a['10000111']}`);
  }
  // HUD-field presence on a real battle map: teamNumber 10000037 / level 60000003 /
  // ammo 10000033 / overheated 50000003 / heat 10000011 / heatMax 60000011.
  const robot = [...battleMapIds].map((b) => maps.get(b) || {}).find((a) => a[HEALTH] > 0 && a[CLASS] >= 1001 && a[CLASS] <= 1006);
  if (robot) {
    console.log('[bootstrap] sample robot battle-map HUD fields:',
      `teamNumber(10000037)=${robot['10000037']} level(60000003)=${robot['60000003']}`,
      `ammo(10000033)=${robot['10000033']} overheated(50000003)=${robot['50000003']}`,
      `heat(10000011)=${robot['10000011']}/${robot['60000011']}`);
    console.log('[bootstrap] all attr ids on that map:', Object.keys(robot).sort((x, y) => x - y).join(','));
  }
  try { ws.close(); } catch {}
  process.exit(0);
}, DURATION_MS);
