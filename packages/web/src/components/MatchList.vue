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
  (e: 'replayPaused', key: string, paused: boolean): void;
  (e: 'replaySeek', key: string, positionMs: number): void;
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
const focusedPlayback = computed(() => focused.value?.replayPlayback);

function replayTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function seekFocusedReplay(deltaMs: number): void {
  const match = focused.value;
  const playback = focusedPlayback.value;
  if (!match || !playback) {
    throw new Error('Replay seek requested without a focused recorded replay');
  }
  const target = Math.max(0, Math.min(playback.durationMs - 1, playback.positionMs + deltaMs));
  emit('replaySeek', match.key, target);
}

function toggleFocusedReplay(): void {
  const match = focused.value;
  const playback = focusedPlayback.value;
  if (!match || !playback) {
    throw new Error('Replay pause requested without a focused recorded replay');
  }
  emit('replayPaused', match.key, !playback.paused);
}

// ---- Packet grouping (overview) ----

interface PacketGroup {
  /** First iteration key (used as packet identity). */
  firstKey: string;
  /** Display label, e.g. "multi-5 📦 5 iters". */
  label: string;
  /** All matches in this packet, sorted by iter number. */
  members: MatchView[];
}

function buildPacketGroups(matches: readonly MatchView[]): PacketGroup[] {
  const groups = new Map<string, MatchView[]>();
  const singles: MatchView[] = [];

  for (const m of matches) {
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
}

type StaticMatch = MatchView & { staticReplay: NonNullable<MatchView['staticReplay']> };

interface CatalogMapGroup {
  key: string;
  label: string;
  matches: StaticMatch[];
}

interface CatalogRegionGroup {
  key: string;
  label: string;
  matches: StaticMatch[];
}

const staticMatches = computed<StaticMatch[]>(() =>
  props.matches.filter((match): match is StaticMatch => match.staticReplay !== undefined)
);
const packetGroups = computed<PacketGroup[]>(() =>
  buildPacketGroups(props.matches.filter(match => match.staticReplay === undefined))
);
const mapGroups = computed<CatalogMapGroup[]>(() => {
  const groups = new Map<string, CatalogMapGroup>();
  for (const match of staticMatches.value) {
    const metadata = match.staticReplay;
    const group = groups.get(metadata.mapKey) ?? {
      key: metadata.mapKey,
      label: metadata.mapLabel,
      matches: [],
    };
    group.matches.push(match);
    groups.set(group.key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    matches: [...group.matches].sort(
      (left, right) =>
        left.staticReplay.matchNumber - right.staticReplay.matchNumber ||
        left.staticReplay.roundNumber - right.staticReplay.roundNumber
    ),
  }));
});

const activeMapKey = ref<string | null>(null);
const activeRegionKey = ref<string | null>(null);
const replayPage = ref(1);
const replaySearch = ref('');
const REPLAYS_PER_PAGE = 12;

function normalizeReplaySearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').trim();
}

const normalizedReplaySearch = computed(() => normalizeReplaySearch(replaySearch.value));
const hasReplaySearch = computed(() => normalizedReplaySearch.value.length > 0);

watch(
  mapGroups,
  groups => {
    if (!groups.some(group => group.key === activeMapKey.value)) {
      activeMapKey.value = groups[0]?.key ?? null;
    }
  },
  { immediate: true }
);

const activeMap = computed(() =>
  mapGroups.value.find(group => group.key === activeMapKey.value) ?? null
);
const regionGroups = computed<CatalogRegionGroup[]>(() => {
  const groups = new Map<string, CatalogRegionGroup>();
  for (const match of activeMap.value?.matches ?? []) {
    const metadata = match.staticReplay;
    const group = groups.get(metadata.regionKey) ?? {
      key: metadata.regionKey,
      label: metadata.regionLabel,
      matches: [],
    };
    group.matches.push(match);
    groups.set(group.key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    matches: [...group.matches].sort(
      (left, right) =>
        left.staticReplay.matchNumber - right.staticReplay.matchNumber ||
        left.staticReplay.roundNumber - right.staticReplay.roundNumber
    ),
  }));
});

watch(
  regionGroups,
  groups => {
    if (!groups.some(group => group.key === activeRegionKey.value)) {
      activeRegionKey.value = groups[0]?.key ?? null;
    }
  },
  { immediate: true }
);

const activeRegion = computed(() =>
  regionGroups.value.find(group => group.key === activeRegionKey.value) ?? null
);
const filteredReplays = computed<StaticMatch[]>(() => {
  if (!hasReplaySearch.value) return activeRegion.value?.matches ?? [];
  const terms = normalizedReplaySearch.value.split(/\s+/);
  return (activeMap.value?.matches ?? []).filter(match => {
    const metadata = match.staticReplay;
    const haystack = normalizeReplaySearch([
      match.label,
      metadata.competitionLabel,
      metadata.mapLabel,
      metadata.regionLabel,
      metadata.redSchool,
      metadata.blueSchool,
      formatMatchNumber(metadata.matchNumber),
      `M${metadata.matchNumber}`,
      `G${metadata.roundNumber}`,
      `第${metadata.roundNumber}局`,
    ].join(' '));
    return terms.every(term => haystack.includes(term));
  });
});
const replayPageCount = computed(() =>
  Math.ceil(filteredReplays.value.length / REPLAYS_PER_PAGE)
);
const pagedReplays = computed(() => {
  const start = (replayPage.value - 1) * REPLAYS_PER_PAGE;
  return filteredReplays.value.slice(start, start + REPLAYS_PER_PAGE);
});

watch([activeMapKey, activeRegionKey, replaySearch], () => (replayPage.value = 1));
watch(replayPageCount, count => {
  if (count === 0) {
    replayPage.value = 1;
    return;
  }
  if (count > 0 && replayPage.value > count) replayPage.value = count;
});
function formatMatchNumber(matchNumber: number): string {
  return `M${String(matchNumber).padStart(3, '0')}`;
}

function previousReplayPage(): void {
  if (replayPage.value > 1) replayPage.value -= 1;
}

function nextReplayPage(): void {
  if (replayPage.value < replayPageCount.value) replayPage.value += 1;
}

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
const replaySiblings = computed(() => {
  const match = focused.value;
  const metadata = match?.staticReplay;
  if (!metadata) return [];
  return staticMatches.value
    .filter(candidate => candidate.staticReplay.seriesKey === metadata.seriesKey)
    .sort(
      (left, right) => left.staticReplay.roundNumber - right.staticReplay.roundNumber
    );
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
      <button class="overview-btn" data-testid="replay-exit" @click="emit('overview')">← Matches</button>
      <div class="detail-header">
        <span class="detail-name">{{ focused.label }}</span>
      </div>

      <div class="top-stats">
        <div class="top-stat"><span class="ts-num">{{ vehicleCount ?? '—' }}</span><span class="ts-label">Robots</span></div>
        <div class="top-stat"><span class="ts-num">{{ buildingCount ?? '—' }}</span><span class="ts-label">Bldgs</span></div>
        <div class="top-stat"><span class="ts-num">{{ focused.status }}</span><span class="ts-label">Status</span></div>
      </div>

      <div v-if="focusedPlayback" class="replay-controls" aria-label="Replay controls">
        <button
          type="button"
          data-testid="replay-back"
          title="Back 10 seconds"
          @click="seekFocusedReplay(-10_000)"
        >
          −10s
        </button>
        <button
          type="button"
          class="replay-play-toggle"
          data-testid="replay-play-toggle"
          :aria-label="focusedPlayback.paused ? 'Play replay' : 'Pause replay'"
          @click="toggleFocusedReplay"
        >
          {{ focusedPlayback.paused ? '▶' : 'Ⅱ' }}
        </button>
        <button
          type="button"
          data-testid="replay-forward"
          title="Forward 10 seconds"
          @click="seekFocusedReplay(10_000)"
        >
          +10s
        </button>
        <span class="replay-clock">
          {{ replayTime(focusedPlayback.positionMs) }} / {{ replayTime(focusedPlayback.durationMs) }}
        </span>
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

      <div v-if="replaySiblings.length > 1" class="iter-list">
        <div class="sec-title">局次</div>
        <button
          v-for="sibling in replaySiblings"
          :key="sibling.key"
          class="iter-btn"
          :class="{ active: sibling.key === focusedKey }"
          @click="emit('focus', sibling.key)"
        >
          第 {{ sibling.staticReplay.roundNumber }} 局 · {{ sibling.status }}
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
        {{
          matches.length > 0
            ? 'Local service is starting — showing configured static replays.'
            : 'Local service is starting…'
        }}
      </div>

      <section v-if="mapGroups.length > 0" class="replay-catalog" aria-label="Static replay catalog">
        <nav class="catalog-tabs map-tabs" aria-label="Available maps">
          <button
            v-for="map in mapGroups"
            :key="map.key"
            type="button"
            :class="{ active: map.key === activeMapKey }"
            :aria-current="map.key === activeMapKey ? 'page' : undefined"
            @click="activeMapKey = map.key"
          >
            <span>{{ map.label }}</span>
            <small>{{ map.matches.length }}</small>
          </button>
        </nav>

        <div class="catalog-search">
          <input
            v-model="replaySearch"
            type="search"
            data-testid="replay-search"
            aria-label="搜索回放"
            placeholder="搜索学校 / M001 / G1"
            autocomplete="off"
            spellcheck="false"
          />
          <span
            v-if="hasReplaySearch"
            data-testid="replay-search-count"
            aria-live="polite"
          >
            {{ filteredReplays.length }} 局 · 全赛区
          </span>
        </div>

        <nav v-if="!hasReplaySearch" class="catalog-tabs region-tabs" aria-label="RMUC 2026 regions">
          <button
            v-for="region in regionGroups"
            :key="region.key"
            type="button"
            :class="{ active: region.key === activeRegionKey }"
            :aria-current="region.key === activeRegionKey ? 'page' : undefined"
            @click="activeRegionKey = region.key"
          >
            <span>{{ region.label }}</span>
            <small>{{ region.matches.length }}</small>
          </button>
        </nav>

        <div
          v-if="replayPageCount > 1"
          class="catalog-pagination"
          data-testid="replay-pagination"
          aria-label="Replay pages"
        >
          <button type="button" :disabled="replayPage === 1" @click="previousReplayPage">上一页</button>
          <span>{{ replayPage }} / {{ replayPageCount }}</span>
          <button
            type="button"
            :disabled="replayPage === replayPageCount"
            @click="nextReplayPage"
          >
            下一页
          </button>
        </div>

        <div v-if="filteredReplays.length > 0" class="catalog-replays">
          <button
            v-for="match in pagedReplays"
            :key="match.key"
            type="button"
            class="proc catalog-replay"
            data-testid="catalog-replay"
            :class="{ active: match.key === focusedKey }"
            @click="emit('focus', match.key)"
          >
            <strong class="catalog-match-number">
              {{ formatMatchNumber(match.staticReplay.matchNumber) }} · G{{ match.staticReplay.roundNumber }}
            </strong>
            <span class="proc-text">
              <span class="proc-name catalog-teams">
                {{ match.staticReplay.redSchool }}
                <i aria-hidden="true">vs</i>
                {{ match.staticReplay.blueSchool }}
              </span>
              <span class="proc-sub">
                <template v-if="hasReplaySearch">{{ match.staticReplay.regionLabel }} · </template>
                第 {{ match.staticReplay.roundNumber }} 局 · {{ match.status }}
              </span>
            </span>
          </button>
        </div>
        <div
          v-else-if="hasReplaySearch"
          class="catalog-empty"
          data-testid="replay-search-empty"
          role="status"
        >
          没有匹配的对局
        </div>
      </section>

      <div v-if="packetGroups.length > 0" class="sec-title">Live</div>

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
