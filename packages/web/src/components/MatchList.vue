<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WorldSnapshot, VehicleState } from '@gsm/protocol';
import type { MatchView } from '@/feed/types';

const props = defineProps<{
  matches: MatchView[];
  focusedKey: string | null;
  agentConnected: boolean;
  snapshotMap: Record<string, WorldSnapshot | undefined>;
}>();
const emit = defineEmits<{
  (e: 'focus', key: string): void;
  (e: 'overview'): void;
}>();


// Track per-vehicle K/D across match (reset on loop)
const deathCounts = ref<Record<number, number>>({});
const killCounts = ref<Record<number, number>>({});
const prevDefeated = ref<Record<number, boolean>>({});
let prevT = -1;

function resetCounts() {
  deathCounts.value = {};
  killCounts.value = {};
  prevDefeated.value = {};
  prevT = -1;
}

const focused = computed(() =>
  props.focusedKey ? props.matches.find(m => m.key === props.focusedKey) ?? null : null
);

// ---- Packet grouping (overview) ----

interface PacketGroup {
  /** First iteration key (used as packet identity). */
  firstKey: string;
  /** Display label, e.g. "multi-5 📦 5 iters". */
  label: string;
  /** All matches in this packet, sorted by iter number. */
  members: MatchView[];
}

const packetGroups = computed<PacketGroup[]>(() => {
  const groups = new Map<string, MatchView[]>();
  const singles: MatchView[] = [];

  for (const m of props.matches) {
    if (m.key.includes('iter-')) {
      const prefix = m.key.replace(/iter-\d+.*$/, 'iter');
      let arr = groups.get(prefix);
      if (!arr) { arr = []; groups.set(prefix, arr); }
      arr.push(m);
    } else {
      singles.push(m);
    }
  }

  const result: PacketGroup[] = [];

  // Singles first
  for (const m of singles) {
    result.push({ firstKey: m.key, label: m.label, members: [m] });
  }

  // Packets
  for (const [, members] of groups) {
    members.sort((a, b) => {
      const na = parseInt(a.key.match(/iter-(\d+)/)?.[1] ?? '0', 10);
      const nb = parseInt(b.key.match(/iter-(\d+)/)?.[1] ?? '0', 10);
      return na - nb;
    });
    const n = members.length;
    // Use first member's label but strip "Iter N" and winner suffix
    const example = members[0].label
      .replace(/Iter\s*\d+/i, '')
      .replace(/\s*\([RB][^)]*\)\s*/g, '')
      .trim();
    result.push({
      firstKey: members[0].key,
      label: `${example || 'Replay'}  📦 ${n}`,
      members,
    });
  }

  return result;
});

// Iteration siblings: all matches in the same packet as the focused one
const iterSiblings = computed(() => {
  if (!focused.value) return [];
  const fk = focused.value.key;
  if (!fk.includes('iter-')) return [];
  const prefix = fk.replace(/iter-\d+.*$/, 'iter');
  return props.matches
    .filter(m => m.key.startsWith(prefix))
    .sort((a, b) => {
      const na = parseInt(a.key.match(/iter-(\d+)/)?.[1] ?? '0', 10);
      const nb = parseInt(b.key.match(/iter-(\d+)/)?.[1] ?? '0', 10);
      return na - nb;
    });
});
const focusedSnap = computed(() =>
  props.focusedKey ? props.snapshotMap[props.focusedKey] : undefined
);

// React to match changes: reset all accumulators
watch(() => props.focusedKey, resetCounts);
watch(focusedSnap, (s) => {
  if (!s) return;
  // Detect trace loop: t drops → reset counters
  if (prevT >= 0 && s.t < prevT) resetCounts();
  prevT = s.t;
  // Group vehicles by team
  const reds = s.vehicles.filter(v => v.kind === 'robot' && (v.team === 'red' || v.team === 0));
  const blues = s.vehicles.filter(v => v.kind === 'robot' && (v.team === 'blue' || v.team === 1));

  // Track deaths + kill participation
  const nowDefeated: Record<number, boolean> = {};
  for (const v of [...reds, ...blues]) {
    nowDefeated[v.id] = v.defeated === true;
    // Death: was alive → now defeated
    if (v.defeated && !prevDefeated.value[v.id]) {
      deathCounts.value[v.id] = (deathCounts.value[v.id] ?? 0) + 1;
      // Kill participation: credit all alive enemies
      const enemies = (v.team === 'red' || v.team === 0) ? blues : reds;
      for (const enemy of enemies) {
        if (!enemy.defeated) {
          killCounts.value[enemy.id] = (killCounts.value[enemy.id] ?? 0) + 1;
        }
      }
    }
  }
  prevDefeated.value = nowDefeated;
});

function vehiclesByTeam(): { red: VehicleState[]; blue: VehicleState[] } {
  const s = focusedSnap.value;
  if (!s) return { red: [], blue: [] };
  const robots = s.vehicles.filter(v => v.kind === 'robot');
  return {
    red: robots.filter(v => v.team === 'red' || v.team === 0).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    blue: robots.filter(v => v.team === 'blue' || v.team === 1).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
  };
}

const vehicleCount = computed(() => { const s = focusedSnap.value; return s ? s.vehicles.filter(v => v.kind === 'robot').length : null; });
const buildingCount = computed(() => { const s = focusedSnap.value; return s ? s.vehicles.filter(v => v.kind !== 'robot').length : null; });

function dispScore(v: VehicleState) {
  return (v.score ?? 0).toLocaleString();
}
function kdString(v: VehicleState) {
  const k = killCounts.value[v.id] ?? 0;
  const d = deathCounts.value[v.id] ?? 0;
  return `${k}/${d}`;
}
function isMvp(vehicles: VehicleState[], v: VehicleState) {
  const top = vehicles[0];
  return top && top.id === v.id && (v.score ?? 0) > 0;
}
function teamTotal(vehicles: VehicleState[]) {
  return vehicles.reduce((s, v) => s + (v.score ?? 0), 0).toLocaleString();
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">Gestalt<span>·</span>System Monitor</div>

    <template v-if="focused">
      <button class="overview-btn" @click="emit('overview')">← Matches</button>
      <div class="detail-header">
        <span class="detail-name">{{ focused.label }}</span>
      </div>

      <div class="top-stats">
        <div class="top-stat"><span class="ts-num">{{ vehicleCount ?? '—' }}</span><span class="ts-label">Robots</span></div>
        <div class="top-stat"><span class="ts-num">{{ buildingCount ?? '—' }}</span><span class="ts-label">Bldgs</span></div>
        <div class="top-stat"><span class="ts-num">{{ focused.status }}</span><span class="ts-label">Status</span></div>
      </div>

      <!-- Iteration list (when focused match is part of a packet) -->
      <div v-if="iterSiblings.length > 1" class="iter-list">
        <div class="sec-title">Iterations</div>
        <button
          v-for="sib in iterSiblings"
          :key="sib.key"
          class="iter-btn"
          :class="{ active: sib.key === focusedKey }"
          @click="emit('focus', sib.key)"
        >
          {{ sib.label }}
        </button>
      </div>

      <div v-if="focusedSnap" class="teams">
        <div class="team-panel red">
          <div class="team-head">🔴 Red</div>
          <div class="stat-table">
            <div class="st-hdr"><span>Unit</span><span>K/D</span><span>Dmg</span></div>
            <div v-for="v in vehiclesByTeam().red" :key="v.id" class="st-row">
              <span class="st-name">{{ isMvp(vehiclesByTeam().red, v) ? '⭐' : '' }}{{ v.name ?? '?' }}</span>
              <span class="st-kd">{{ kdString(v) }}</span>
              <span class="st-dmg">{{ dispScore(v) }}</span>
            </div>
          </div>
          <div class="team-sum">{{ teamTotal(vehiclesByTeam().red) }} dmg</div>
        </div>
        <div class="team-panel blue">
          <div class="team-head">🔵 Blue</div>
          <div class="stat-table">
            <div class="st-hdr"><span>Unit</span><span>K/D</span><span>Dmg</span></div>
            <div v-for="v in vehiclesByTeam().blue" :key="v.id" class="st-row">
              <span class="st-name">{{ isMvp(vehiclesByTeam().blue, v) ? '⭐' : '' }}{{ v.name ?? '?' }}</span>
              <span class="st-kd">{{ kdString(v) }}</span>
              <span class="st-dmg">{{ dispScore(v) }}</span>
            </div>
          </div>
          <div class="team-sum">{{ teamTotal(vehiclesByTeam().blue) }} dmg</div>
        </div>
      </div>
      <div v-else class="hint">Waiting for telemetry…</div>
    </template>

    <template v-else>
      <div class="sec-title">Matches
        <span
          class="dot"
          :class="{ on: agentConnected }"
          :title="agentConnected ? 'local service ready' : 'local service starting'"
        />
      </div>
      <div v-if="!agentConnected" class="hint">
        Local service is starting — showing built-in mock only.
      </div>

      <template v-for="grp in packetGroups" :key="grp.firstKey">
        <!-- Single match (not a packet) -->
        <button
          v-if="grp.members.length === 1"
          class="proc"
          :class="{ active: grp.firstKey === focusedKey }"
          @click="emit('focus', grp.firstKey)"
        >
          <span class="proc-text">
            <span class="proc-name">{{ grp.members[0].label }}</span>
            <span class="proc-sub">{{ grp.members[0].playerCount != null ? grp.members[0].playerCount + 'p · ' : '' }}{{ grp.members[0].status }}</span>
          </span>
        </button>

        <!-- Packet (grouped iterations) — click to focus first iteration -->
        <button v-else class="proc" :class="{ active: grp.firstKey === focusedKey }" @click="emit('focus', grp.firstKey)">
          <span class="proc-text">
            <span class="proc-name">{{ grp.label }}</span>
            <span class="proc-sub">{{ grp.members.length }} iterations</span>
          </span>
        </button>
      </template>
    </template>
  </aside>
</template>
