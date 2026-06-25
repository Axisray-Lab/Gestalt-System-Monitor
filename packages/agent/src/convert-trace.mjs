#!/usr/bin/env node
/**
 * Convert UE [ATTR-RECORD] log lines → WatchAttributeMapsResult trace.
 *
 * Output flows through attributeStore.toSnapshot() — zero rendering logic
 * duplicated. Building display, repair count, team colours, layout fallback,
 * buff icons etc. are all handled by the existing attributeStore pipeline.
 *
 * Usage: node convert-trace.mjs <ue-log> [--out <trace.json>]
 */

import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline';

const SKIP_BELOW = 2;   // skip system maps

// Building attribute map IDs referenced by the global map's G_BaseId / G_OutpostId.
// Collected from the first frame so we don't filter them out.
let buildingMapIds = new Set();

function collectBuildingIds(updates) {
  for (const u of updates) {
    if (u.attribute_map_id !== 1) continue;
    const a = u.attributes;
    // G_BaseId_0/1, G_OutpostId_0/1
    for (let t = 0; t < 2; t++) {
      const bid = Number(a[String(80001000 + t)]);
      const oid = Number(a[String(80002000 + t)]);
      if (bid > 0) buildingMapIds.add(bid);
      if (oid > 0) buildingMapIds.add(oid);
    }
  }
}

function attrsToRecord(flat) {
  const r = {};
  for (let i = 0; i < flat.length; i += 2) r[String(flat[i])] = flat[i + 1];
  return r;
}

function parseLine(line) {
  const i = line.indexOf('[ATTR-RECORD]');
  if (i < 0) return null;
  const j = line.indexOf('{', i);
  if (j < 0) return null;
  try { return JSON.parse(line.substring(j)); } catch { return null; }
}

async function main() {
  const args = process.argv.slice(2);
  const lp = args.find(a => !a.startsWith('--') && a.endsWith('.log'));
  const oi = args.indexOf('--out');
  const op = oi >= 0 ? args[oi + 1] : lp?.replace(/\.log$/, '.trace.json');
  if (!lp) { console.error('usage: node convert-trace.mjs <ue-log> [--out <out>]'); process.exit(1); }

  console.error(`[convert] ${lp} → ${op}`);
  const rl = readline.createInterface({ input: createReadStream(lp), crlfDelay: Infinity });

  const frames = [];
  let n = 0, fr = null, lr = null, fg = null, lg = null, mid = null;

  for await (const line of rl) {
    const s = parseLine(line);
    if (!s) continue;
    if (fr === null) { fr = s.rt; fg = s.gt; mid = s.map; }
    lr = s.rt; lg = s.gt;

    const updates = [];
    for (const [mapId, flat] of (s.maps ?? [])) {
      // Keep global map (1) + building maps + entity maps (>= 91)
      if (mapId >= SKIP_BELOW && mapId <= 90 && !buildingMapIds.has(mapId)) continue;
      updates.push({
        sync_type: 0,
        attribute_map_id: mapId,
        attributes: attrsToRecord(flat),
      });
    }
    // Collect building IDs from first frame
    if (n === 0) collectBuildingIds(updates);
    frames.push({ result: { cycle_event_type: s.st, watch_attribute_maps_results: updates } });
    if (++n % 500 === 0) console.error(`[convert] ${n} frames`);
  }

  const trace = {
    v: 2, src: 'attr-record', fmt: 'watchAttributeMapsResult',
    mapId: mid ?? 9, frames: frames.length, durMs: lr ?? 0, gtMs: lg ?? 0, frames,
  };

  await writeFile(op, JSON.stringify(trace));
  console.error(`[convert] ${op}  (${(Buffer.byteLength(JSON.stringify(trace))/1e6).toFixed(1)} MB, ${n} frames)`);
}

main().catch(e => { console.error(e); process.exit(1); });
