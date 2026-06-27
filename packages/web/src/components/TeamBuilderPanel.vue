<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  CareerId,
  CONSTRUCT_DEFAULTS,
  RULESETS,
  RosterAttrId,
  RuleSet,
  buildRosterSpec,
  computeSlotCost,
  computeTeamCost,
  constructsForCareer,
  createDefaultMatch,
  type HeadlessMatchConfig,
  type LauncherStatus,
  type RosterSlotConfig,
  type TeamConfig,
} from '@gsm/protocol';

const props = defineProps<{
  agentConnected: boolean;
  launcherStatus: LauncherStatus | null;
  launcherBusy: boolean;
  launcherError: string | null;
}>();
const emit = defineEmits<{
  (e: 'launchMatch', match: HeadlessMatchConfig): void;
}>();

const ruleSet = ref<RuleSet>(RuleSet.RMUC2026);
const selectedTeamId = ref(0);
const match = reactive<HeadlessMatchConfig>(createDefaultMatch(ruleSet.value));

const ruleSetOptions = computed(() => Object.values(RULESETS));
const selectedTeam = computed(() => match.teams.find((team) => team.teamId === selectedTeamId.value) ?? match.teams[0]);
const rosterSpec = computed(() => buildRosterSpec(match));
const totalCost = computed(() => match.teams.reduce((sum, team) => sum + computeTeamCost(team), 0));
const launchReason = computed(() => {
  if (!props.agentConnected) return 'Agent offline';
  if (props.launcherError) return props.launcherError;
  if (props.launcherStatus?.reason) return props.launcherStatus.reason;
  return 'Ready';
});
const launchDisabled = computed(() =>
  props.launcherBusy ||
  !props.agentConnected ||
  props.launcherStatus?.ready === false ||
  rosterSpec.value.length === 0,
);

function selectRuleSet(next: RuleSet): void {
  ruleSet.value = next;
  const fresh = createDefaultMatch(next);
  match.mapId = fresh.mapId;
  match.nettype = fresh.nettype;
  match.aiFill = fresh.aiFill;
  match.attrrecord = fresh.attrrecord;
  match.attrrecordHz = fresh.attrrecordHz;
  match.hudHidden = fresh.hudHidden;
  match.teams = fresh.teams;
  selectedTeamId.value = 0;
}

function teamLabel(team: TeamConfig): string {
  return team.teamId === 0 ? 'Red' : 'Blue';
}

function careerLabel(careerId: number): string {
  switch (careerId) {
    case CareerId.Hero:
      return 'Hero';
    case CareerId.Engineer:
      return 'Engineer';
    case CareerId.Infantry:
      return 'Infantry';
    case CareerId.Sentry:
      return 'Sentry';
    case CareerId.Aerial:
      return 'Aerial';
    case CareerId.Radar:
      return 'Radar';
    case CareerId.Dart:
      return 'Dart';
    default:
      return `Career ${careerId}`;
  }
}

function slotOptions(slot: RosterSlotConfig) {
  return constructsForCareer(slot.careerId);
}

function setEntity(slot: RosterSlotConfig, event: Event): void {
  slot.entityType = Number((event.target as HTMLSelectElement).value);
  delete slot.paramOverrides;
  delete slot.firingIntervalMs;
  delete slot.spread;
  delete slot.dart;
  delete slot.engineer;
  delete slot.radar;
}

function defaultValue(slot: RosterSlotConfig, key: keyof (typeof CONSTRUCT_DEFAULTS)[number]): number {
  const value = CONSTRUCT_DEFAULTS[slot.entityType]?.[key];
  return typeof value === 'number' ? value : 0;
}

function paramValue(slot: RosterSlotConfig, attrId: RosterAttrId, fallback: number): number {
  return slot.paramOverrides?.[attrId] ?? fallback;
}

function setParam(slot: RosterSlotConfig, attrId: RosterAttrId, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  slot.paramOverrides = { ...(slot.paramOverrides ?? {}), [attrId]: value };
}

function ammoControl(slot: RosterSlotConfig):
  | { label: string; attrId: RosterAttrId; fallback: number; max: number }
  | null {
  const defaults = CONSTRUCT_DEFAULTS[slot.entityType];
  if (defaults?.ammo42 != null || slot.paramOverrides?.[RosterAttrId.Real42mmAmmoCount] != null) {
    return { label: '42mm', attrId: RosterAttrId.Real42mmAmmoCount, fallback: defaults?.ammo42 ?? 50, max: 240 };
  }
  if (defaults?.ammo17 != null || slot.paramOverrides?.[RosterAttrId.Real17mmAmmoCount] != null) {
    return { label: '17mm', attrId: RosterAttrId.Real17mmAmmoCount, fallback: defaults?.ammo17 ?? 500, max: 2400 };
  }
  return null;
}

function fireInterval(slot: RosterSlotConfig): number {
  if (slot.firingIntervalMs != null) return slot.firingIntervalMs;
  const fireRateHz = CONSTRUCT_DEFAULTS[slot.entityType]?.fireRateHz;
  return fireRateHz ? Math.round(1000 / fireRateHz) : 0;
}

function setFireInterval(slot: RosterSlotConfig, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value) || value <= 0) return;
  slot.firingIntervalMs = value;
}

function ensureEngineer(slot: RosterSlotConfig): NonNullable<RosterSlotConfig['engineer']> {
  slot.engineer ??= CONSTRUCT_DEFAULTS[slot.entityType]?.engineer ?? { maxAssemblyLevel: 4, corePool: 6 };
  return slot.engineer;
}

function engineerValue(slot: RosterSlotConfig): NonNullable<RosterSlotConfig['engineer']> {
  return slot.engineer ?? CONSTRUCT_DEFAULTS[slot.entityType]?.engineer ?? { maxAssemblyLevel: 4, corePool: 6 };
}

function setEngineerLevel(slot: RosterSlotConfig, event: Event): void {
  ensureEngineer(slot).maxAssemblyLevel = Number((event.target as HTMLSelectElement).value) as 1 | 2 | 3 | 4;
}

function setEngineerPool(slot: RosterSlotConfig, event: Event): void {
  ensureEngineer(slot).corePool = Number((event.target as HTMLSelectElement).value) as 2 | 4 | 6;
}

function ensureDart(slot: RosterSlotConfig): NonNullable<RosterSlotConfig['dart']> {
  slot.dart ??= { canOutpost: false, canBase: false, maxBaseMode: 0 };
  return slot.dart;
}

function dartValue(slot: RosterSlotConfig): NonNullable<RosterSlotConfig['dart']> {
  return slot.dart ?? { canOutpost: false, canBase: false, maxBaseMode: 0 };
}

function setDartTarget(slot: RosterSlotConfig, key: 'canOutpost' | 'canBase', event: Event): void {
  ensureDart(slot)[key] = (event.target as HTMLInputElement).checked;
}

function setDartMode(slot: RosterSlotConfig, event: Event): void {
  ensureDart(slot).maxBaseMode = Number((event.target as HTMLSelectElement).value) as 0 | 1 | 2 | 3;
}

function ensureRadar(slot: RosterSlotConfig): NonNullable<RosterSlotConfig['radar']> {
  slot.radar ??= { maxLockRangeM: 18, detectionMode: 1 };
  return slot.radar;
}

function radarValue(slot: RosterSlotConfig): NonNullable<RosterSlotConfig['radar']> {
  return slot.radar ?? { maxLockRangeM: 18, detectionMode: 1 };
}

function setRadarMode(slot: RosterSlotConfig, event: Event): void {
  ensureRadar(slot).detectionMode = Number((event.target as HTMLSelectElement).value) as 0 | 1 | 2;
}

function setRadarRange(slot: RosterSlotConfig, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) ensureRadar(slot).maxLockRangeM = value;
}

function emitLaunch(): void {
  emit('launchMatch', JSON.parse(JSON.stringify(match)) as HeadlessMatchConfig);
}
</script>

<template>
  <aside class="team-builder">
    <header class="tb-head">
      <div>
        <div class="tb-kicker">Custom Match</div>
        <h1>Team Builder</h1>
      </div>
      <span class="tb-status" :class="{ on: agentConnected && launcherStatus?.ready !== false }">
        {{ launchReason }}
      </span>
    </header>

    <section class="tb-section">
      <div class="tb-row-title">Ruleset</div>
      <div class="tb-segment">
        <button
          v-for="option in ruleSetOptions"
          :key="option.id"
          type="button"
          :class="{ active: option.id === ruleSet }"
          @click="selectRuleSet(option.id)"
        >
          {{ option.label }}
        </button>
      </div>
      <div class="tb-grid two">
        <label>
          <span>Map</span>
          <input v-model.number="match.mapId" type="number" min="1" />
        </label>
        <label>
          <span>Net</span>
          <select v-model.number="match.nettype">
            <option :value="0">Standalone</option>
          </select>
        </label>
      </div>
      <div class="tb-toggles">
        <label>
          <input v-model="match.aiFill" type="checkbox" />
          <span>AI fill</span>
        </label>
        <label>
          <input v-model="match.hudHidden" type="checkbox" />
          <span>HUD hidden</span>
        </label>
        <label>
          <input v-model="match.attrrecord" type="checkbox" />
          <span>Record</span>
        </label>
      </div>
    </section>

    <section class="tb-section">
      <div class="tb-row-title">Teams</div>
      <div class="tb-team-tabs">
        <button
          v-for="team in match.teams"
          :key="team.teamId"
          type="button"
          :class="[{ active: team.teamId === selectedTeamId }, team.teamId === 0 ? 'red' : 'blue']"
          @click="selectedTeamId = team.teamId"
        >
          <span>{{ teamLabel(team) }}</span>
          <strong>{{ computeTeamCost(team).toFixed(1) }}</strong>
        </button>
      </div>
      <div class="tb-total">
        <span>Total</span>
        <strong>{{ totalCost.toFixed(1) }}</strong>
      </div>
    </section>

    <section class="tb-slots" :class="selectedTeamId === 0 ? 'red' : 'blue'">
      <article v-for="slot in selectedTeam.slots" :key="slot.teamNumber" class="tb-slot">
        <div class="tb-slot-head">
          <div>
            <strong>#{{ slot.teamNumber }} {{ careerLabel(slot.careerId) }}</strong>
            <span>{{ computeSlotCost(slot).toFixed(1) }} cost</span>
          </div>
          <select :value="slot.entityType" @change="setEntity(slot, $event)">
            <option v-for="option in slotOptions(slot)" :key="option.entityType" :value="option.entityType">
              {{ option.name }}
            </option>
          </select>
        </div>

        <div class="tb-grid three">
          <label>
            <span>Power</span>
            <input
              type="number"
              min="0"
              max="300"
              step="10"
              :value="paramValue(slot, RosterAttrId.CapacityEnergyPowerMax, defaultValue(slot, 'dischargeW'))"
              @input="setParam(slot, RosterAttrId.CapacityEnergyPowerMax, $event)"
            />
          </label>
          <label v-if="ammoControl(slot)">
            <span>{{ ammoControl(slot)!.label }}</span>
            <input
              type="number"
              min="0"
              :max="ammoControl(slot)!.max"
              step="10"
              :value="paramValue(slot, ammoControl(slot)!.attrId, ammoControl(slot)!.fallback)"
              @input="setParam(slot, ammoControl(slot)!.attrId, $event)"
            />
          </label>
          <label v-if="fireInterval(slot) > 0">
            <span>Interval</span>
            <input
              type="number"
              min="20"
              max="200"
              step="1"
              :value="fireInterval(slot)"
              @input="setFireInterval(slot, $event)"
            />
          </label>
        </div>

        <div v-if="slot.careerId === CareerId.Engineer" class="tb-grid two">
          <label>
            <span>Assembly</span>
            <select :value="engineerValue(slot).maxAssemblyLevel" @change="setEngineerLevel(slot, $event)">
              <option :value="1">L1</option>
              <option :value="2">L2</option>
              <option :value="3">L3</option>
              <option :value="4">L4</option>
            </select>
          </label>
          <label>
            <span>Cores</span>
            <select :value="engineerValue(slot).corePool" @change="setEngineerPool(slot, $event)">
              <option :value="2">2</option>
              <option :value="4">4</option>
              <option :value="6">6</option>
            </select>
          </label>
        </div>

        <div v-if="slot.careerId === CareerId.Aerial || slot.careerId === CareerId.Dart" class="tb-dart">
          <label>
            <input :checked="dartValue(slot).canOutpost" type="checkbox" @change="setDartTarget(slot, 'canOutpost', $event)" />
            <span>Outpost</span>
          </label>
          <label>
            <input :checked="dartValue(slot).canBase" type="checkbox" @change="setDartTarget(slot, 'canBase', $event)" />
            <span>Base</span>
          </label>
          <label>
            <span>Mode</span>
            <select :value="dartValue(slot).maxBaseMode" @change="setDartMode(slot, $event)">
              <option :value="0">0</option>
              <option :value="1">1</option>
              <option :value="2">2</option>
              <option :value="3">3</option>
            </select>
          </label>
        </div>

        <div v-if="slot.careerId === CareerId.Radar" class="tb-grid two">
          <label>
            <span>Mode</span>
            <select :value="radarValue(slot).detectionMode" @change="setRadarMode(slot, $event)">
              <option :value="0">Off</option>
              <option :value="1">Basic</option>
              <option :value="2">Full</option>
            </select>
          </label>
          <label>
            <span>Range</span>
            <input type="number" min="0" max="40" :value="radarValue(slot).maxLockRangeM" @input="setRadarRange(slot, $event)" />
          </label>
        </div>
      </article>
    </section>

    <footer class="tb-footer">
      <code :title="rosterSpec">{{ rosterSpec }}</code>
      <button type="button" class="tb-launch" :disabled="launchDisabled" @click="emitLaunch">
        {{ launcherBusy ? 'Launching' : 'Launch' }}
      </button>
    </footer>
  </aside>
</template>
