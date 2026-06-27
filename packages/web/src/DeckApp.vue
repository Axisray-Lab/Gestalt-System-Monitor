<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from 'reka-ui';
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
  type RosterSlotConfig,
  type TeamConfig,
  type WorldSnapshot,
} from '@gsm/protocol';
import { useDiscovery } from '@/discovery/useDiscovery';
import { useMatches, type MatchHooks } from '@/feed/useMatches';
import type { FeedStatus, MatchView } from '@/feed/types';
import { DioramaScene, type ThreePerformanceStats } from '@/three/DioramaScene';

interface PacketGroup {
  firstKey: string;
  label: string;
  members: MatchView[];
  kind: 'match' | 'packet' | 'folder';
}

interface LibraryFolder {
  id: string;
  label: string;
  keys: string[];
  parentId?: string | null;
}

interface PointerDragState {
  group: PacketGroup;
  startX: number;
  startY: number;
  pointerId: number;
  source: HTMLElement;
  active: boolean;
}

interface DesktopMonitorInfo {
  id: string;
  label: string;
  name: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
  selected: boolean;
}

interface DesktopMonitorSettings {
  selectedMonitorId: string;
  monitors: DesktopMonitorInfo[];
}

interface DesktopLaunchSettings {
  source: string; // 'standalone' | 'steam'
  applied: boolean;
  detail: string;
}

interface FolderCrumb {
  id: string | null;
  label: string;
}

interface PersistedLibraryState {
  folders: LibraryFolder[];
  removedKeys: string[];
  currentFolderId: string | null;
}

interface TauriGlobal {
  core?: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
}

type SidebarMode = 'files' | 'matchmaking' | 'teams';
type PairingMode = 'balanced' | 'mirror' | 'manual';
type FileIconKind = 'folder' | 'replay' | 'live';
type TeamTone = 'red' | 'blue' | 'neutral';

interface MapOption {
  id: number;
  label: string;
  detail: string;
  ruleSet: RuleSet;
}

interface RoundOption {
  id: number;
  label: string;
  detail: string;
}

interface StrategyOption {
  id: PairingMode;
  label: string;
  detail: string;
}

interface SlotBlueprint {
  teamNumber: number;
  careerId: CareerId;
  label: string;
  shortLabel: string;
}

interface TeamDraft {
  id: string;
  label: string;
  tone: TeamTone;
  teamId: number;
  slots: RosterSlotConfig[];
}

const RESOURCE_LIMIT_REASON = 'Available resources are below the launch budget.';
const DESKTOP_FPS_DEBUG_STORAGE_KEY = 'gsm.desktop.fpsDebugWindow';
const LIBRARY_STATE_STORAGE_KEY = 'gsm.deck.libraryState.v1';
const MAP_OPTIONS: MapOption[] = [
  { id: RULESETS[RuleSet.RMUC2026].mapId, label: RULESETS[RuleSet.RMUC2026].label, detail: 'Full 6-slot roster', ruleSet: RuleSet.RMUC2026 },
  { id: RULESETS[RuleSet.RMUL2026].mapId, label: RULESETS[RuleSet.RMUL2026].label, detail: '3-slot league roster', ruleSet: RuleSet.RMUL2026 },
  { id: RULESETS[RuleSet.RMUL2026_1V1].mapId, label: RULESETS[RuleSet.RMUL2026_1V1].label, detail: 'Single infantry duel', ruleSet: RuleSet.RMUL2026_1V1 },
];
const ROUND_OPTIONS: RoundOption[] = [
  { id: 1, label: 'Round 1', detail: 'Single run' },
  { id: 3, label: 'Round 3', detail: 'Short set' },
  { id: 5, label: 'Round 5', detail: 'Full set' },
];
const STRATEGY_OPTIONS: StrategyOption[] = [
  { id: 'balanced', label: '均衡', detail: '默认倾向' },
  { id: 'mirror', label: '镜像', detail: '双方同构' },
  { id: 'manual', label: '手动', detail: '独立配置' },
];
const SLOT_BLUEPRINTS: SlotBlueprint[] = [
  { teamNumber: 1, careerId: CareerId.Hero, label: 'Hero', shortLabel: 'HERO' },
  { teamNumber: 2, careerId: CareerId.Engineer, label: 'Engineer', shortLabel: 'ENG' },
  { teamNumber: 3, careerId: CareerId.Infantry, label: 'Infantry A', shortLabel: 'INF-A' },
  { teamNumber: 4, careerId: CareerId.Infantry, label: 'Infantry B', shortLabel: 'INF-B' },
  { teamNumber: 5, careerId: CareerId.Sentry, label: 'Sentry', shortLabel: 'SEN' },
  { teamNumber: 6, careerId: CareerId.Aerial, label: 'Aerial', shortLabel: 'AIR' },
  { teamNumber: 7, careerId: CareerId.Radar, label: 'Radar', shortLabel: 'RAD' },
  { teamNumber: 8, careerId: CareerId.Dart, label: 'Dart', shortLabel: 'DART' },
];
const ALL_CONSTRUCTS = SLOT_BLUEPRINTS.flatMap((slot) => constructsForCareer(slot.careerId));
const {
  processes,
  connected,
  launcherStatus,
  launcherBusy,
  launcherError,
  launchHeadlessMatches,
  stopHeadlessLaunches,
} = useDiscovery();
const MAX_TARGET_MATCHES = 500;
const MAX_PARALLEL_WORKERS = 16;
const numberFormatter = new Intl.NumberFormat('en-US');
const focusedKey = ref<string | null>(null);
const host = ref<HTMLDivElement>();
const snapshotMap = shallowRef<Record<string, WorldSnapshot>>({});
const sidebarMode = ref<SidebarMode>('files');
const targetMatchCount = ref(50);
const parallelWorkerCount = ref(1);
const launchStopBusy = ref(false);
const pairingMode = ref<PairingMode>('balanced');
const selectedRuleSet = ref<RuleSet>(RuleSet.RMUC2026);
const selectedMapId = ref(MAP_OPTIONS[0].id);
const selectedRoundCount = ref(ROUND_OPTIONS[0].id);
const teamDrafts = ref<TeamDraft[]>([
  createDefaultTeam('team-red-a', 'Red A', 'red', 0),
  createDefaultTeam('team-blue-a', 'Blue A', 'blue', 1),
]);
const redTeamDraftId = ref(teamDrafts.value[0].id);
const blueTeamDraftId = ref(teamDrafts.value[1].id);
const selectedTeamDraftId = ref(teamDrafts.value[0].id);
const editingSlotTeamId = ref<string | null>(null);
const editingSlotNumber = ref<number | null>(null);
const roundSeed = ref(1);
const autoSaveReplays = ref(true);
const initialLibraryState = loadLibraryState();
const libraryFolders = ref<LibraryFolder[]>(initialLibraryState.folders);
const currentFolderId = ref<string | null>(initialLibraryState.currentFolderId);
const draggingGroup = ref<PacketGroup | null>(null);
const dragPreview = ref<{ group: PacketGroup; x: number; y: number } | null>(null);
const dropTargetKey = ref<string | null>(null);
const suppressNextClick = ref(false);
const removedKeys = ref<Set<string>>(new Set(initialLibraryState.removedKeys));
const desktopSettingsOpen = ref(false);
const showFpsDebugWindow = ref(loadDesktopBool(DESKTOP_FPS_DEBUG_STORAGE_KEY, false));
const desktopMonitors = ref<DesktopMonitorInfo[]>([]);
const selectedDesktopMonitorId = ref('');
const desktopMonitorBusy = ref(false);
const desktopMonitorError = ref<string | null>(null);
const desktopBridgeAvailable = ref(false);
const launchSource = ref('standalone');
const launchSourceDetail = ref('');
const launchSourceBusy = ref(false);
const libraryNotice = ref('Autosave on');
const performanceStats = ref<ThreePerformanceStats>({
  fps: 0,
  frameMs: 0,
  frameMsMin: 0,
  frameMsP95: 0,
  frameMsMax: 0,
  longFrames: 0,
  cpuMs: 0,
  updateMs: 0,
  renderMs: 0,
  labelMs: 0,
  otherMs: 0,
  gpuMs: 0,
  gpuSupported: false,
  gpuRenderer: '',
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  pixelRatio: 1,
  unitCount: 0,
  activeUnitCount: 0,
  vehicleCount: 0,
  focused: false,
  width: 0,
  height: 0,
  frameSamples: [],
});

let scene: DioramaScene | null = null;
let pointerDragState: PointerDragState | null = null;

const hooks: MatchHooks = {
  onAdd: (key, label) => scene?.addUnit(key, label),
  onRemove: (key) => {
    scene?.removeUnit(key);
    if (focusedKey.value === key) {
      focusedKey.value = null;
      snapshotMap.value = {};
    }
  },
  onMap: (key, map) => scene?.setMap(key, map),
  onSnapshot: (key, snap) => {
    scene?.updateSnapshot(key, snap);
    if (key === focusedKey.value) snapshotMap.value = { [key]: snap };
  },
};

const { matches, start, setActiveKeys } = useMatches(processes, hooks, { mockCount: 0 });

const assignedFolderByKey = computed(() => {
  const assigned = new Map<string, string>();
  for (const folder of libraryFolders.value) {
    for (const key of folder.keys) assigned.set(key, folder.id);
  }
  return assigned;
});

const baseFileGroups = computed<PacketGroup[]>(() => {
  const groups = new Map<string, MatchView[]>();
  const singles: MatchView[] = [];

  for (const m of matches.value) {
    if (removedKeys.value.has(m.key)) continue;
    if (m.key.includes('iter-')) {
      const prefix = m.key.replace(/iter-\d+.*$/, 'iter');
      const arr = groups.get(prefix) ?? [];
      arr.push(m);
      groups.set(prefix, arr);
    } else {
      singles.push(m);
    }
  }

  const result: PacketGroup[] = singles.map((m) => ({
    firstKey: m.key,
    label: m.label,
    members: [m],
    kind: 'match',
  }));

  for (const members of groups.values()) {
    members.sort(iterSort);
    const example = members[0].label
      .replace(/Iter\s*\d+/i, '')
      .replace(/\s*\([RB][^)]*\)\s*/g, '')
      .trim();
    result.push({
      firstKey: members[0].key,
      label: example || 'Replay packet',
      members,
      kind: 'packet',
    });
  }

  return result;
});

const currentFolder = computed(() =>
  currentFolderId.value ? libraryFolders.value.find((folder) => folder.id === currentFolderId.value) ?? null : null
);
const currentFolderPath = computed(() => folderPathLabel(currentFolderId.value));
const currentFolderCrumbs = computed<FolderCrumb[]>(() => folderPathCrumbs(currentFolderId.value));

const packetGroups = computed<PacketGroup[]>(() => {
  const folderGroups: PacketGroup[] = libraryFolders.value
    .filter((folder) => folderParentId(folder) === currentFolderId.value)
    .map(folderToGroup);
  const fileGroups = baseFileGroups.value.filter((group) => groupFolderId(group) === currentFolderId.value);
  return [...folderGroups, ...fileGroups];
});

const focused = computed(() =>
  focusedKey.value ? matches.value.find((m) => m.key === focusedKey.value) ?? null : null
);
const focusedSnap = computed(() =>
  focusedKey.value ? snapshotMap.value[focusedKey.value] : undefined
);
const iterSiblings = computed(() => {
  if (!focused.value?.key.includes('iter-')) return [];
  const prefix = focused.value.key.replace(/iter-\d+.*$/, 'iter');
  return matches.value.filter((m) => m.key.startsWith(prefix)).sort(iterSort);
});
const robots = computed(() =>
  focusedSnap.value?.vehicles.filter((v) => v.kind === 'robot').length ?? null
);
const structures = computed(() =>
  focusedSnap.value?.vehicles.filter((v) => v.kind !== 'robot').length ?? null
);
const folderCount = computed(() => libraryFolders.value.length);
const visibleFileCount = computed(() =>
  packetGroups.value.reduce((sum, group) => sum + Math.max(1, group.members.length), 0)
);
const hiddenFileCount = computed(() => removedKeys.value.size);
const selectedFileGroup = computed(() =>
  packetGroups.value.find((group) => groupActive(group)) ??
  baseFileGroups.value.find((group) => groupActive(group)) ??
  null
);
const selectedReplayMembers = computed(() => {
  if (selectedFileGroup.value && selectedFileGroup.value.members.length > 1) return selectedFileGroup.value.members;
  return iterSiblings.value;
});
const selectedMap = computed(() => MAP_OPTIONS.find((option) => option.id === selectedMapId.value) ?? MAP_OPTIONS[0]);
const selectedRound = computed(
  () => ROUND_OPTIONS.find((option) => option.id === selectedRoundCount.value) ?? ROUND_OPTIONS[0]
);
const selectedStrategy = computed(
  () => STRATEGY_OPTIONS.find((option) => option.id === pairingMode.value) ?? STRATEGY_OPTIONS[0]
);
const selectedTeamDraft = computed(() => teamDraftById(selectedTeamDraftId.value) ?? teamDrafts.value[0] ?? null);
const redTeamDraft = computed(() => teamDraftById(redTeamDraftId.value) ?? teamDrafts.value[0] ?? null);
const blueTeamDraft = computed(() => teamDraftById(blueTeamDraftId.value) ?? teamDrafts.value[1] ?? teamDrafts.value[0] ?? null);
const selectedTeamCost = computed(() => (selectedTeamDraft.value ? teamDraftCost(selectedTeamDraft.value) : 0));
const redTeamCost = computed(() => (redTeamDraft.value ? teamDraftCost(redTeamDraft.value) : 0));
const blueTeamCost = computed(() => (blueTeamDraft.value ? teamDraftCost(blueTeamDraft.value) : 0));
const selectedHeadlessMatch = computed<HeadlessMatchConfig | null>(() => {
  if (!redTeamDraft.value || !blueTeamDraft.value) return null;
  return {
    mapId: selectedMapId.value,
    nettype: 0,
    aiFill: true,
    hudHidden: false,
    attrrecord: autoSaveReplays.value,
    teams: [
      teamToConfig(redTeamDraft.value, 0),
      teamToConfig(blueTeamDraft.value, 1),
    ],
  };
});
const selectedRosterSpec = computed(() =>
  selectedHeadlessMatch.value ? buildRosterSpec(selectedHeadlessMatch.value) : ''
);
const editingTeamDraft = computed(() => (editingSlotTeamId.value ? teamDraftById(editingSlotTeamId.value) : null));
const editingSlot = computed(() =>
  editingTeamDraft.value?.slots.find((slot) => slot.teamNumber === editingSlotNumber.value) ?? null
);
const editingSlotCost = computed(() => (editingSlot.value ? computeSlotCost(editingSlot.value) : 0));
const latestBatch = computed(() => launcherStatus.value?.batches?.[0] ?? null);
const runningBatch = computed(() => launcherStatus.value?.batches?.find((batch) => batch.status === 'running') ?? null);
const autoSaveAvailable = computed(() => launcherStatus.value?.autoSave?.available === true);
const autoSaveUnavailableReason = computed(
  () => launcherStatus.value?.autoSave?.reason ?? 'Local service is updating'
);
const resourceLimited = computed(() => launcherStatus.value?.reason === RESOURCE_LIMIT_REASON);
const launcherReady = computed(() => {
  if (!connected.value || !launcherStatus.value || launcherBusy.value) return false;
  if (!selectedHeadlessMatch.value) return false;
  if (launcherStatus.value.ready !== true && !resourceLimited.value) return false;
  if (autoSaveReplays.value && !autoSaveAvailable.value) return false;
  return true;
});
const parallelLimit = computed(() => {
  const recommended = launcherStatus.value?.resources.recommendedAdditionalMatches ?? 1;
  return Math.max(1, Math.min(MAX_PARALLEL_WORKERS, targetMatchCount.value, recommended));
});
const launchHint = computed(() => {
  if (launcherError.value) return launcherError.value;
  if (!connected.value) return 'Local service starting';
  if (launchStopBusy.value) return 'Stopping running batch';
  if (launcherBusy.value) return 'Launching...';
  if (!launcherStatus.value) return 'Checking local service';
  if (!launcherStatus.value.ready && !resourceLimited.value) {
    return launcherStatus.value.reason ?? 'Local service not ready';
  }
  if (autoSaveReplays.value && !autoSaveAvailable.value) {
    return autoSaveUnavailableReason.value;
  }
  const batch = runningBatch.value ?? latestBatch.value;
  if (batch?.status === 'running') return `${batch.completedMatches}/${batch.targetMatches} done`;
  if (resourceLimited.value) return 'Low resources; click to launch anyway';
  return 'Custom roster launches one match';
});
const fpsClass = computed(() => {
  const f = performanceStats.value.fps;
  return f >= 50 ? 'good' : f >= 30 ? 'warn' : 'bad';
});
const shortGpu = computed(() => {
  const raw = performanceStats.value.gpuRenderer;
  if (!raw) return '';
  const angle = raw.match(/^ANGLE \(([^,]+),\s*(.+?)(?:\s+(?:Direct3D|OpenGL|Vulkan).*)?\)$/);
  return angle?.[2]?.trim() || raw;
});
const desktopMonitorHint = computed(() => {
  if (!desktopBridgeAvailable.value) return '仅桌面端可用';
  if (desktopMonitorError.value) return desktopMonitorError.value;
  if (desktopMonitorBusy.value) return '正在应用';
  const selected = desktopMonitors.value.find((monitor) => monitor.id === selectedDesktopMonitorId.value);
  return selected ? '已本地保存' : '正在读取屏幕';
});
const launchSourceHint = computed(() => {
  if (!desktopBridgeAvailable.value) return '仅桌面端可切换';
  if (launchSourceBusy.value) return '正在应用';
  if (launchSourceDetail.value) return launchSourceDetail.value;
  return launchSource.value === 'steam' ? 'Steam 安装' : '本仓编译 standalone';
});
const launchSourceDisabled = computed(
  () => !desktopBridgeAvailable.value || launchSourceBusy.value
);
const desktopMonitorDisabled = computed(
  () => !desktopBridgeAvailable.value || desktopMonitorBusy.value || desktopMonitors.value.length === 0
);

watch(focusedKey, (key) => {
  scene?.applyFocus(key);
  if (!key) snapshotMap.value = {};
});

watch(parallelLimit, (limit) => {
  if (parallelWorkerCount.value > limit) parallelWorkerCount.value = limit;
});

watch(targetMatchCount, (target) => {
  if (parallelWorkerCount.value > target) parallelWorkerCount.value = target;
});

watch(showFpsDebugWindow, (enabled) => {
  saveDesktopBool(DESKTOP_FPS_DEBUG_STORAGE_KEY, enabled);
});

watch(
  [libraryFolders, currentFolderId, removedKeys],
  () => {
    saveLibraryState();
  },
  { deep: true }
);

watch(teamDrafts, () => {
  const fallback = teamDrafts.value[0]?.id ?? '';
  if (!teamDraftById(selectedTeamDraftId.value) && fallback) selectTeamDraft(fallback);
  if (!teamDraftById(redTeamDraftId.value) && fallback) redTeamDraftId.value = fallback;
  if (!teamDraftById(blueTeamDraftId.value) && fallback) blueTeamDraftId.value = fallback;
}, { deep: true });

function slotBlueprintsForRuleSet(ruleSet: RuleSet): SlotBlueprint[] {
  return RULESETS[ruleSet].slots.map((slot) => ({
    teamNumber: slot.teamNumber,
    careerId: slot.careerId,
    label: careerName(slot.careerId),
    shortLabel: careerShortName(slot.careerId, slot.teamNumber),
  }));
}

function cloneSlot(slot: RosterSlotConfig): RosterSlotConfig {
  return JSON.parse(JSON.stringify(slot)) as RosterSlotConfig;
}

function createDefaultTeam(
  id: string,
  label: string,
  tone: TeamTone,
  teamId: number,
  ruleSet: RuleSet = selectedRuleSet.value,
): TeamDraft {
  const defaultTeam = createDefaultMatch(ruleSet).teams.find((team) => team.teamId === teamId);
  return {
    id,
    label,
    tone,
    teamId,
    slots: defaultTeam
      ? defaultTeam.slots.map(cloneSlot)
      : slotBlueprintsForRuleSet(ruleSet).map(createDefaultSlot),
  };
}

function createDefaultSlot(blueprint: SlotBlueprint): RosterSlotConfig {
  const construct = constructsForCareer(blueprint.careerId)[0];
  return {
    teamNumber: blueprint.teamNumber,
    careerId: blueprint.careerId,
    entityType: construct?.entityType ?? 0,
    ...defaultCapabilitiesForCareer(blueprint.careerId),
  };
}

function defaultCapabilitiesForCareer(careerId: number): Partial<RosterSlotConfig> {
  void careerId;
  return {};
}

function teamDraftById(id: string): TeamDraft | null {
  return teamDrafts.value.find((team) => team.id === id) ?? null;
}

function teamToConfig(team: TeamDraft, teamId = team.teamId): TeamConfig {
  return {
    teamId,
    slots: team.slots.map(cloneSlot),
  };
}

function teamDraftCost(team: TeamDraft): number {
  return computeTeamCost(teamToConfig(team));
}

function slotCost(slot: RosterSlotConfig): number {
  return computeSlotCost(slot);
}

function formatCost(value: number): string {
  return `${value.toFixed(1)} 费`;
}

function slotBlueprint(teamNumber: number): SlotBlueprint {
  const blueprints = slotBlueprintsForRuleSet(selectedRuleSet.value);
  return blueprints.find((slot) => slot.teamNumber === teamNumber) ?? blueprints[0];
}

function careerName(careerId: number): string {
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

function careerShortName(careerId: number, teamNumber: number): string {
  switch (careerId) {
    case CareerId.Hero:
      return 'HERO';
    case CareerId.Engineer:
      return 'ENG';
    case CareerId.Infantry:
      return `INF-${teamNumber}`;
    case CareerId.Sentry:
      return 'SEN';
    case CareerId.Aerial:
      return 'AIR';
    case CareerId.Radar:
      return 'RAD';
    case CareerId.Dart:
      return 'DART';
    default:
      return String(teamNumber);
  }
}

function constructOptions(careerId: number): ReturnType<typeof constructsForCareer> {
  return constructsForCareer(careerId);
}

function constructLabel(entityType: number): string {
  const construct = ALL_CONSTRUCTS.find((item) => item.entityType === entityType);
  return construct ? construct.name : `Construct ${entityType}`;
}

function constructTierLabel(entityType: number): string {
  const construct = ALL_CONSTRUCTS.find((item) => item.entityType === entityType);
  if (!construct) return '未定义';
  return construct.buildTier === 5 ? '进阶机动' : '标准底盘';
}

function selectTeamDraft(id: string): void {
  const team = teamDraftById(id);
  if (!team) return;
  selectedTeamDraftId.value = team.id;
  editingSlotTeamId.value = null;
  editingSlotNumber.value = null;
}

function createTeamDraft(): void {
  const index = teamDrafts.value.length + 1;
  const team = createDefaultTeam(`team-${Date.now()}`, `Team ${index}`, 'neutral', index);
  teamDrafts.value = [...teamDrafts.value, team];
  selectTeamDraft(team.id);
  libraryNotice.value = `${team.label} 已创建`;
}

function editSlotDetails(team: TeamDraft, slot: RosterSlotConfig): void {
  selectTeamDraft(team.id);
  editingSlotTeamId.value = team.id;
  editingSlotNumber.value = slot.teamNumber;
}

function setSlotConstruct(slot: RosterSlotConfig, value: number): void {
  if (!Number.isFinite(value)) return;
  slot.entityType = value;
  delete slot.paramOverrides;
  delete slot.firingIntervalMs;
  delete slot.spread;
  delete slot.dart;
  delete slot.engineer;
  delete slot.radar;
  Object.assign(slot, defaultCapabilitiesForCareer(slot.careerId));
}

function defaultNumber(slot: RosterSlotConfig, key: keyof (typeof CONSTRUCT_DEFAULTS)[number]): number {
  const value = CONSTRUCT_DEFAULTS[slot.entityType]?.[key];
  return typeof value === 'number' ? value : 0;
}

function paramValue(slot: RosterSlotConfig, attrId: RosterAttrId, fallback: number): number {
  return slot.paramOverrides?.[attrId] ?? fallback;
}

function setParam(slot: RosterSlotConfig, attrId: RosterAttrId, value: number): void {
  if (!Number.isFinite(value)) return;
  slot.paramOverrides = { ...(slot.paramOverrides ?? {}), [attrId]: Math.round(value) };
}

function slotHasPower(slot: RosterSlotConfig): boolean {
  return CONSTRUCT_DEFAULTS[slot.entityType]?.dischargeW != null ||
    slot.paramOverrides?.[RosterAttrId.CapacityEnergyPowerMax] != null;
}

function slotAmmoMeta(slot: RosterSlotConfig):
  | { label: string; attrId: RosterAttrId; fallback: number; max: number; step: number }
  | null {
  const defaults = CONSTRUCT_DEFAULTS[slot.entityType];
  if (defaults?.ammo42 != null || slot.paramOverrides?.[RosterAttrId.Real42mmAmmoCount] != null) {
    return { label: '42mm', attrId: RosterAttrId.Real42mmAmmoCount, fallback: defaults?.ammo42 ?? 50, max: 240, step: 5 };
  }
  if (defaults?.ammo17 != null || slot.paramOverrides?.[RosterAttrId.Real17mmAmmoCount] != null) {
    return { label: '17mm', attrId: RosterAttrId.Real17mmAmmoCount, fallback: defaults?.ammo17 ?? 500, max: 2400, step: 50 };
  }
  return null;
}

function slotHasAmmo(slot: RosterSlotConfig): boolean {
  return slotAmmoMeta(slot) != null;
}

function ammoLabel(slot: RosterSlotConfig): string {
  return slotAmmoMeta(slot)?.label ?? 'Ammo';
}

function ammoAttrId(slot: RosterSlotConfig): RosterAttrId {
  return slotAmmoMeta(slot)?.attrId ?? RosterAttrId.Real17mmAmmoCount;
}

function ammoFallback(slot: RosterSlotConfig): number {
  return slotAmmoMeta(slot)?.fallback ?? 0;
}

function ammoMax(slot: RosterSlotConfig): number {
  return slotAmmoMeta(slot)?.max ?? 0;
}

function ammoStep(slot: RosterSlotConfig): number {
  return slotAmmoMeta(slot)?.step ?? 1;
}

function fireInterval(slot: RosterSlotConfig): number {
  if (slot.firingIntervalMs != null) return slot.firingIntervalMs;
  const fireRateHz = CONSTRUCT_DEFAULTS[slot.entityType]?.fireRateHz;
  return fireRateHz ? Math.round(1000 / fireRateHz) : 0;
}

function setFireInterval(slot: RosterSlotConfig, value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  slot.firingIntervalMs = Math.max(20, Math.min(240, Math.round(value)));
}

function ensureSpread(slot: RosterSlotConfig): NonNullable<RosterSlotConfig['spread']> {
  slot.spread ??= { maxEnclosing: 0, minEnclosing: 0 };
  return slot.spread;
}

function setSpreadValue(slot: RosterSlotConfig, key: 'maxEnclosing' | 'minEnclosing', value: number): void {
  if (!Number.isFinite(value)) return;
  ensureSpread(slot)[key] = Math.max(0, Math.min(120, Math.round(value)));
}

function resetTeamsForRuleSet(ruleSet: RuleSet): void {
  selectedRuleSet.value = ruleSet;
  teamDrafts.value = [
    createDefaultTeam('team-red-a', 'Red A', 'red', 0, ruleSet),
    createDefaultTeam('team-blue-a', 'Blue A', 'blue', 1, ruleSet),
  ];
  redTeamDraftId.value = teamDrafts.value[0].id;
  blueTeamDraftId.value = teamDrafts.value[1].id;
  selectTeamDraft(teamDrafts.value[0].id);
}

function slotSupportsEngineer(slot: RosterSlotConfig): boolean {
  return slot.careerId === CareerId.Engineer;
}

function slotSupportsRadar(slot: RosterSlotConfig): boolean {
  return slot.careerId === CareerId.Radar;
}

function slotSupportsDart(slot: RosterSlotConfig): boolean {
  return slot.careerId === CareerId.Dart || slot.careerId === CareerId.Aerial;
}

function ensureDart(slot: RosterSlotConfig): NonNullable<RosterSlotConfig['dart']> {
  slot.dart ??= { canOutpost: true, canBase: false, maxBaseMode: 0 };
  return slot.dart;
}

function ensureEngineer(slot: RosterSlotConfig): NonNullable<RosterSlotConfig['engineer']> {
  slot.engineer ??= { maxAssemblyLevel: 1, corePool: 2 };
  return slot.engineer;
}

function ensureRadar(slot: RosterSlotConfig): NonNullable<RosterSlotConfig['radar']> {
  slot.radar ??= { maxLockRangeM: 18, detectionMode: 1 };
  return slot.radar;
}

function toggleDart(slot: RosterSlotConfig, enabled: boolean): void {
  if (enabled) {
    ensureDart(slot);
  } else {
    delete slot.dart;
  }
}

function setDartOutpost(slot: RosterSlotConfig, enabled: boolean): void {
  ensureDart(slot).canOutpost = enabled;
}

function setDartBase(slot: RosterSlotConfig, enabled: boolean): void {
  const dart = ensureDart(slot);
  dart.canBase = enabled;
  if (!enabled) dart.maxBaseMode = 0;
}

function setDartBaseMode(slot: RosterSlotConfig, mode: number): void {
  const dart = ensureDart(slot);
  dart.canBase = true;
  dart.maxBaseMode = Math.max(0, Math.min(3, Math.round(mode))) as 0 | 1 | 2 | 3;
}

function setEngineerLevel(slot: RosterSlotConfig, level: number): void {
  ensureEngineer(slot).maxAssemblyLevel = Math.max(1, Math.min(4, Math.round(level))) as 1 | 2 | 3 | 4;
}

function setEngineerPool(slot: RosterSlotConfig, pool: number): void {
  const normalized = pool >= 6 ? 6 : pool >= 4 ? 4 : 2;
  ensureEngineer(slot).corePool = normalized as 2 | 4 | 6;
}

function setRadarRange(slot: RosterSlotConfig, range: number): void {
  ensureRadar(slot).maxLockRangeM = Math.max(0, Math.min(40, Math.round(range)));
}

function setRadarMode(slot: RosterSlotConfig, mode: number): void {
  ensureRadar(slot).detectionMode = Math.max(0, Math.min(2, Math.round(mode))) as 0 | 1 | 2;
}

function selectMap(id: number): void {
  selectedMapId.value = id;
  const option = MAP_OPTIONS.find((candidate) => candidate.id === id);
  if (option && option.ruleSet !== selectedRuleSet.value) resetTeamsForRuleSet(option.ruleSet);
}

function selectRound(count: number): void {
  selectedRoundCount.value = count;
}

function loadDesktopBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}

function saveDesktopBool(key: string, enabled: boolean): void {
  try {
    window.localStorage.setItem(key, enabled ? '1' : '0');
  } catch {
    /* localStorage can be unavailable in hardened webviews */
  }
}

function isPersistedFolder(value: unknown): value is LibraryFolder {
  if (typeof value !== 'object' || value === null) return false;
  const folder = value as Partial<LibraryFolder>;
  return (
    typeof folder.id === 'string' &&
    typeof folder.label === 'string' &&
    Array.isArray(folder.keys) &&
    folder.keys.every((key) => typeof key === 'string') &&
    (folder.parentId == null || typeof folder.parentId === 'string')
  );
}

function loadLibraryState(): PersistedLibraryState {
  try {
    const raw = window.localStorage.getItem(LIBRARY_STATE_STORAGE_KEY);
    if (!raw) return { folders: [], removedKeys: [], currentFolderId: null };
    const parsed = JSON.parse(raw) as Partial<PersistedLibraryState>;
    const folders = Array.isArray(parsed.folders) ? parsed.folders.filter(isPersistedFolder) : [];
    const folderIds = new Set(folders.map((folder) => folder.id));
    const normalizedFolders = folders.map((folder) => ({
      id: folder.id,
      label: folder.label,
      keys: [...new Set(folder.keys)],
      parentId: folder.parentId && folderIds.has(folder.parentId) && folder.parentId !== folder.id
        ? folder.parentId
        : null,
    }));
    const removedKeys = Array.isArray(parsed.removedKeys)
      ? parsed.removedKeys.filter((key): key is string => typeof key === 'string')
      : [];
    const currentFolderId =
      typeof parsed.currentFolderId === 'string' && folderIds.has(parsed.currentFolderId)
        ? parsed.currentFolderId
        : null;
    return {
      folders: normalizedFolders,
      removedKeys: [...new Set(removedKeys)],
      currentFolderId,
    };
  } catch {
    return { folders: [], removedKeys: [], currentFolderId: null };
  }
}

function saveLibraryState(): void {
  const state: PersistedLibraryState = {
    folders: libraryFolders.value,
    removedKeys: [...removedKeys.value],
    currentFolderId: currentFolderId.value,
  };
  try {
    window.localStorage.setItem(LIBRARY_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage can be unavailable in hardened webviews */
  }
}

function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> | null {
  const tauri = (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) return null;
  desktopBridgeAvailable.value = true;
  return invoke<T>(command, args);
}

function applyDesktopMonitorSettings(settings: DesktopMonitorSettings): void {
  desktopMonitors.value = settings.monitors;
  selectedDesktopMonitorId.value = settings.selectedMonitorId;
  desktopMonitorError.value = null;
  desktopBridgeAvailable.value = true;
}

async function loadDesktopMonitorSettings(): Promise<void> {
  const request = tauriInvoke<DesktopMonitorSettings>('desktop_monitor_settings');
  if (!request) {
    desktopBridgeAvailable.value = false;
    desktopMonitors.value = [];
    selectedDesktopMonitorId.value = '';
    return;
  }

  desktopMonitorBusy.value = true;
  try {
    applyDesktopMonitorSettings(await request);
  } catch (err) {
    desktopMonitorError.value = err instanceof Error ? err.message : String(err);
  } finally {
    desktopMonitorBusy.value = false;
  }
}

async function setDesktopMonitor(monitorId: string): Promise<void> {
  if (!monitorId || monitorId === selectedDesktopMonitorId.value) return;
  const previousMonitorId = selectedDesktopMonitorId.value;
  selectedDesktopMonitorId.value = monitorId;
  const request = tauriInvoke<DesktopMonitorSettings>('desktop_set_monitor', { monitorId });
  if (!request) {
    selectedDesktopMonitorId.value = previousMonitorId;
    desktopBridgeAvailable.value = false;
    return;
  }

  desktopMonitorBusy.value = true;
  try {
    applyDesktopMonitorSettings(await request);
  } catch (err) {
    selectedDesktopMonitorId.value = previousMonitorId;
    desktopMonitorError.value = err instanceof Error ? err.message : String(err);
  } finally {
    desktopMonitorBusy.value = false;
  }
}

function handleDesktopMonitorChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  void setDesktopMonitor(target.value);
}

function applyDesktopLaunchSettings(settings: DesktopLaunchSettings): void {
  launchSource.value = settings.source;
  launchSourceDetail.value = settings.detail;
  desktopBridgeAvailable.value = true;
}

async function loadDesktopLaunchSettings(): Promise<void> {
  const request = tauriInvoke<DesktopLaunchSettings>('desktop_launch_settings');
  if (!request) return;
  launchSourceBusy.value = true;
  try {
    applyDesktopLaunchSettings(await request);
  } catch (err) {
    launchSourceDetail.value = err instanceof Error ? err.message : String(err);
  } finally {
    launchSourceBusy.value = false;
  }
}

async function setDesktopLaunchSource(source: string): Promise<void> {
  if (!source || source === launchSource.value) return;
  const previous = launchSource.value;
  launchSource.value = source;
  const request = tauriInvoke<DesktopLaunchSettings>('desktop_set_launch_source', { source });
  if (!request) {
    launchSource.value = previous;
    desktopBridgeAvailable.value = false;
    return;
  }
  launchSourceBusy.value = true;
  try {
    applyDesktopLaunchSettings(await request);
  } catch (err) {
    launchSource.value = previous;
    launchSourceDetail.value = err instanceof Error ? err.message : String(err);
  } finally {
    launchSourceBusy.value = false;
  }
}

function handleLaunchSourceChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  void setDesktopLaunchSource(target.value);
}

function formatCount(value: number): string {
  return numberFormatter.format(Math.round(value));
}

function iterSort(a: MatchView, b: MatchView): number {
  const na = Number(a.key.match(/iter-(\d+)/)?.[1] ?? 0);
  const nb = Number(b.key.match(/iter-(\d+)/)?.[1] ?? 0);
  return na - nb;
}

function groupStatus(group: PacketGroup): FeedStatus {
  if (group.members.some((m) => m.status === 'open')) return 'open';
  if (group.members.some((m) => m.status === 'connecting')) return 'connecting';
  if (group.members.some((m) => m.status === 'error')) return 'error';
  if (group.members.some((m) => m.status === 'closed')) return 'closed';
  return group.members[0]?.status ?? 'idle';
}

function groupSubtitle(group: PacketGroup): string {
  if (group.kind === 'folder') {
    const childFolders = libraryFolders.value.filter((folder) => folderParentId(folder) === group.firstKey).length;
    const folderSuffix = childFolders > 0 ? ` · ${childFolders} folders` : '';
    return `${group.members.length} saved items${folderSuffix} · folder`;
  }
  if (group.members.length === 1) {
    const m = group.members[0];
    return `${m.playerCount != null ? `${m.playerCount}p · ` : ''}${m.status}`;
  }
  return `${group.members.length} iterations · ${groupStatus(group)}`;
}

function groupActive(group: PacketGroup): boolean {
  return group.members.some((m) => m.key === focusedKey.value);
}

function fileIconKind(group: PacketGroup): FileIconKind {
  if (group.kind === 'folder') return 'folder';
  if (group.kind === 'match' && ['connecting', 'open'].includes(groupStatus(group))) return 'live';
  return 'replay';
}

function focusGroup(group: PacketGroup): void {
  if (suppressNextClick.value) {
    suppressNextClick.value = false;
    return;
  }
  if (group.kind === 'folder') {
    currentFolderId.value = group.firstKey;
    focusedKey.value = null;
    return;
  }
  focusedKey.value = group.members[0]?.key ?? null;
}

function folderParentId(folder: LibraryFolder): string | null {
  return folder.parentId ?? null;
}

function folderById(id: string | null | undefined): LibraryFolder | null {
  return id ? libraryFolders.value.find((folder) => folder.id === id) ?? null : null;
}

function folderToGroup(folder: LibraryFolder): PacketGroup {
  const members = folder.keys
    .map((key) => matches.value.find((m) => m.key === key))
    .filter((m): m is MatchView => m != null)
    .filter((m) => !removedKeys.value.has(m.key));
  return {
    firstKey: folder.id,
    label: folder.label,
    members,
    kind: 'folder',
  };
}

function groupFolderId(group: PacketGroup): string | null {
  if (group.kind === 'folder') {
    return folderParentId(folderById(group.firstKey) ?? { id: group.firstKey, label: group.label, keys: [] });
  }
  for (const member of group.members) {
    const folderId = assignedFolderByKey.value.get(member.key);
    if (folderId) return folderId;
  }
  return null;
}

function folderPathLabel(folderId: string | null): string {
  return folderPathCrumbs(folderId)
    .map((crumb) => crumb.label)
    .join(' / ');
}

function folderPathCrumbs(folderId: string | null): FolderCrumb[] {
  if (!folderId) return [{ id: null, label: '根目录' }];
  const folders: LibraryFolder[] = [];
  const seen = new Set<string>();
  let cursor: string | null = folderId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = folderById(cursor);
    if (!folder) break;
    folders.unshift(folder);
    cursor = folderParentId(folder);
  }
  return [
    { id: null, label: '根目录' },
    ...folders.map((folder) => ({ id: folder.id, label: folder.label })),
  ];
}

function goToFolder(folderId: string | null): void {
  currentFolderId.value = folderId;
  dropTargetKey.value = null;
}

function goUpFolder(): void {
  goToFolder(currentFolder.value ? folderParentId(currentFolder.value) : null);
}

function uniqueMemberKeys(group: PacketGroup): string[] {
  return [...new Set(group.members.map((member) => member.key))];
}

function endDrag(): void {
  draggingGroup.value = null;
  dragPreview.value = null;
  dropTargetKey.value = null;
}

function folderDescendantIds(folderId: string): Set<string> {
  const result = new Set<string>();
  const visit = (id: string): void => {
    for (const child of libraryFolders.value.filter((folder) => folderParentId(folder) === id)) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      visit(child.id);
    }
  };
  visit(folderId);
  return result;
}

function canMoveGroupToFolder(group: PacketGroup | null, targetFolderId: string | null): boolean {
  if (!group) return false;
  if (group.kind === 'folder') {
    if (targetFolderId === group.firstKey) return false;
    if (targetFolderId && folderDescendantIds(group.firstKey).has(targetFolderId)) return false;
  }
  return groupFolderId(group) !== targetFolderId;
}

function moveGroupToFolder(group: PacketGroup, targetFolderId: string | null): boolean {
  if (!canMoveGroupToFolder(group, targetFolderId)) return false;
  if (group.kind === 'folder') {
    libraryFolders.value = libraryFolders.value.map((folder) =>
      folder.id === group.firstKey ? { ...folder, parentId: targetFolderId } : folder
    );
    libraryNotice.value = targetFolderId
      ? `${group.label} 已移入 ${folderById(targetFolderId)?.label ?? '文件夹'}`
      : `${group.label} 已移到根目录`;
    return true;
  }

  const keys = uniqueMemberKeys(group);
  const keySet = new Set(keys);
  libraryFolders.value = libraryFolders.value.map((folder) => {
    const withoutMovedKeys = folder.keys.filter((key) => !keySet.has(key));
    if (folder.id !== targetFolderId) return { ...folder, keys: withoutMovedKeys };
    return { ...folder, keys: [...withoutMovedKeys, ...keys] };
  });
  libraryNotice.value = targetFolderId
    ? `${group.label} 已移入 ${folderById(targetFolderId)?.label ?? '文件夹'}`
    : `${group.label} 已移到根目录`;
  return true;
}

function dragOverFolder(event: DragEvent, group: PacketGroup): void {
  if (group.kind !== 'folder') return;
  if (!canMoveGroupToFolder(draggingGroup.value, group.firstKey)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropTargetKey.value = `folder:${group.firstKey}`;
}

function dragLeaveFolder(group: PacketGroup): void {
  if (dropTargetKey.value === `folder:${group.firstKey}`) dropTargetKey.value = null;
}

function dragOverParentFolder(event: DragEvent): void {
  if (!currentFolder.value) return;
  const parentId = folderParentId(currentFolder.value);
  if (!canMoveGroupToFolder(draggingGroup.value, parentId)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropTargetKey.value = 'parent';
}

function dragLeaveParentFolder(): void {
  if (dropTargetKey.value === 'parent') dropTargetKey.value = null;
}

function dragOverRootFolder(event: DragEvent): void {
  if (!canMoveGroupToFolder(draggingGroup.value, null)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropTargetKey.value = 'root';
}

function dragLeaveRootFolder(): void {
  if (dropTargetKey.value === 'root') dropTargetKey.value = null;
}

function folderDropKey(folderId: string | null): string {
  return folderId === null ? 'root' : `folder:${folderId}`;
}

function dragOverBreadcrumbFolder(event: DragEvent, folderId: string | null): void {
  if (!canMoveGroupToFolder(draggingGroup.value, folderId)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropTargetKey.value = folderDropKey(folderId);
}

function dragLeaveBreadcrumbFolder(folderId: string | null): void {
  if (dropTargetKey.value === folderDropKey(folderId)) dropTargetKey.value = null;
}

function dropOnBreadcrumbFolder(event: DragEvent, folderId: string | null): void {
  const source = draggingGroup.value;
  if (!source || !canMoveGroupToFolder(source, folderId)) return;
  event.preventDefault();
  event.stopPropagation();
  moveGroupToFolder(source, folderId);
  endDrag();
}

function dropOnFolder(group: PacketGroup): void {
  const source = draggingGroup.value;
  if (!source || group.kind !== 'folder') return;
  moveGroupToFolder(source, group.firstKey);
  endDrag();
}

function dropOnParentFolder(): void {
  const source = draggingGroup.value;
  if (!source || !currentFolder.value) return;
  moveGroupToFolder(source, folderParentId(currentFolder.value));
  endDrag();
}

function dropOnRootFolder(): void {
  const source = draggingGroup.value;
  if (!source) return;
  moveGroupToFolder(source, null);
  endDrag();
}

function startPointerDrag(event: PointerEvent, group: PacketGroup): void {
  if (event.button !== 0) return;
  const source = event.currentTarget;
  if (!(source instanceof HTMLElement)) return;
  pointerDragState = {
    group,
    startX: event.clientX,
    startY: event.clientY,
    pointerId: event.pointerId,
    source,
    active: false,
  };
  source.setPointerCapture?.(event.pointerId);
  window.addEventListener('pointermove', handlePointerDragMove);
  window.addEventListener('pointerup', handlePointerDragUp, { once: true });
  window.addEventListener('pointercancel', cancelPointerDrag, { once: true });
}

function handlePointerDragMove(event: PointerEvent): void {
  if (!pointerDragState) return;
  const deltaX = event.clientX - pointerDragState.startX;
  const deltaY = event.clientY - pointerDragState.startY;
  if (!pointerDragState.active && Math.hypot(deltaX, deltaY) < 6) return;

  pointerDragState.active = true;
  draggingGroup.value = pointerDragState.group;
  dragPreview.value = {
    group: pointerDragState.group,
    x: event.clientX,
    y: event.clientY,
  };
  event.preventDefault();

  const target = pointerDropTarget(event.clientX, event.clientY);
  if (!target) {
    dropTargetKey.value = null;
    return;
  }
  if (target.kind === 'root') {
    dropTargetKey.value = 'root';
  } else {
    dropTargetKey.value = target.kind === 'parent' ? 'parent' : `folder:${target.folderId}`;
  }
}

function handlePointerDragUp(event: PointerEvent): void {
  window.removeEventListener('pointermove', handlePointerDragMove);
  window.removeEventListener('pointercancel', cancelPointerDrag);
  if (!pointerDragState) return;

  const state = pointerDragState;
  releasePointerDrag(state);
  pointerDragState = null;
  if (!state.active) return;

  event.preventDefault();
  suppressDragClick();
  const target = pointerDropTarget(event.clientX, event.clientY);
  if (target?.kind === 'root') {
    moveGroupToFolder(state.group, null);
  } else if (target?.kind === 'parent' && currentFolder.value) {
    moveGroupToFolder(state.group, folderParentId(currentFolder.value));
  } else if (target?.kind === 'folder') {
    moveGroupToFolder(state.group, target.folderId);
  }
  endDrag();
}

function cancelPointerDrag(): void {
  window.removeEventListener('pointermove', handlePointerDragMove);
  window.removeEventListener('pointerup', handlePointerDragUp);
  if (pointerDragState) releasePointerDrag(pointerDragState);
  pointerDragState = null;
  endDrag();
}

function releasePointerDrag(state: PointerDragState): void {
  if (state.source.hasPointerCapture?.(state.pointerId)) {
    state.source.releasePointerCapture(state.pointerId);
  }
}

function suppressDragClick(): void {
  suppressNextClick.value = true;
  window.setTimeout(() => {
    suppressNextClick.value = false;
  }, 250);
}

function pointerDropTarget(
  x: number,
  y: number
): { kind: 'root' } | { kind: 'parent' } | { kind: 'folder'; folderId: string } | null {
  const element = document.elementFromPoint(x, y);
  const rootTarget = element?.closest<HTMLElement>('[data-root-drop="true"]');
  if (rootTarget && canMoveGroupToFolder(draggingGroup.value, null)) {
    return { kind: 'root' };
  }

  const parentTarget = element?.closest<HTMLElement>('[data-parent-drop="true"]');
  if (parentTarget && currentFolder.value) {
    const parentId = folderParentId(currentFolder.value);
    if (canMoveGroupToFolder(draggingGroup.value, parentId)) return { kind: 'parent' };
  }

  const folderTarget = element?.closest<HTMLElement>('[data-folder-drop-id]');
  const folderId = folderTarget?.dataset.folderDropId;
  if (folderId && canMoveGroupToFolder(draggingGroup.value, folderId)) {
    return { kind: 'folder', folderId };
  }
  return null;
}

function localLaunchIds(group: PacketGroup): string[] {
  const runningLaunches = (launcherStatus.value?.launches ?? []).filter((launch) => launch.status === 'running');
  const launchIds = new Set<string>();
  const runningIds = new Set(runningLaunches.map((launch) => launch.id));

  for (const member of group.members) {
    if (member.localLaunchId && runningIds.has(member.localLaunchId)) launchIds.add(member.localLaunchId);

    const matchId = member.key.split('@')[0];
    if (matchId.startsWith('local-standalone-')) {
      const launchId = matchId.slice('local-standalone-'.length);
      if (runningIds.has(launchId)) launchIds.add(launchId);
    }

    const launchPid = member.localLaunchPid ?? pidFromMatchId(matchId);
    if (launchPid != null) {
      const launch = runningLaunches.find((candidate) => candidate.pid === launchPid);
      if (launch) launchIds.add(launch.id);
    }
  }

  return [...launchIds];
}

function hasLocalLaunch(group: PacketGroup): boolean {
  return localLaunchIds(group).length > 0;
}

function pidFromMatchId(matchId: string): number | undefined {
  const match = matchId.match(/(?:^|[-_])(\d+)$/);
  const pid = Number(match?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function setTargetMatchCount(value: number): void {
  if (!Number.isFinite(value)) {
    targetMatchCount.value = 1;
    return;
  }
  targetMatchCount.value = Math.round(Math.min(MAX_TARGET_MATCHES, Math.max(1, value)));
}

function stepTargetMatchCount(delta: number): void {
  setTargetMatchCount(targetMatchCount.value + delta);
}

function setParallelWorkerCount(value: number): void {
  if (!Number.isFinite(value)) {
    parallelWorkerCount.value = 1;
    return;
  }
  parallelWorkerCount.value = Math.round(Math.min(parallelLimit.value, Math.max(1, value)));
}

function stepParallelWorkerCount(delta: number): void {
  setParallelWorkerCount(parallelWorkerCount.value + delta);
}

function setRoundSeed(value: number): void {
  if (!Number.isFinite(value)) {
    roundSeed.value = 1;
    return;
  }
  roundSeed.value = Math.max(1, Math.min(9999, Math.round(value)));
}

async function launchMatches(): Promise<void> {
  if (!launcherReady.value) return;
  const match = selectedHeadlessMatch.value;
  if (!match) return;
  setRoundSeed(roundSeed.value);
  try {
    const response = await launchHeadlessMatches({
      targetMatches: 1,
      parallelism: 1,
      autoSave: autoSaveReplays.value,
      force: resourceLimited.value,
      match,
    });
    if (!response.ok) {
      libraryNotice.value = response.error ?? 'Launch failed';
      return;
    }
    libraryNotice.value = `Custom match · ${response.launched.length} worker`;
  } catch (err) {
    libraryNotice.value = err instanceof Error ? err.message : String(err);
  }
}

async function stopLaunchIds(ids: string[], label: string): Promise<boolean> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0 || launchStopBusy.value) return false;
  launchStopBusy.value = true;
  try {
    await stopHeadlessLaunches(uniqueIds);
    libraryNotice.value = `${label} 已停止`;
    return true;
  } catch (err) {
    libraryNotice.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    launchStopBusy.value = false;
  }
}

async function stopRunningBatch(): Promise<void> {
  const batch = runningBatch.value;
  if (!batch) return;
  await stopLaunchIds(batch.launchIds, `批次 ${batch.completedMatches}/${batch.targetMatches}`);
}

function toggleDesktopSettings(): void {
  const nextOpen = !desktopSettingsOpen.value;
  desktopSettingsOpen.value = nextOpen;
  if (nextOpen) {
    void loadDesktopMonitorSettings();
    void loadDesktopLaunchSettings();
  }
}

function closeTransientUi(): void {
  desktopSettingsOpen.value = false;
}

function createEmptyFolder(): void {
  upsertFolder(`文件夹 ${libraryFolders.value.length + 1}`, [], currentFolderId.value);
  libraryNotice.value = '已新建文件夹';
}

function renameContextGroup(group: PacketGroup): void {
  if (!group || group.kind !== 'folder') return;
  const next = window.prompt('文件夹名称', group.label)?.trim();
  if (!next) return;
  libraryFolders.value = libraryFolders.value.map((folder) =>
    folder.id === group.firstKey ? { ...folder, label: next } : folder
  );
  libraryNotice.value = `${group.label} 已重命名`;
}

async function stopContextGroup(group: PacketGroup): Promise<void> {
  if (!group) return;
  const ids = localLaunchIds(group);
  await stopLaunchIds(ids, group.label);
}

async function deleteContextGroup(group: PacketGroup): Promise<void> {
  if (!group) return;
  if (hasLocalLaunch(group)) {
    await stopContextGroup(group);
    return;
  }
  if (group.kind === 'folder') {
    const removedFolderIds = folderDescendantIds(group.firstKey);
    removedFolderIds.add(group.firstKey);
    const deletedFolder = folderById(group.firstKey);
    libraryFolders.value = libraryFolders.value.filter((folder) => !removedFolderIds.has(folder.id));
    if (currentFolderId.value && removedFolderIds.has(currentFolderId.value)) {
      currentFolderId.value = deletedFolder ? folderParentId(deletedFolder) : null;
    }
    if (group.members.some((m) => m.key === focusedKey.value)) focusedKey.value = null;
    libraryNotice.value = `${group.label} 已删除`;
    return;
  }
  const next = new Set(removedKeys.value);
  for (const member of group.members) next.add(member.key);
  removedKeys.value = next;
  libraryFolders.value = libraryFolders.value
    .map((folder) => ({
      ...folder,
      keys: folder.keys.filter((key) => !next.has(key)),
    }));
  if (group.members.some((m) => m.key === focusedKey.value)) focusedKey.value = null;
  libraryNotice.value = `${group.label} 已删除`;
}

function mergeContextGroup(group: PacketGroup): void {
  if (!group) return;
  const activeGroup = packetGroups.value.find((candidate) => groupActive(candidate) && candidate.firstKey !== group.firstKey);
  const keys = uniqueKeys([...(activeGroup?.members ?? []), ...group.members]);
  upsertFolder(`合并 ${libraryFolders.value.length + 1}`, keys, currentFolderId.value);
  libraryNotice.value = activeGroup
    ? `${group.label} 已与 ${activeGroup.label} 合并`
    : `${group.label} 已准备合并`;
}

function folderContextGroup(group: PacketGroup): void {
  if (!group) return;
  const folder = upsertFolder(`文件夹 ${libraryFolders.value.length + 1}`, [], currentFolderId.value);
  moveGroupToFolder(group, folder.id);
  libraryNotice.value = `${group.label} 已放入文件夹`;
}

function openContextFolder(group: PacketGroup): void {
  if (!group || group.kind !== 'folder') return;
  currentFolderId.value = group.firstKey;
  focusedKey.value = null;
}

function moveContextGroupToParent(group: PacketGroup): void {
  if (!group || !currentFolder.value) return;
  moveGroupToFolder(group, folderParentId(currentFolder.value));
}

function moveContextGroupToRoot(group: PacketGroup): void {
  if (!group) return;
  moveGroupToFolder(group, null);
}

function uniqueKeys(members: MatchView[]): string[] {
  return [...new Set(members.map((member) => member.key))];
}

function upsertFolder(label: string, keys: string[], parentId: string | null = currentFolderId.value): LibraryFolder {
  const folder: LibraryFolder = {
    id: `folder-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    label,
    keys,
    parentId,
  };
  const keySet = new Set(keys);
  libraryFolders.value = [
    ...libraryFolders.value.map((existing) => ({
      ...existing,
      keys: existing.keys.filter((key) => !keySet.has(key)),
    })),
    folder,
  ];
  return folder;
}

onMounted(() => {
  scene = new DioramaScene(host.value!, {
    onFocusChange: (key) => (focusedKey.value = key),
    onPerformanceStats: (stats) => {
      performanceStats.value = stats;
    },
    onActiveKeysChange: (keys) => setActiveKeys(keys),
  });
  start();
  void loadDesktopMonitorSettings();
  void loadDesktopLaunchSettings();
});

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', handlePointerDragMove);
  window.removeEventListener('pointerup', handlePointerDragUp);
  window.removeEventListener('pointercancel', cancelPointerDrag);
  scene?.dispose();
  scene = null;
});
</script>

<template>
  <div class="dockapp" :class="{ focused: focusedKey !== null }" @click="closeTransientUi">
    <aside class="dock-list" aria-label="Desktop navigation" @click.stop>
      <div class="dock-brand">
        <strong>Gestalt<span>·</span>System</strong>
        <small class="dock-agent" :class="{ on: connected }">{{ connected ? 'Local service' : 'Starting service' }}</small>
      </div>

      <TabsRoot v-model="sidebarMode" class="dock-sidebar-tabs">
        <TabsList class="dock-nav-rail" aria-label="Sidebar sections">
          <TabsTrigger class="dock-rail-tab" value="files">
            <span>文件</span>
            <small>{{ visibleFileCount }}</small>
          </TabsTrigger>
          <TabsTrigger class="dock-rail-tab" value="matchmaking">
            <span>对局</span>
            <small>{{ selectedRound.label }}</small>
          </TabsTrigger>
          <TabsTrigger class="dock-rail-tab" value="teams">
            <span>配队</span>
            <small>{{ formatCost(selectedTeamCost) }}</small>
          </TabsTrigger>
        </TabsList>

        <div class="dock-workspace" @click.stop>
          <TabsContent value="files" class="dock-files" aria-label="Files and live matches">
            <div class="dock-section-head">
              <strong>录像库</strong>
              <small>{{ folderCount }} folders · {{ hiddenFileCount }} hidden · {{ libraryNotice }}</small>
            </div>

            <div class="file-browser">
              <section class="file-column" aria-label="Replay packets">
                <div class="file-tools">
                  <button type="button" title="新建文件夹" @click.stop="createEmptyFolder">新建</button>
                  <button
                    type="button"
                    title="移到根目录"
                    data-root-drop="true"
                    :class="{ drop: dropTargetKey === 'root' }"
                    :disabled="currentFolderId === null"
                    @click.stop="goToFolder(null)"
                    @dragover="dragOverRootFolder"
                    @dragleave="dragLeaveRootFolder"
                    @drop.prevent.stop="dropOnRootFolder"
                  >
                    根
                  </button>
                  <button
                    type="button"
                    title="移到上一级"
                    data-parent-drop="true"
                    :class="{ drop: dropTargetKey === 'parent' }"
                    :disabled="currentFolderId === null"
                    @click.stop="goUpFolder"
                    @dragover="dragOverParentFolder"
                    @dragleave="dragLeaveParentFolder"
                    @drop.prevent.stop="dropOnParentFolder"
                  >
                    上级
                  </button>
                </div>

                <nav class="file-breadcrumbs" :title="currentFolderPath" aria-label="Current folder">
                  <template v-for="(crumb, index) in currentFolderCrumbs" :key="crumb.id ?? 'root'">
                    <button
                      type="button"
                      :class="{ active: crumb.id === currentFolderId, drop: dropTargetKey === folderDropKey(crumb.id) }"
                      :data-root-drop="crumb.id === null ? 'true' : undefined"
                      :data-folder-drop-id="crumb.id ?? undefined"
                      @click.stop="goToFolder(crumb.id)"
                      @dragover="dragOverBreadcrumbFolder($event, crumb.id)"
                      @dragleave="dragLeaveBreadcrumbFolder(crumb.id)"
                      @drop="dropOnBreadcrumbFolder($event, crumb.id)"
                    >
                      {{ crumb.label }}
                    </button>
                    <span v-if="index < currentFolderCrumbs.length - 1">/</span>
                  </template>
                </nav>

                <ScrollAreaRoot class="dock-scroll-root" type="auto">
                  <ScrollAreaViewport class="dock-scroll-viewport">
                    <div class="dock-scroll">
                      <div v-if="packetGroups.length === 0" class="file-empty">当前文件夹为空</div>
                      <ContextMenuRoot v-for="group in packetGroups" :key="group.firstKey">
                        <ContextMenuTrigger as-child>
                          <div
                            class="dock-match-shell"
                            :class="{
                              active: groupActive(group),
                              folder: group.kind === 'folder',
                              dragging: draggingGroup?.firstKey === group.firstKey,
                              drop: dropTargetKey === `folder:${group.firstKey}`,
                            }"
                            :data-folder-drop-id="group.kind === 'folder' ? group.firstKey : undefined"
                            @dragover="dragOverFolder($event, group)"
                            @dragleave="dragLeaveFolder(group)"
                            @drop.prevent.stop="dropOnFolder(group)"
                          >
                            <button
                              class="dock-match"
                              type="button"
                              @click.stop="focusGroup(group)"
                              @pointerdown="startPointerDrag($event, group)"
                            >
                              <span class="file-icon" :data-kind="fileIconKind(group)" aria-hidden="true">
                                <svg
                                  v-if="fileIconKind(group) === 'folder'"
                                  viewBox="0 0 24 24"
                                  focusable="false"
                                >
                                  <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
                                </svg>
                                <svg
                                  v-else-if="fileIconKind(group) === 'live'"
                                  viewBox="0 0 24 24"
                                  focusable="false"
                                >
                                  <circle cx="12" cy="12" r="2.2" />
                                  <path d="M8.2 8.6a5.2 5.2 0 0 0 0 6.8M15.8 8.6a5.2 5.2 0 0 1 0 6.8" />
                                  <path d="M5.3 6a9 9 0 0 0 0 12M18.7 6a9 9 0 0 1 0 12" />
                                </svg>
                                <svg v-else viewBox="0 0 24 24" focusable="false">
                                  <rect x="4" y="5" width="16" height="14" rx="2" />
                                  <path d="M8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4" />
                                </svg>
                              </span>
                              <span class="dock-match-copy">
                                <strong>{{ group.label }}</strong>
                                <small>{{ groupSubtitle(group) }}</small>
                              </span>
                            </button>
                            <button
                              v-if="hasLocalLaunch(group)"
                              class="dock-stop"
                              type="button"
                              title="停止对局"
                              aria-label="停止对局"
                              :disabled="launchStopBusy"
                              @click.stop="stopContextGroup(group)"
                              @pointerdown.stop
                            >
                              <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                                <rect x="7" y="7" width="10" height="10" rx="1.5" />
                              </svg>
                            </button>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuPortal>
                          <ContextMenuContent class="dock-context" :collision-padding="8">
                            <ContextMenuLabel class="dock-context-label">{{ group.label }}</ContextMenuLabel>
                            <ContextMenuItem
                              v-if="group.kind === 'folder'"
                              class="dock-context-item"
                              @select="openContextFolder(group)"
                            >
                              打开
                            </ContextMenuItem>
                            <ContextMenuItem
                              v-if="group.kind === 'folder'"
                              class="dock-context-item"
                              @select="renameContextGroup(group)"
                            >
                              重命名
                            </ContextMenuItem>
                            <ContextMenuSeparator class="dock-context-separator" />
                            <ContextMenuItem
                              class="dock-context-item"
                              :disabled="currentFolderId === null"
                              @select="moveContextGroupToParent(group)"
                            >
                              移出到上一级
                            </ContextMenuItem>
                            <ContextMenuItem
                              class="dock-context-item"
                              :disabled="!canMoveGroupToFolder(group, null)"
                              @select="moveContextGroupToRoot(group)"
                            >
                              移到根目录
                            </ContextMenuItem>
                            <ContextMenuItem class="dock-context-item" @select="folderContextGroup(group)">
                              移入新文件夹
                            </ContextMenuItem>
                            <ContextMenuItem class="dock-context-item" @select="mergeContextGroup(group)">
                              合并
                            </ContextMenuItem>
                            <ContextMenuSeparator class="dock-context-separator" />
                            <ContextMenuItem
                              v-if="hasLocalLaunch(group)"
                              class="dock-context-item danger"
                              @select="stopContextGroup(group)"
                            >
                              停止对局
                            </ContextMenuItem>
                            <ContextMenuItem
                              v-else
                              class="dock-context-item danger"
                              @select="deleteContextGroup(group)"
                            >
                              删除
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenuPortal>
                      </ContextMenuRoot>
                    </div>
                  </ScrollAreaViewport>
                  <ScrollAreaScrollbar class="dock-scrollbar" orientation="vertical">
                    <ScrollAreaThumb class="dock-scrollbar-thumb" />
                  </ScrollAreaScrollbar>
                </ScrollAreaRoot>
              </section>

              <section v-if="selectedReplayMembers.length > 1" class="file-replay-column" aria-label="Packet replays">
                <div class="level-head">
                  <strong>{{ selectedFileGroup?.label ?? '录像' }}</strong>
                  <small>{{ selectedReplayMembers.length > 1 ? `${selectedReplayMembers.length} records` : 'No packet selected' }}</small>
                </div>
                <div class="replay-list">
                  <button
                    v-for="member in selectedReplayMembers"
                    :key="member.key"
                    type="button"
                    class="replay-row"
                    :class="{ active: member.key === focusedKey }"
                    @click.stop="focusedKey = member.key"
                  >
                    <span>{{ member.label.replace(/^.*?Iter\s*/i, '#') }}</span>
                    <small>{{ member.playerCount != null ? `${member.playerCount}p · ` : '' }}{{ member.status }}</small>
                  </button>
                </div>
              </section>
            </div>
          </TabsContent>

          <TabsContent value="matchmaking" class="dock-matchmaking" aria-label="Match setup">
            <div class="dock-section-head">
              <strong>对局启动</strong>
              <small>{{ selectedMap.label }} · {{ selectedRound.label }} · {{ selectedStrategy.label }}</small>
            </div>

            <div class="match-setup-grid">
              <section class="match-primary" aria-label="Launch summary">
                <button
                  class="launch-primary"
                  :class="{ stop: runningBatch }"
                  type="button"
                  :disabled="runningBatch ? launchStopBusy : !launcherReady"
                  @click.stop="runningBatch ? stopRunningBatch() : launchMatches()"
                >
                  {{ runningBatch ? (launchStopBusy ? 'Stopping' : 'Stop match') : (launcherBusy ? 'Launching' : 'Launch custom') }}
                </button>

                <dl class="match-summary">
                  <div>
                    <dt>地图</dt>
                    <dd>{{ selectedMap.label }}</dd>
                    <small>{{ selectedRound.label }} · Seed {{ roundSeed }}</small>
                  </div>
                  <div>
                    <dt>红方</dt>
                    <dd>{{ redTeamDraft?.label ?? 'Red' }}</dd>
                    <small>{{ formatCost(redTeamCost) }}</small>
                  </div>
                  <div>
                    <dt>蓝方</dt>
                    <dd>{{ blueTeamDraft?.label ?? 'Blue' }}</dd>
                    <small>{{ formatCost(blueTeamCost) }}</small>
                  </div>
                  <div>
                    <dt>策略</dt>
                    <dd>{{ selectedStrategy.label }}</dd>
                    <small>{{ selectedStrategy.detail }}</small>
                  </div>
                </dl>

                <div class="launch-controls">
                  <div class="launch-count">
                    <span>Target</span>
                    <button type="button" @click.stop="stepTargetMatchCount(-1)">-</button>
                    <input
                      :value="targetMatchCount"
                      type="number"
                      min="1"
                      :max="MAX_TARGET_MATCHES"
                      inputmode="numeric"
                      @click.stop
                      @change="setTargetMatchCount(Number(($event.target as HTMLInputElement).value))"
                    />
                    <button type="button" @click.stop="stepTargetMatchCount(1)">+</button>
                  </div>
                  <div class="launch-count">
                    <span>Workers</span>
                    <button type="button" @click.stop="stepParallelWorkerCount(-1)">-</button>
                    <input
                      :value="parallelWorkerCount"
                      type="number"
                      min="1"
                      :max="parallelLimit"
                      inputmode="numeric"
                      @click.stop
                      @change="setParallelWorkerCount(Number(($event.target as HTMLInputElement).value))"
                    />
                    <button type="button" @click.stop="stepParallelWorkerCount(1)">+</button>
                  </div>
                </div>

                <div class="launch-foot">
                  <label class="save-toggle">
                    <input v-model="autoSaveReplays" type="checkbox" />
                    <span>{{ autoSaveReplays ? 'Autosave on' : 'Autosave off' }}</span>
                  </label>
                  <small>{{ launchHint }}</small>
                </div>

                <div class="roster-preview">
                  <span>Roster</span>
                  <code :title="selectedRosterSpec">{{ selectedRosterSpec }}</code>
                </div>
              </section>

              <section class="match-detail-panel" aria-label="Match detail options">
                <div class="match-detail-column" aria-label="Map and round">
                  <div class="level-head">
                    <strong>地图 / 轮次</strong>
                    <small>{{ selectedMap.detail }}</small>
                  </div>
                  <div class="choice-grid map-choice-grid">
                    <button
                      v-for="option in MAP_OPTIONS"
                      :key="option.id"
                      type="button"
                      class="choice-row"
                      :class="{ active: option.id === selectedMapId }"
                      @click.stop="selectMap(option.id)"
                    >
                      <span>{{ option.label }}</span>
                      <small>{{ option.detail }}</small>
                    </button>
                  </div>
                  <div class="round-grid">
                    <button
                      v-for="option in ROUND_OPTIONS"
                      :key="option.id"
                      type="button"
                      :class="{ active: option.id === selectedRoundCount }"
                      @click.stop="selectRound(option.id)"
                    >
                      {{ option.label }}
                    </button>
                  </div>
                  <label class="compact-field">
                    <span>Seed</span>
                    <input
                      :value="roundSeed"
                      type="number"
                      min="1"
                      max="9999"
                      inputmode="numeric"
                      @click.stop
                      @change="setRoundSeed(Number(($event.target as HTMLInputElement).value))"
                    />
                  </label>
                </div>

                <div class="match-detail-column" aria-label="Teams and strategy">
                  <div class="level-head">
                    <strong>团队 / 策略</strong>
                    <small>{{ formatCost(redTeamCost) }} vs {{ formatCost(blueTeamCost) }}</small>
                  </div>
                  <div class="team-pair-grid">
                    <label class="select-field red">
                      <span>Red</span>
                      <select v-model="redTeamDraftId" @click.stop>
                        <option v-for="team in teamDrafts" :key="team.id" :value="team.id">
                          {{ team.label }} · {{ formatCost(teamDraftCost(team)) }}
                        </option>
                      </select>
                    </label>
                    <label class="select-field blue">
                      <span>Blue</span>
                      <select v-model="blueTeamDraftId" @click.stop>
                        <option v-for="team in teamDrafts" :key="team.id" :value="team.id">
                          {{ team.label }} · {{ formatCost(teamDraftCost(team)) }}
                        </option>
                      </select>
                    </label>
                  </div>
                  <div class="strategy-grid">
                    <button
                      v-for="option in STRATEGY_OPTIONS"
                      :key="option.id"
                      type="button"
                      :class="{ active: pairingMode === option.id }"
                      @click.stop="pairingMode = option.id"
                    >
                      <span>{{ option.label }}</span>
                      <small>{{ option.detail }}</small>
                    </button>
                  </div>
                </div>
              </section>

            </div>
          </TabsContent>

          <TabsContent value="teams" class="dock-teams" aria-label="Team builder">
            <div class="dock-section-head">
              <strong>配队</strong>
              <small>{{ selectedMap.label }} · {{ selectedTeamDraft?.label ?? 'No team' }} · {{ formatCost(selectedTeamCost) }}</small>
            </div>

            <div class="team-builder">
              <section class="team-menu" aria-label="Teams">
                <button class="team-new" type="button" @click.stop="createTeamDraft">新建团队</button>
                <div class="choice-stack">
                  <button
                    v-for="team in teamDrafts"
                    :key="team.id"
                    type="button"
                    class="team-row"
                    :class="{ active: team.id === selectedTeamDraftId, [team.tone]: true }"
                    @click.stop="selectTeamDraft(team.id)"
                  >
                    <span>{{ team.label }}</span>
                    <small>{{ formatCost(teamDraftCost(team)) }}</small>
                  </button>
                </div>
              </section>

              <section v-if="selectedTeamDraft" class="slot-menu" aria-label="Team slots">
                <div class="level-head">
                  <strong>{{ selectedTeamDraft.label }}</strong>
                  <small>{{ formatCost(selectedTeamCost) }}</small>
                </div>
                <div class="slot-list">
                  <article
                    v-for="slot in selectedTeamDraft.slots"
                    :key="slot.teamNumber"
                    class="slot-row"
                    :class="{ active: selectedTeamDraft.id === editingSlotTeamId && slot.teamNumber === editingSlotNumber }"
                    @click.stop="editSlotDetails(selectedTeamDraft, slot)"
                  >
                    <div class="slot-copy">
                      <strong>{{ slotBlueprint(slot.teamNumber).shortLabel }}</strong>
                      <small>{{ careerName(slot.careerId) }}</small>
                    </div>
                    <select
                      :value="slot.entityType"
                      @click.stop
                      @change="setSlotConstruct(slot, Number(($event.target as HTMLSelectElement).value))"
                    >
                      <option
                        v-for="construct in constructOptions(slot.careerId)"
                        :key="construct.entityType"
                        :value="construct.entityType"
                      >
                        {{ construct.name }}
                      </option>
                    </select>
                    <strong class="slot-cost">{{ formatCost(slotCost(slot)) }}</strong>
                    <button class="slot-inspect-button" type="button" @click.stop="editSlotDetails(selectedTeamDraft, slot)">
                      参数
                    </button>
                  </article>
                </div>
              </section>

              <section v-if="editingSlot" class="slot-detail-menu" aria-label="Slot detail">
                <div class="slot-inspector-head">
                  <div>
                    <strong>{{ constructLabel(editingSlot.entityType) }}</strong>
                    <span>{{ slotBlueprint(editingSlot.teamNumber).label }} · {{ constructTierLabel(editingSlot.entityType) }}</span>
                  </div>
                  <b>{{ formatCost(editingSlotCost) }}</b>
                </div>

                <div class="field-board">
                  <div class="detail-grid two">
                    <label v-if="slotHasPower(editingSlot)" class="param-field">
                      <span>Power</span>
                      <input
                        :value="paramValue(editingSlot, RosterAttrId.CapacityEnergyPowerMax, defaultNumber(editingSlot, 'dischargeW'))"
                        type="number"
                        min="0"
                        max="300"
                        step="10"
                        @change="setParam(editingSlot, RosterAttrId.CapacityEnergyPowerMax, Number(($event.target as HTMLInputElement).value))"
                      />
                    </label>
                    <label v-if="slotHasAmmo(editingSlot)" class="param-field">
                      <span>{{ ammoLabel(editingSlot) }}</span>
                      <input
                        :value="paramValue(editingSlot, ammoAttrId(editingSlot), ammoFallback(editingSlot))"
                        type="number"
                        min="0"
                        :max="ammoMax(editingSlot)"
                        :step="ammoStep(editingSlot)"
                        @change="setParam(editingSlot, ammoAttrId(editingSlot), Number(($event.target as HTMLInputElement).value))"
                      />
                    </label>
                    <label v-if="fireInterval(editingSlot) > 0" class="param-field">
                      <span>Interval</span>
                      <input
                        :value="fireInterval(editingSlot)"
                        type="number"
                        min="20"
                        max="240"
                        step="1"
                        @change="setFireInterval(editingSlot, Number(($event.target as HTMLInputElement).value))"
                      />
                    </label>
                    <label class="param-field">
                      <span>Spread max</span>
                      <input
                        :value="editingSlot.spread?.maxEnclosing ?? 0"
                        type="number"
                        min="0"
                        max="120"
                        step="1"
                        @change="setSpreadValue(editingSlot, 'maxEnclosing', Number(($event.target as HTMLInputElement).value))"
                      />
                    </label>
                    <label class="param-field">
                      <span>Spread min</span>
                      <input
                        :value="editingSlot.spread?.minEnclosing ?? 0"
                        type="number"
                        min="0"
                        max="120"
                        step="1"
                        @change="setSpreadValue(editingSlot, 'minEnclosing', Number(($event.target as HTMLInputElement).value))"
                      />
                    </label>
                    <label class="param-field">
                      <span>Move spread</span>
                      <input
                        :value="paramValue(editingSlot, RosterAttrId.ShooterSpeedSpreadPara, 0)"
                        type="number"
                        min="0"
                        max="120"
                        step="1"
                        @change="setParam(editingSlot, RosterAttrId.ShooterSpeedSpreadPara, Number(($event.target as HTMLInputElement).value))"
                      />
                    </label>
                  </div>
                </div>

                <div v-if="slotSupportsEngineer(editingSlot)" class="field-board">
                  <span class="field-label">Assembly level</span>
                  <div class="segmented">
                    <button
                      v-for="level in [1, 2, 3, 4]"
                      :key="level"
                      type="button"
                      :class="{ active: editingSlot.engineer?.maxAssemblyLevel === level }"
                      @click.stop="setEngineerLevel(editingSlot, level)"
                    >
                      L{{ level }}
                    </button>
                  </div>
                  <span class="field-label">Core pool</span>
                  <div class="segmented">
                    <button
                      v-for="pool in [2, 4, 6]"
                      :key="pool"
                      type="button"
                      :class="{ active: editingSlot.engineer?.corePool === pool }"
                      @click.stop="setEngineerPool(editingSlot, pool)"
                    >
                      {{ pool }}C
                    </button>
                  </div>
                </div>

                <div v-if="slotSupportsRadar(editingSlot)" class="field-board">
                  <label class="range-field">
                    <span>Radar range · {{ editingSlot.radar?.maxLockRangeM ?? 18 }}m</span>
                    <input
                      :value="editingSlot.radar?.maxLockRangeM ?? 18"
                      type="range"
                      min="0"
                      max="40"
                      @input="setRadarRange(editingSlot, Number(($event.target as HTMLInputElement).value))"
                    />
                  </label>
                  <div class="segmented">
                    <button
                      v-for="mode in [0, 1, 2]"
                      :key="mode"
                      type="button"
                      :class="{ active: editingSlot.radar?.detectionMode === mode }"
                      @click.stop="setRadarMode(editingSlot, mode)"
                    >
                      M{{ mode }}
                    </button>
                  </div>
                </div>

                <div v-if="slotSupportsDart(editingSlot)" class="field-board">
                  <label class="save-toggle">
                    <input
                      type="checkbox"
                      :checked="editingSlot.dart != null"
                      @change="toggleDart(editingSlot, ($event.target as HTMLInputElement).checked)"
                    />
                    <span>Dart</span>
                  </label>
                  <div class="toggle-grid">
                    <label>
                      <input
                        type="checkbox"
                        :checked="editingSlot.dart?.canOutpost === true"
                        @change="setDartOutpost(editingSlot, ($event.target as HTMLInputElement).checked)"
                      />
                      <span>Outpost</span>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        :checked="editingSlot.dart?.canBase === true"
                        @change="setDartBase(editingSlot, ($event.target as HTMLInputElement).checked)"
                      />
                      <span>Base</span>
                    </label>
                  </div>
                  <div class="segmented">
                    <button
                      v-for="mode in [0, 1, 2, 3]"
                      :key="mode"
                      type="button"
                      :class="{ active: editingSlot.dart?.maxBaseMode === mode }"
                      @click.stop="setDartBaseMode(editingSlot, mode)"
                    >
                      B{{ mode }}
                    </button>
                  </div>
                </div>

                <div
                  v-if="!slotSupportsEngineer(editingSlot) && !slotSupportsRadar(editingSlot) && !slotSupportsDart(editingSlot)"
                  class="level-empty"
                >
                  通用参数会随 roster 一起下发
                </div>
              </section>
            </div>
          </TabsContent>
        </div>
      </TabsRoot>
    </aside>

    <div
      v-if="dragPreview"
      class="drag-preview"
      :style="{ transform: `translate3d(${dragPreview.x + 10}px, ${dragPreview.y + 10}px, 0)` }"
      aria-hidden="true"
    >
      <span class="file-icon" :data-kind="fileIconKind(dragPreview.group)">
        <svg v-if="fileIconKind(dragPreview.group) === 'folder'" viewBox="0 0 24 24" focusable="false">
          <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
        </svg>
        <svg v-else-if="fileIconKind(dragPreview.group) === 'live'" viewBox="0 0 24 24" focusable="false">
          <circle cx="12" cy="12" r="2.2" />
          <path d="M8.2 8.6a5.2 5.2 0 0 0 0 6.8M15.8 8.6a5.2 5.2 0 0 1 0 6.8" />
          <path d="M5.3 6a9 9 0 0 0 0 12M18.7 6a9 9 0 0 1 0 12" />
        </svg>
        <svg v-else viewBox="0 0 24 24" focusable="false">
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4" />
        </svg>
      </span>
      <span class="drag-preview-copy">{{ dragPreview.group.label }}</span>
    </div>

    <main class="dock-stage">
      <div ref="host" class="dock-canvas" />
      <div class="stage-readout">
        <strong>{{ focused?.label ?? 'Overview' }}</strong>
        <span>{{ Math.round(performanceStats.fps) }} FPS</span>
        <span>{{ performanceStats.activeUnitCount }}/{{ performanceStats.unitCount }} boards</span>
      </div>
      <button
        class="desktop-settings-button"
        type="button"
        title="Desktop settings"
        aria-label="Desktop settings"
        aria-controls="desktop-settings-panel"
        :aria-expanded="desktopSettingsOpen"
        @click.stop="toggleDesktopSettings"
      >
        Settings
      </button>

      <aside v-if="showFpsDebugWindow" class="fps-debug-window" aria-label="Desktop FPS debug window">
        <div class="fps-debug-head">
          <span>FPS debug</span>
          <strong :class="fpsClass">{{ Math.round(performanceStats.fps) }}</strong>
        </div>
        <dl>
          <div>
            <dt>Frame</dt>
            <dd>{{ performanceStats.frameMs.toFixed(1) }} ms</dd>
          </div>
          <div>
            <dt>p95 / max</dt>
            <dd>{{ performanceStats.frameMsP95.toFixed(1) }} / {{ performanceStats.frameMsMax.toFixed(0) }}</dd>
          </div>
          <div>
            <dt>CPU</dt>
            <dd>{{ performanceStats.cpuMs.toFixed(1) }} ms</dd>
          </div>
          <div>
            <dt>GPU</dt>
            <dd>{{ performanceStats.gpuSupported ? `${performanceStats.gpuMs.toFixed(1)} ms` : 'n/a' }}</dd>
          </div>
          <div>
            <dt>Hitches</dt>
            <dd :class="{ bad: performanceStats.longFrames > 0 }">{{ performanceStats.longFrames }}</dd>
          </div>
          <div>
            <dt>Draws</dt>
            <dd>{{ formatCount(performanceStats.drawCalls) }}</dd>
          </div>
          <div class="wide">
            <dt>GPU name</dt>
            <dd :title="performanceStats.gpuRenderer">{{ shortGpu || 'unknown' }}</dd>
          </div>
        </dl>
      </aside>

      <section
        v-if="desktopSettingsOpen"
        id="desktop-settings-panel"
        class="desktop-settings-panel"
        aria-label="Desktop settings"
        @click.stop
      >
        <div class="settings-title">Desktop settings</div>
        <label class="settings-toggle">
          <span class="settings-copy">
            <strong>FPS debug window</strong>
            <small>{{ showFpsDebugWindow ? 'Visible' : 'Hidden' }}</small>
          </span>
          <input v-model="showFpsDebugWindow" type="checkbox" />
          <span class="toggle-track" aria-hidden="true"><i /></span>
        </label>
        <label class="settings-field">
          <span class="settings-copy">
            <strong>停靠屏幕</strong>
            <small>{{ desktopMonitorHint }}</small>
          </span>
          <select
            :value="selectedDesktopMonitorId"
            :disabled="desktopMonitorDisabled"
            @change="handleDesktopMonitorChange"
          >
            <option v-if="desktopMonitors.length === 0" value="">未检测到屏幕</option>
            <option v-for="monitor in desktopMonitors" :key="monitor.id" :value="monitor.id">
              {{ monitor.label }}
            </option>
          </select>
        </label>
        <label class="settings-field">
          <span class="settings-copy">
            <strong>启动源</strong>
            <small>{{ launchSourceHint }}</small>
          </span>
          <select
            :value="launchSource"
            :disabled="launchSourceDisabled"
            @change="handleLaunchSourceChange"
          >
            <option value="standalone">本地 standalone（本仓编译）</option>
            <option value="steam">Steam 安装</option>
          </select>
        </label>
      </section>
    </main>

    <aside class="dock-panel" aria-label="Current match">
      <div class="panel-head">
        <span class="s-dot" :class="{ ghost: !focused }" :data-status="focused?.status ?? 'idle'" />
        <strong>{{ focused?.label ?? 'Free-view sandbox' }}</strong>
      </div>

      <div class="panel-actions">
        <button type="button" :disabled="focusedKey === null" @click="focusedKey = null">Overview</button>
      </div>

      <dl class="panel-stats">
        <div>
          <dt>Robots</dt>
          <dd>{{ robots ?? '—' }}</dd>
        </div>
        <div>
          <dt>Struct</dt>
          <dd>{{ structures ?? '—' }}</dd>
        </div>
        <div>
          <dt>Vehicles</dt>
          <dd>{{ performanceStats.vehicleCount }}</dd>
        </div>
      </dl>
    </aside>
  </div>
</template>

<style scoped>
.dockapp {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: var(--gsm-panel-left) minmax(0, 1fr) var(--gsm-panel-right);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #080d12;
  color: var(--text);
}

.dock-list,
.dock-panel {
  position: relative;
  z-index: var(--gsm-z-panel);
  min-width: 0;
  border-color: rgba(36, 50, 64, 0.85);
  background: rgba(13, 19, 26, 0.94);
  backdrop-filter: blur(10px);
}

.dock-list {
  display: grid;
  grid-template-rows: 26px minmax(0, 1fr);
  gap: 5px;
  min-height: 0;
  width: auto;
  padding: 9px 8px 8px;
  border-right: 1px solid rgba(36, 50, 64, 0.85);
  overflow: visible;
}

.dock-brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  overflow: visible;
}

.dock-brand strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: var(--gsm-fs-label);
  font-weight: 900;
  letter-spacing: 0;
  line-height: var(--gsm-lh-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dock-brand span {
  margin: 0 3px;
  color: var(--accent);
}

.dock-agent {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 5px;
  color: var(--text-dim);
  font-size: var(--gsm-fs-meta);
  font-weight: 800;
  white-space: nowrap;
}

.dock-agent::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--red);
}

.dock-agent.on::before {
  background: #3ec07a;
  box-shadow: 0 0 7px rgba(62, 192, 122, 0.62);
}

.dock-sidebar-tabs {
  position: relative;
  display: grid;
  grid-template-columns: var(--gsm-rail-width) minmax(0, 1fr);
  gap: 7px;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: visible;
}

.dock-nav-rail {
  display: grid;
  grid-auto-rows: var(--gsm-row-lg);
  align-content: start;
  gap: 6px;
  min-width: 0;
}

.dock-rail-tab,
.file-tools button,
.round-grid button,
.segmented button {
  min-width: 0;
  border: 1px solid rgba(54, 77, 98, 0.8);
  border-radius: var(--gsm-radius-md);
  background: var(--gsm-surface-control);
  color: var(--text-dim);
  cursor: pointer;
  font: inherit;
  font-size: var(--gsm-fs-body);
  font-weight: 800;
}

.dock-rail-tab {
  display: grid;
  place-items: center;
  gap: 2px;
  height: var(--gsm-row-lg);
  padding: 5px 3px;
}

.dock-rail-tab span,
.dock-rail-tab small {
  overflow: hidden;
  max-width: 100%;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dock-rail-tab span {
  color: var(--text);
  font-size: var(--gsm-fs-label);
}

.dock-rail-tab small {
  color: var(--text-dim);
  font-size: var(--gsm-fs-caption);
  font-weight: 800;
}

.dock-rail-tab:hover,
.dock-rail-tab[data-state="active"],
.file-tools button:hover:not(:disabled),
.round-grid button:hover,
.round-grid button.active,
.segmented button:hover,
.segmented button.active {
  border-color: rgba(79, 159, 224, 0.82);
  background: rgba(22, 34, 46, 0.94);
  color: var(--text);
}

.dock-workspace {
  position: relative;
  width: auto;
  min-height: 0;
  min-width: 0;
  overflow: visible;
}

.dock-files,
.dock-matchmaking,
.dock-teams {
  display: grid;
  grid-template-rows: 32px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  gap: 7px;
  overflow: visible;
}

.dock-files[data-state="inactive"],
.dock-matchmaking[data-state="inactive"],
.dock-teams[data-state="inactive"] {
  display: none;
}

.dock-section-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: center;
  min-width: 0;
}

.dock-section-head strong,
.dock-section-head small,
.level-head strong,
.level-head small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dock-section-head strong {
  color: var(--text);
  font-size: 15px;
  font-weight: 900;
  line-height: 1.15;
}

.dock-section-head small {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 800;
  line-height: 1.2;
}

.file-browser {
  position: relative;
  display: block;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: visible;
}

.file-column,
.file-replay-column,
.match-primary,
.match-level,
.match-detail-panel,
.match-detail-column,
.launch-strip,
.team-menu,
.slot-menu,
.slot-detail-menu {
  display: grid;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--gsm-border-panel);
  border-radius: var(--gsm-radius-md);
  background: var(--gsm-surface-subtle);
}

.file-column {
  grid-template-rows: var(--gsm-control-xs) var(--gsm-control-xs) minmax(0, 1fr);
  gap: 5px;
  height: 100%;
  padding: 6px;
}

.file-replay-column {
  position: absolute;
  left: calc(100% + var(--gsm-overlay-gap));
  top: 0;
  bottom: 0;
  z-index: var(--gsm-z-overlay);
  grid-template-rows: 38px minmax(0, 1fr);
  gap: 6px;
  width: var(--gsm-overlay-file);
  padding: 6px;
  background: var(--gsm-surface-glass);
  box-shadow: var(--gsm-shadow-overlay);
}

.file-tools {
  display: grid;
  grid-template-columns: 48px 34px 42px;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.file-tools button {
  height: var(--gsm-control-xs);
  padding: 0 4px;
  font-size: var(--gsm-fs-meta);
}

.file-tools button:disabled {
  cursor: default;
  opacity: 0.42;
}

.file-tools button.drop {
  border-color: rgba(62, 192, 122, 0.92);
  background: rgba(20, 65, 42, 0.88);
  color: var(--text);
}

.file-breadcrumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 21px;
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgba(36, 50, 64, 0.62);
  border-radius: var(--gsm-radius-sm);
  padding: 2px 5px;
  background: rgba(8, 13, 18, 0.5);
  color: var(--text-dim);
  font-size: var(--gsm-fs-meta);
}

.file-breadcrumbs button {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 112px;
  overflow: hidden;
  border: 0;
  border-radius: var(--gsm-radius-xs);
  padding: 2px 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font: inherit;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-breadcrumbs button:hover,
.file-breadcrumbs button.active {
  background: rgba(24, 42, 58, 0.8);
  color: var(--text);
}

.file-breadcrumbs button.drop {
  background: rgba(20, 65, 42, 0.88);
  color: var(--text);
}

.level-head {
  display: grid;
  min-width: 0;
  align-content: center;
  gap: 1px;
}

.level-head strong {
  color: var(--text);
  font-size: 14px;
  font-weight: 900;
  line-height: 1.15;
}

.level-head small {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 800;
  line-height: 1.2;
}

.replay-list,
.choice-stack,
.slot-list {
  display: grid;
  align-content: start;
  gap: 5px;
  min-height: 0;
  overflow: auto;
}

.replay-row,
.choice-row,
.team-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  border: 1px solid rgba(36, 50, 64, 0.82);
  border-radius: var(--gsm-radius-md);
  padding: 6px 7px;
  background: rgba(20, 29, 38, 0.72);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.replay-row:hover,
.replay-row.active,
.choice-row:hover,
.choice-row.active,
.team-row:hover,
.team-row.active {
  border-color: rgba(79, 159, 224, 0.82);
  background: rgba(22, 34, 46, 0.94);
}

.replay-row span,
.replay-row small,
.choice-row span,
.choice-row small,
.team-row span,
.team-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay-row span,
.choice-row span,
.team-row span {
  font-size: 13px;
  font-weight: 900;
}

.replay-row small,
.choice-row small,
.team-row small {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 800;
}

.level-empty {
  display: grid;
  place-items: center;
  min-height: 58px;
  border: 1px dashed rgba(54, 77, 98, 0.72);
  border-radius: var(--gsm-radius-md);
  color: var(--text-dim);
  font-size: var(--gsm-fs-body);
  font-weight: 800;
  text-align: center;
}

.match-setup-grid {
  position: relative;
  display: block;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: visible;
}

.match-primary {
  grid-template-rows: 30px minmax(120px, 0.8fr) 60px 38px minmax(34px, auto);
  gap: 8px;
  height: 100%;
  padding: 6px;
}

.match-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  min-height: 0;
  margin: 0;
}

.match-summary div {
  display: grid;
  align-content: center;
  min-width: 0;
  border: 1px solid rgba(36, 50, 64, 0.72);
  border-radius: var(--gsm-radius-md);
  padding: 6px 7px;
  background: rgba(10, 16, 22, 0.64);
}

.match-summary dt,
.match-summary dd,
.match-summary small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.match-summary dt {
  color: var(--text-dim);
  font-size: var(--gsm-fs-caption);
  font-weight: 800;
  text-transform: uppercase;
}

.match-summary dd {
  margin: 0;
  color: var(--text);
  font-size: var(--gsm-fs-label);
  font-weight: 900;
}

.match-summary small {
  color: var(--text-dim);
  font-size: var(--gsm-fs-meta);
  font-weight: 800;
}

.launch-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.roster-preview {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  min-width: 0;
  border: 1px solid rgba(36, 50, 64, 0.72);
  border-radius: var(--gsm-radius-md);
  padding: 5px 6px;
  background: rgba(8, 13, 18, 0.58);
}

.roster-preview span {
  overflow: hidden;
  color: var(--text-dim);
  font-size: var(--gsm-fs-caption);
  font-weight: 900;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.roster-preview code {
  min-width: 0;
  overflow: hidden;
  color: #9fb3c6;
  font-family: var(--gsm-font-mono);
  font-size: var(--gsm-fs-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.match-detail-panel {
  position: absolute;
  left: calc(100% + var(--gsm-overlay-gap));
  top: 0;
  bottom: 0;
  z-index: var(--gsm-z-overlay);
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  width: var(--gsm-overlay-match);
  padding: 7px;
  background: var(--gsm-surface-glass);
  box-shadow: var(--gsm-shadow-overlay);
}

.match-detail-column {
  grid-template-rows: 38px min-content min-content min-content;
  align-content: start;
  gap: 8px;
  padding: 7px;
  background: rgba(8, 13, 18, 0.48);
}

.choice-grid {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.map-choice-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.team-pair-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  min-width: 0;
}

.match-level {
  grid-template-rows: 38px minmax(0, 1fr) 28px 42px;
  gap: 6px;
  padding: 6px;
}

.match-setup-grid > .match-level:first-child {
  height: 100%;
}

.match-setup-grid > .match-level + .match-level {
  position: absolute;
  left: calc(100% + var(--gsm-overlay-gap));
  top: 0;
  bottom: 126px;
  z-index: var(--gsm-z-overlay);
  width: 302px;
  background: var(--gsm-surface-glass);
  box-shadow: var(--gsm-shadow-overlay);
}

.round-grid,
.strategy-grid,
.segmented,
.toggle-grid {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.round-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.round-grid button,
.segmented button {
  height: var(--gsm-control-sm);
  padding: 0 4px;
}

.compact-field,
.select-field,
.range-field {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.compact-field {
  grid-template-columns: 42px minmax(0, 1fr);
  align-items: center;
}

.compact-field span,
.select-field span,
.range-field span {
  overflow: hidden;
  color: var(--text-dim);
  font-size: var(--gsm-fs-caption);
  font-weight: 800;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.compact-field input,
.select-field select,
.slot-row select {
  min-width: 0;
  height: 26px;
  border: 1px solid rgba(36, 50, 64, 0.92);
  border-radius: var(--gsm-radius-sm);
  padding: 0 6px;
  background: rgba(6, 10, 14, 0.82);
  color: var(--text);
  font: inherit;
  font-size: var(--gsm-fs-body);
  font-weight: 800;
}

.compact-field input {
  text-align: center;
}

.strategy-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.strategy-grid button {
  display: grid;
  gap: 1px;
  min-width: 0;
  height: 42px;
  border: 1px solid rgba(54, 77, 98, 0.8);
  border-radius: var(--gsm-radius-md);
  padding: 4px;
  background: var(--gsm-surface-control);
  color: var(--text-dim);
  cursor: pointer;
  font: inherit;
}

.strategy-grid button:hover,
.strategy-grid button.active {
  border-color: rgba(79, 159, 224, 0.82);
  background: rgba(22, 34, 46, 0.94);
  color: var(--text);
}

.strategy-grid span,
.strategy-grid small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.strategy-grid span {
  font-size: var(--gsm-fs-body);
  font-weight: 900;
}

.strategy-grid small {
  font-size: var(--gsm-fs-caption);
  font-weight: 800;
}

.save-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  min-width: 0;
  border: 1px solid rgba(36, 50, 64, 0.72);
  border-radius: var(--gsm-radius-md);
  padding: 0 9px;
  background: rgba(8, 13, 18, 0.48);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
  font-weight: 900;
}

.save-toggle input,
.toggle-grid input {
  width: 15px;
  height: 15px;
  accent-color: #3ec07a;
}

.launch-strip {
  position: absolute;
  left: calc(100% + var(--gsm-overlay-gap));
  bottom: 0;
  z-index: var(--gsm-z-overlay-raised);
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: center;
  gap: 6px;
  width: 302px;
  min-height: 116px;
  padding: 6px;
  background: var(--gsm-surface-glass);
  box-shadow: var(--gsm-shadow-overlay);
}

.launch-primary,
.launch-count button {
  border: 1px solid rgba(54, 77, 98, 0.86);
  border-radius: var(--gsm-radius-md);
  background: rgba(20, 29, 38, 0.86);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: var(--gsm-fs-body);
  font-weight: 800;
}

.launch-primary {
  width: 100%;
  height: var(--gsm-control-sm);
  border-color: rgba(79, 159, 224, 0.82);
  background: linear-gradient(180deg, rgba(37, 95, 136, 0.92), rgba(20, 47, 70, 0.94));
}

.launch-primary.stop {
  border-color: rgba(220, 82, 82, 0.9);
  background: linear-gradient(180deg, rgba(136, 45, 48, 0.92), rgba(70, 24, 30, 0.94));
}

.launch-primary:hover:not(:disabled),
.launch-count button:hover {
  border-color: var(--accent);
  background: rgba(24, 42, 58, 0.96);
}

.launch-primary:disabled,
.launch-count button:disabled {
  cursor: default;
  opacity: 0.46;
}

.launch-count {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px 56px 32px;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.launch-count span {
  overflow: hidden;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 800;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.launch-count button {
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
}

.launch-count input {
  width: 56px;
  height: 32px;
  min-width: 0;
  border: 1px solid rgba(36, 50, 64, 0.92);
  border-radius: var(--gsm-radius-sm);
  background: rgba(6, 10, 14, 0.82);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  font-weight: 900;
  text-align: center;
}

.launch-count input::-webkit-outer-spin-button,
.launch-count input::-webkit-inner-spin-button {
  margin: 0;
  appearance: none;
}

.launch-foot {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--text-dim);
  font-size: var(--gsm-fs-meta);
}

.launch-foot span,
.launch-foot small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.launch-foot span {
  color: #9fd6b7;
  font-weight: 800;
}

.dock-scroll-root {
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.dock-scroll-root :deep(.dock-scroll-viewport) {
  width: 100%;
  height: 100%;
}

.dock-scroll {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-auto-rows: 44px;
  gap: 5px;
  align-content: start;
  min-height: 0;
  padding: 1px 7px 4px 0;
  touch-action: pan-y;
}

.dock-scroll-root :deep(.dock-scrollbar) {
  display: flex;
  width: 6px;
  padding: 1px;
  background: rgba(8, 13, 18, 0.35);
  user-select: none;
}

.dock-scroll-root :deep(.dock-scrollbar-thumb) {
  flex: 1;
  border-radius: 999px;
  background: rgba(72, 96, 119, 0.72);
}

.dock-scroll-root :deep(.dock-scrollbar-thumb:hover) {
  background: rgba(89, 122, 153, 0.9);
}

.file-empty {
  display: grid;
  grid-column: 1 / -1;
  place-items: center;
  min-height: 58px;
  border: 1px dashed rgba(54, 77, 98, 0.72);
  border-radius: var(--gsm-radius-md);
  color: var(--text-dim);
  font-size: var(--gsm-fs-body);
  font-weight: 800;
}

.dock-match-shell {
  position: relative;
  min-width: 0;
  height: 44px;
}

.dock-match {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  height: 44px;
  border: 1px solid rgba(36, 50, 64, 0.78);
  border-radius: var(--gsm-radius-md);
  padding: 5px 8px 5px 5px;
  background: rgba(20, 29, 38, 0.72);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  text-align: left;
  user-select: none;
  touch-action: none;
}

.dock-match-shell:hover .dock-match,
.dock-match-shell.active .dock-match {
  border-color: rgba(79, 159, 224, 0.82);
  background: rgba(22, 34, 46, 0.94);
}

.dock-match-shell.folder .dock-match {
  background: rgba(16, 25, 35, 0.86);
}

.dock-match-shell.dragging .dock-match {
  opacity: 0.48;
}

.dock-match-shell.drop .dock-match {
  border-color: rgba(62, 192, 122, 0.92);
  background: rgba(20, 65, 42, 0.88);
}

.dock-stop {
  position: absolute;
  right: 4px;
  top: 4px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1px solid rgba(220, 82, 82, 0.92);
  border-radius: 5px;
  padding: 0;
  background: rgba(74, 24, 29, 0.94);
  color: #ffd0d0;
  cursor: pointer;
  opacity: 0.88;
  transition: opacity 120ms ease, border-color 120ms ease, background 120ms ease;
}

.dock-match-shell:hover .dock-stop,
.dock-match-shell.active .dock-stop,
.dock-stop:focus-visible {
  opacity: 1;
}

.dock-stop:hover:not(:disabled),
.dock-stop:focus-visible {
  border-color: rgba(248, 113, 113, 0.98);
  background: rgba(116, 33, 39, 0.98);
  outline: none;
}

.dock-stop:disabled {
  cursor: default;
  opacity: 0.42;
}

.dock-stop svg {
  width: 10px;
  height: 10px;
  fill: currentColor;
  stroke: none;
}

.file-icon {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: var(--gsm-control-sm);
  border: 1px solid rgba(65, 89, 111, 0.82);
  border-radius: 7px;
  background: rgba(13, 22, 31, 0.92);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  color: #9ab2c6;
}

.file-icon svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.file-icon[data-kind="folder"] {
  border-color: rgba(83, 135, 115, 0.85);
  background: rgba(16, 35, 31, 0.94);
  color: #9fd6b7;
}

.file-icon[data-kind="replay"] {
  border-color: rgba(135, 117, 74, 0.86);
  background: rgba(37, 31, 22, 0.94);
  color: #d9c489;
}

.file-icon[data-kind="live"] {
  border-color: rgba(176, 75, 78, 0.9);
  background: rgba(48, 23, 27, 0.94);
  color: #f08b8d;
}

.file-icon[data-kind="live"] circle {
  fill: currentColor;
  stroke: none;
}

.drag-preview {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 40;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  max-width: 170px;
  min-width: 108px;
  height: 36px;
  border: 1px solid rgba(83, 170, 226, 0.82);
  border-radius: 7px;
  padding: 4px 8px 4px 5px;
  background: rgba(12, 22, 32, 0.96);
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.36);
  color: var(--text);
  pointer-events: none;
}

.drag-preview .file-icon {
  width: 28px;
  height: 23px;
}

.drag-preview-copy {
  overflow: hidden;
  font-size: var(--gsm-fs-meta);
  font-weight: 900;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pairing-panel {
  display: grid;
  grid-template-rows: var(--gsm-control-xs) var(--gsm-control-sm) minmax(0, 1fr);
  gap: 6px;
  min-height: 0;
  border: 1px solid rgba(36, 50, 64, 0.76);
  border-radius: var(--gsm-radius-md);
  padding: 6px;
  background: var(--gsm-surface-subtle);
}

.pairing-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.pairing-head strong {
  overflow: hidden;
  color: var(--text);
  font-size: var(--gsm-fs-body);
  font-weight: 900;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.pairing-head label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
  cursor: pointer;
  font-size: var(--gsm-fs-meta);
  font-weight: 800;
}

.pairing-head input {
  width: 13px;
  height: 13px;
  accent-color: #3ec07a;
}

.pairing-modes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
  min-width: 0;
}

.pairing-modes button {
  height: var(--gsm-control-sm);
  padding: 0 4px;
}

.pairing-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 58px;
  gap: 5px;
  min-height: 0;
}

.pairing-grid label {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.pairing-grid span {
  overflow: hidden;
  color: var(--text-dim);
  font-size: var(--gsm-fs-caption);
  font-weight: 800;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.pairing-grid input {
  min-width: 0;
  height: 26px;
  border: 1px solid rgba(36, 50, 64, 0.92);
  border-radius: var(--gsm-radius-sm);
  padding: 0 6px;
  background: rgba(6, 10, 14, 0.82);
  color: var(--text);
  font: inherit;
  font-size: var(--gsm-fs-body);
  font-weight: 800;
}

.pairing-grid input[type="number"] {
  text-align: center;
}

.team-builder {
  position: relative;
  display: block;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: visible;
}

.team-menu {
  grid-template-rows: var(--gsm-control-sm) minmax(0, 1fr);
  gap: 6px;
  height: 100%;
  padding: 6px;
}

.team-new,
.slot-inspect-button {
  min-width: 0;
  height: var(--gsm-control-sm);
  border: 1px solid rgba(54, 77, 98, 0.86);
  border-radius: var(--gsm-radius-md);
  background: rgba(20, 29, 38, 0.86);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: var(--gsm-fs-body);
  font-weight: 800;
}

.team-new:hover,
.slot-inspect-button:hover {
  border-color: var(--accent);
  background: rgba(24, 42, 58, 0.96);
}

.team-row.red.active {
  border-color: rgba(239, 96, 104, 0.82);
}

.team-row.blue.active {
  border-color: rgba(83, 170, 226, 0.82);
}

.slot-menu {
  position: absolute;
  left: calc(100% + var(--gsm-overlay-gap));
  top: 0;
  bottom: 0;
  z-index: var(--gsm-z-overlay);
  grid-template-rows: 38px minmax(0, 1fr);
  gap: 8px;
  width: var(--gsm-overlay-slot);
  padding: 8px;
  background: var(--gsm-surface-glass);
  box-shadow: var(--gsm-shadow-overlay);
}

.slot-list {
  gap: 8px;
  overflow-x: hidden;
  padding-right: 2px;
}

.slot-row {
  display: grid;
  grid-template-columns: 68px minmax(104px, 1fr) 50px 48px;
  align-items: center;
  gap: 8px;
  min-width: 0;
  border: 1px solid rgba(36, 50, 64, 0.82);
  border-radius: var(--gsm-radius-md);
  padding: 8px;
  background: rgba(20, 29, 38, 0.68);
  cursor: pointer;
}

.slot-row:hover,
.slot-row.active {
  border-color: rgba(79, 159, 224, 0.86);
  background: rgba(22, 34, 46, 0.94);
}

.slot-copy {
  display: grid;
  min-width: 0;
}

.slot-copy strong,
.slot-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slot-copy strong {
  color: var(--text);
  font-size: 13px;
  font-weight: 900;
  line-height: 1.1;
}

.slot-copy small {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 800;
  line-height: 1.2;
}

.slot-row select {
  width: 100%;
  height: 32px;
  font-size: 13px;
}

.slot-cost {
  justify-self: end;
  min-width: 0;
  overflow: hidden;
  color: #d9e8f5;
  font-size: 13px;
  font-weight: 900;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slot-inspect-button {
  width: 48px;
  height: 32px;
  padding: 0;
  font-size: 13px;
  font-weight: 900;
}

.slot-detail-menu {
  position: absolute;
  left: calc(100% + var(--gsm-overlay-slot) + var(--gsm-overlay-gap) + var(--gsm-overlay-gap));
  top: 0;
  bottom: 0;
  z-index: var(--gsm-z-overlay-raised);
  grid-template-rows: min-content;
  grid-auto-rows: min-content;
  align-content: start;
  gap: 10px;
  width: 348px;
  padding: 10px;
  overflow-y: auto;
  background: rgba(13, 19, 26, 0.97);
  box-shadow: 14px 0 30px rgba(0, 0, 0, 0.34);
}

.slot-inspector-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-width: 0;
  border: 1px solid rgba(54, 77, 98, 0.76);
  border-radius: var(--gsm-radius-md);
  padding: 9px 10px;
  background: rgba(10, 16, 22, 0.72);
}

.slot-inspector-head div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.slot-inspector-head strong,
.slot-inspector-head span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slot-inspector-head strong {
  color: var(--text);
  font-size: 16px;
  font-weight: 900;
  line-height: 1.15;
}

.slot-inspector-head span {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 800;
  line-height: 1.2;
}

.slot-inspector-head b {
  color: #d9e8f5;
  font-size: 15px;
  font-weight: 900;
  white-space: nowrap;
}

.field-board {
  display: grid;
  gap: 8px;
  min-width: 0;
  border: 1px solid rgba(36, 50, 64, 0.62);
  border-radius: var(--gsm-radius-md);
  padding: 9px;
  background: rgba(11, 18, 25, 0.5);
}

.field-label {
  overflow: hidden;
  color: #a8bacb;
  font-size: 12px;
  font-weight: 900;
  line-height: 1.2;
  text-overflow: ellipsis;
}

.detail-grid {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.detail-grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.detail-grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.param-field {
  display: grid;
  grid-template-rows: 16px 34px;
  gap: 4px;
  min-width: 0;
}

.param-field span {
  overflow: hidden;
  color: #a8bacb;
  font-size: 12px;
  font-weight: 900;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.param-field input {
  min-width: 0;
  height: 34px;
  border: 1px solid rgba(54, 77, 98, 0.92);
  border-radius: var(--gsm-radius-md);
  padding: 0 8px;
  background: rgba(6, 10, 14, 0.88);
  color: var(--text);
  font: inherit;
  font-size: 15px;
  font-weight: 900;
  text-align: center;
}

.segmented {
  grid-template-columns: repeat(auto-fit, minmax(34px, 1fr));
}

.slot-detail-menu .segmented {
  gap: 7px;
}

.slot-detail-menu .segmented button {
  height: 34px;
  font-size: 13px;
  font-weight: 900;
}

.range-field input {
  width: 100%;
  accent-color: #53aae2;
}

.slot-detail-menu .range-field {
  gap: 8px;
}

.slot-detail-menu .range-field span {
  color: #a8bacb;
  font-size: 12px;
  font-weight: 900;
  line-height: 1.2;
  text-transform: none;
}

.slot-detail-menu .range-field input {
  height: 28px;
}

.toggle-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.toggle-grid label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  min-height: 34px;
  border: 1px solid rgba(36, 50, 64, 0.72);
  border-radius: var(--gsm-radius-md);
  padding: 0 9px;
  background: rgba(8, 13, 18, 0.48);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
  font-weight: 900;
}

:deep(.dock-context) {
  z-index: 20;
  display: grid;
  width: 176px;
  gap: 5px;
  border: 1px solid rgba(58, 82, 104, 0.96);
  border-radius: var(--gsm-radius-md);
  padding: 7px;
  background: rgba(9, 14, 19, 0.98);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.38);
  outline: none;
}

:deep(.dock-context-label) {
  overflow: hidden;
  color: var(--text-dim);
  font-size: var(--gsm-fs-meta);
  font-weight: 800;
  line-height: 1.25;
  padding: 1px 3px 3px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.dock-context-item) {
  display: flex;
  align-items: center;
  height: 25px;
  min-width: 0;
  border: 1px solid rgba(54, 77, 98, 0.86);
  border-radius: var(--gsm-radius-md);
  padding: 0 7px;
  background: rgba(20, 29, 38, 0.86);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: var(--gsm-fs-body);
  font-weight: 800;
  outline: none;
  text-align: left;
}

:deep(.dock-context-item:not([data-disabled]):hover),
:deep(.dock-context-item[data-highlighted]) {
  border-color: var(--accent);
  background: rgba(24, 42, 58, 0.96);
}

:deep(.dock-context-item[data-disabled]) {
  cursor: default;
  opacity: 0.42;
}

:deep(.dock-context-item.danger) {
  color: #f6b0b0;
}

:deep(.dock-context-item.danger[data-highlighted]) {
  border-color: rgba(239, 68, 68, 0.88);
  background: rgba(94, 28, 32, 0.86);
  color: #ffe1e1;
}

:deep(.dock-context-separator) {
  height: 1px;
  margin: 2px 1px;
  background: rgba(58, 82, 104, 0.72);
}

.dock-match-copy {
  display: grid;
  justify-items: start;
  min-width: 0;
  width: 100%;
  gap: 0;
}

.dock-match-copy strong,
.dock-match-copy small,
.panel-head strong,
.stage-readout strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dock-match-copy strong {
  max-width: 100%;
  color: var(--text);
  font-size: var(--gsm-fs-meta);
  font-weight: 800;
  line-height: 1.16;
}

.dock-match-copy small {
  max-width: 100%;
  color: var(--text-dim);
  font-size: var(--gsm-fs-caption);
  line-height: 1.1;
}

.dock-stage {
  position: relative;
  z-index: 0;
  min-width: 0;
  overflow: hidden;
  background:
    linear-gradient(90deg, rgba(8, 13, 18, 0.92), rgba(8, 13, 18, 0.18) 18%, rgba(8, 13, 18, 0.18) 82%, rgba(8, 13, 18, 0.92)),
    #080d12;
}

.dock-canvas {
  position: absolute;
  inset: 0;
}

.dock-stage :deep(.veh-panel .vp-buffs) {
  max-width: 112px;
  gap: 2px;
  margin-bottom: 2px;
}

.dock-stage :deep(.veh-panel .vp-pip) {
  width: 14px;
  height: 14px;
  padding: 1.5px;
  border-radius: 3px;
}

.dock-stage :deep(.veh-panel .vp-box) {
  width: 112px;
  border-radius: 4px;
  padding: 3px 5px 4px;
}

.dock-stage :deep(.veh-panel .vp-head) {
  gap: 4px;
}

.dock-stage :deep(.veh-panel .vp-tag) {
  font-size: var(--gsm-fs-caption);
}

.dock-stage :deep(.veh-panel .vp-lv),
.dock-stage :deep(.veh-panel .vp-ammo b) {
  font-size: var(--gsm-fs-tiny);
}

.dock-stage :deep(.veh-panel .vp-cell) {
  height: 7px;
}

.dock-stage :deep(.veh-panel .vp-heat) {
  height: 2px;
}

.dock-stage :deep(.match-plaque) {
  border-radius: 5px;
  padding: 2px 7px;
  font-size: var(--gsm-fs-meta);
}

.stage-readout {
  position: absolute;
  left: 10px;
  right: 104px;
  top: 8px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  height: var(--gsm-control-xs);
  padding: 0 9px;
  border: 1px solid rgba(36, 50, 64, 0.7);
  border-radius: var(--gsm-radius-md);
  background: rgba(8, 13, 18, 0.66);
  color: var(--text-dim);
  font-size: var(--gsm-fs-body);
  pointer-events: none;
}

.stage-readout strong {
  color: var(--text);
  font-size: var(--gsm-fs-label);
}

.desktop-settings-button {
  position: absolute;
  right: 10px;
  top: 8px;
  z-index: 7;
  width: 86px;
  height: var(--gsm-control-xs);
  border: 1px solid rgba(54, 77, 98, 0.86);
  border-radius: var(--gsm-radius-md);
  background: rgba(20, 29, 38, 0.86);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: var(--gsm-fs-body);
  font-weight: 800;
}

.desktop-settings-button:hover,
.desktop-settings-button[aria-expanded="true"] {
  border-color: var(--accent);
  background: rgba(24, 42, 58, 0.96);
}

.fps-debug-window {
  position: absolute;
  top: 40px;
  left: 12px;
  z-index: 4;
  display: grid;
  width: 244px;
  gap: 7px;
  border: 1px solid rgba(58, 82, 104, 0.9);
  border-radius: var(--gsm-radius-md);
  padding: 8px;
  background: rgba(8, 13, 18, 0.82);
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.24);
  color: var(--text);
  pointer-events: none;
}

.fps-debug-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.fps-debug-head span {
  color: var(--text-dim);
  font-size: var(--gsm-fs-meta);
  font-weight: 800;
  text-transform: uppercase;
}

.fps-debug-head strong {
  color: #3ec07a;
  font-size: 18px;
  font-weight: 900;
  line-height: 1;
}

.fps-debug-head strong.warn {
  color: #f59e0b;
}

.fps-debug-head strong.bad,
.fps-debug-window dd.bad {
  color: #ef4444;
}

.fps-debug-window dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
  margin: 0;
}

.fps-debug-window dl div {
  min-width: 0;
  border: 1px solid rgba(36, 50, 64, 0.62);
  border-radius: 5px;
  padding: 4px 5px;
  background: rgba(11, 18, 25, 0.68);
}

.fps-debug-window dl div.wide {
  grid-column: 1 / -1;
}

.fps-debug-window dt {
  overflow: hidden;
  color: var(--text-dim);
  font-size: var(--gsm-fs-caption);
  font-weight: 800;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.fps-debug-window dd {
  overflow: hidden;
  margin: 0;
  color: var(--text);
  font-size: var(--gsm-fs-body);
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dock-panel {
  display: grid;
  grid-template-rows: 34px 28px 42px;
  gap: 7px;
  padding: 9px 10px 8px;
  border-left: 1px solid rgba(36, 50, 64, 0.85);
}

.panel-head {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.panel-head strong {
  font-size: var(--gsm-fs-label);
}

.panel-head .s-dot.ghost {
  opacity: 0;
}

.panel-actions {
  display: grid;
  grid-template-columns: 1fr;
}

.panel-actions button,
.iter-strip button {
  height: 26px;
  border: 1px solid rgba(36, 50, 64, 0.9);
  border-radius: var(--gsm-radius-md);
  background: rgba(20, 29, 38, 0.78);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: var(--gsm-fs-body);
  font-weight: 700;
}

.panel-actions button:hover:not(:disabled),
.panel-actions button.active,
.iter-strip button:hover,
.iter-strip button.active {
  border-color: var(--accent);
  background: rgba(22, 34, 46, 0.95);
}

.panel-actions button:disabled {
  cursor: default;
  opacity: 0.42;
}

.desktop-settings-panel {
  position: absolute;
  top: 40px;
  right: 10px;
  z-index: 12;
  display: grid;
  width: 272px;
  gap: 8px;
  border: 1px solid rgba(58, 82, 104, 0.94);
  border-radius: var(--gsm-radius-md);
  padding: 9px;
  background: rgba(9, 14, 19, 0.98);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.38);
}

.settings-title {
  color: var(--text-dim);
  font-size: var(--gsm-fs-meta);
  font-weight: 900;
  text-transform: uppercase;
}

.settings-toggle {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 40px;
  align-items: center;
  gap: 10px;
  min-width: 0;
  cursor: pointer;
}

.settings-field {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.settings-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.settings-copy strong,
.settings-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-copy strong {
  color: var(--text);
  font-size: var(--gsm-fs-body);
  font-weight: 800;
}

.settings-copy small {
  color: var(--text-dim);
  font-size: var(--gsm-fs-meta);
}

.settings-toggle input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.settings-field select {
  width: 100%;
  min-width: 0;
  height: 27px;
  border: 1px solid rgba(54, 77, 98, 0.9);
  border-radius: var(--gsm-radius-sm);
  padding: 0 8px;
  background: rgba(14, 22, 30, 0.96);
  color: var(--text);
  font: inherit;
  font-size: var(--gsm-fs-body);
  outline: none;
}

.settings-field select:focus-visible {
  border-color: rgba(83, 170, 226, 0.92);
  box-shadow: 0 0 0 2px rgba(83, 170, 226, 0.18);
}

.settings-field select:disabled {
  cursor: default;
  opacity: 0.54;
}

.toggle-track {
  position: relative;
  width: 38px;
  height: 20px;
  border: 1px solid rgba(54, 77, 98, 0.9);
  border-radius: 999px;
  background: rgba(20, 29, 38, 0.92);
}

.toggle-track i {
  position: absolute;
  left: 3px;
  top: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-dim);
  transition: transform 0.16s ease, background 0.16s ease;
}

.settings-toggle input:checked + .toggle-track {
  border-color: rgba(62, 192, 122, 0.85);
  background: rgba(29, 92, 61, 0.78);
}

.settings-toggle input:checked + .toggle-track i {
  transform: translateX(18px);
  background: #dff8ea;
}

.panel-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
}

.panel-stats div {
  min-width: 0;
  border: 1px solid rgba(36, 50, 64, 0.72);
  border-radius: var(--gsm-radius-md);
  padding: 5px 6px;
  background: rgba(10, 16, 22, 0.64);
}

.panel-stats dt {
  color: var(--text-dim);
  font-size: var(--gsm-fs-caption);
  font-weight: 700;
  text-transform: uppercase;
}

.panel-stats dd {
  margin: 0;
  color: var(--text);
  font-size: var(--gsm-fs-metric);
  font-weight: 800;
  line-height: 1.15;
}

.iter-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
  gap: 5px;
  min-height: 0;
  overflow: auto;
}
</style>
