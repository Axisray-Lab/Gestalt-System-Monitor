import generatedCatalog from './rmuc2026ReplayCatalog.generated.json';

export const STATIC_REPLAY_CATALOG_SCHEMA = 'gsm-static-replay-catalog/2';
export const OVERVIEW_TRACK_SCHEMA = 'gsm-rmuc2026-overview-track/1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const REPLAY_TICK_MS = 100;
const ROUND_GAP_MS = 3_000;
const EXPECTED_SERIES_COUNT = 266;
const EXPECTED_ROUND_COUNT = 613;
const EXPECTED_REGIONS = [
  { key: 'east', label: '东部赛区', series: 88, rounds: 203 },
  { key: 'south', label: '南部赛区', series: 88, rounds: 204 },
  { key: 'north', label: '北部赛区', series: 90, rounds: 206 },
] as const;

export type StaticReplayEncoding = 'gzip';

/** Compatibility surface consumed by the focused replay feed. Catalog exports are round descriptors. */
export interface StaticReplayDescriptor {
  key: string;
  label: string;
  assetPath: string;
  encoding: StaticReplayEncoding;
  regionKey: string;
  regionLabel: string;
  matchNumber: number;
  roundCount: number;
  redSchool: string;
  blueSchool: string;
  frameCount: number;
  durationMs: number;
  compressedBytes: number;
  sha256: string;
  competitionKey: string;
  competitionLabel: string;
  mapKey: string;
  mapLabel: string;
}

/** One independently selectable game cut from a shared two-to-four-game series asset. */
export interface StaticReplayRoundDescriptor extends StaticReplayDescriptor {
  assetKey: string;
  seriesKey: string;
  roundNumber: number;
  gameId: number;
  webGameId: number;
  winner: string;
  startedLocal: string;
  assetRoundCount: number;
  startMs: number;
  endMs: number;
  frameStartIndex: number;
  frameCountInRound: number;
  assetFrameCount: number;
  assetDurationMs: number;
}

export interface StaticReplaySeriesDescriptor {
  key: string;
  label: string;
  assetPath: string;
  encoding: StaticReplayEncoding;
  regionKey: string;
  regionLabel: string;
  matchNumber: number;
  roundCount: number;
  redSchool: string;
  blueSchool: string;
  frameCount: number;
  durationMs: number;
  compressedBytes: number;
  sha256: string;
  rounds: readonly StaticReplayRoundDescriptor[];
}

export interface OverviewTrackDescriptor {
  schema: typeof OVERVIEW_TRACK_SCHEMA;
  assetPath: string;
  encoding: StaticReplayEncoding;
  regionKey: string;
  sampleHz: 1;
  positionQuantizationCm: 1;
  roundCount: number;
  timelineSampleCount: number;
  entitySampleCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
  sha256: string;
}

export interface StaticReplayRegion {
  key: string;
  label: string;
  overviewTrack: OverviewTrackDescriptor;
  replays: readonly StaticReplaySeriesDescriptor[];
}

export interface StaticReplayCatalog {
  schema: typeof STATIC_REPLAY_CATALOG_SCHEMA;
  databaseSha256: string;
  competition: {
    key: string;
    label: string;
    mapKey: string;
    mapLabel: string;
  };
  seriesCount: number;
  roundCount: number;
  regions: readonly StaticReplayRegion[];
}

type JsonObject = Record<string, unknown>;

function catalogError(path: string, message: string): never {
  throw new Error(`[static replay catalog] ${path} ${message}`);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    catalogError(path, 'must be an object');
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    catalogError(path, `must contain exactly: ${wanted.join(', ')}`);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    catalogError(path, 'must be a non-empty string');
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    catalogError(path, 'must be a positive safe integer');
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    catalogError(path, 'must be a non-negative safe integer');
  }
  return value;
}

function sha256(value: unknown, path: string): string {
  const digest = nonEmptyString(value, path);
  if (!SHA256_PATTERN.test(digest)) catalogError(path, 'must be a lowercase SHA-256 digest');
  return digest;
}

function relativeAssetPath(value: unknown, path: string, suffix: string): string {
  const assetPath = nonEmptyString(value, path);
  const segments = assetPath.split('/');
  if (
    !assetPath.endsWith(suffix) ||
    assetPath.startsWith('/') ||
    assetPath.includes('\\') ||
    URL_SCHEME_PATTERN.test(assetPath) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    catalogError(path, `must be a relative ${suffix} asset path without traversal`);
  }
  return assetPath;
}

function parseCompetition(value: unknown): StaticReplayCatalog['competition'] {
  const competition = objectAt(value, 'competition');
  exactKeys(competition, ['key', 'label', 'mapKey', 'mapLabel'], 'competition');
  const parsed = {
    key: nonEmptyString(competition.key, 'competition.key'),
    label: nonEmptyString(competition.label, 'competition.label'),
    mapKey: nonEmptyString(competition.mapKey, 'competition.mapKey'),
    mapLabel: nonEmptyString(competition.mapLabel, 'competition.mapLabel'),
  };
  if (parsed.key !== 'rmuc2026' || parsed.mapKey !== 'rmuc2026') {
    catalogError('competition', 'must identify the RMUC2026 replay dataset');
  }
  return parsed;
}

function parseOverviewTrack(
  value: unknown,
  path: string,
  regionKey: string,
  expectedRoundCount: number
): OverviewTrackDescriptor {
  const track = objectAt(value, path);
  exactKeys(
    track,
    [
      'schema',
      'assetPath',
      'encoding',
      'regionKey',
      'sampleHz',
      'positionQuantizationCm',
      'roundCount',
      'timelineSampleCount',
      'entitySampleCount',
      'uncompressedBytes',
      'compressedBytes',
      'sha256',
    ],
    path
  );
  if (track.schema !== OVERVIEW_TRACK_SCHEMA) {
    catalogError(`${path}.schema`, `must equal ${OVERVIEW_TRACK_SCHEMA}`);
  }
  if (track.encoding !== 'gzip') catalogError(`${path}.encoding`, 'must equal gzip');
  if (track.regionKey !== regionKey) catalogError(`${path}.regionKey`, 'must match its region');
  if (track.sampleHz !== 1) catalogError(`${path}.sampleHz`, 'must equal 1');
  if (track.positionQuantizationCm !== 1) {
    catalogError(`${path}.positionQuantizationCm`, 'must equal 1');
  }
  const roundCount = positiveInteger(track.roundCount, `${path}.roundCount`);
  if (roundCount !== expectedRoundCount) {
    catalogError(`${path}.roundCount`, `must equal ${expectedRoundCount}`);
  }
  const assetPath = relativeAssetPath(track.assetPath, `${path}.assetPath`, '.bin.gzip');
  const expectedPath = `replays/rmuc2026-regionals/overview/${regionKey}.bin.gzip`;
  if (assetPath !== expectedPath) catalogError(`${path}.assetPath`, `must equal ${expectedPath}`);
  return {
    schema: OVERVIEW_TRACK_SCHEMA,
    assetPath,
    encoding: 'gzip',
    regionKey,
    sampleHz: 1,
    positionQuantizationCm: 1,
    roundCount,
    timelineSampleCount: positiveInteger(track.timelineSampleCount, `${path}.timelineSampleCount`),
    entitySampleCount: positiveInteger(track.entitySampleCount, `${path}.entitySampleCount`),
    uncompressedBytes: positiveInteger(track.uncompressedBytes, `${path}.uncompressedBytes`),
    compressedBytes: positiveInteger(track.compressedBytes, `${path}.compressedBytes`),
    sha256: sha256(track.sha256, `${path}.sha256`),
  };
}

function parseRound(
  value: unknown,
  path: string,
  series: Omit<StaticReplaySeriesDescriptor, 'rounds'>,
  expectedRoundNumber: number,
  competition: StaticReplayCatalog['competition']
): StaticReplayRoundDescriptor {
  const round = objectAt(value, path);
  exactKeys(
    round,
    [
      'key', 'label', 'assetKey', 'seriesKey', 'assetPath', 'encoding', 'regionKey',
      'regionLabel', 'matchNumber', 'roundNumber', 'gameId', 'webGameId', 'winner',
      'startedLocal', 'redSchool', 'blueSchool', 'roundCount', 'assetRoundCount',
      'startMs', 'endMs', 'durationMs', 'frameStartIndex', 'frameCount',
      'frameCountInRound', 'assetFrameCount', 'assetDurationMs', 'compressedBytes', 'sha256',
    ],
    path
  );
  const key = nonEmptyString(round.key, `${path}.key`);
  if (key !== `${series.key}-g${expectedRoundNumber}`) {
    catalogError(`${path}.key`, `must equal ${series.key}-g${expectedRoundNumber}`);
  }
  const startMs = nonNegativeInteger(round.startMs, `${path}.startMs`);
  const endMs = positiveInteger(round.endMs, `${path}.endMs`);
  const durationMs = positiveInteger(round.durationMs, `${path}.durationMs`);
  const frameStartIndex = nonNegativeInteger(round.frameStartIndex, `${path}.frameStartIndex`);
  const frameCount = positiveInteger(round.frameCount, `${path}.frameCount`);
  if (
    round.assetKey !== series.key ||
    round.seriesKey !== series.key ||
    round.assetPath !== series.assetPath ||
    round.encoding !== 'gzip' ||
    round.regionKey !== series.regionKey ||
    round.regionLabel !== series.regionLabel ||
    round.matchNumber !== series.matchNumber ||
    round.roundNumber !== expectedRoundNumber ||
    round.redSchool !== series.redSchool ||
    round.blueSchool !== series.blueSchool ||
    round.roundCount !== 1 ||
    round.assetRoundCount !== series.roundCount ||
    endMs - startMs !== durationMs ||
    startMs % REPLAY_TICK_MS !== 0 ||
    endMs % REPLAY_TICK_MS !== 0 ||
    frameStartIndex !== startMs / REPLAY_TICK_MS ||
    frameCount !== durationMs / REPLAY_TICK_MS ||
    round.frameCountInRound !== frameCount ||
    round.assetFrameCount !== series.frameCount ||
    round.assetDurationMs !== series.durationMs ||
    round.compressedBytes !== series.compressedBytes ||
    round.sha256 !== series.sha256
  ) {
    catalogError(path, 'does not match its series asset or frame boundaries');
  }
  return {
    key,
    label: nonEmptyString(round.label, `${path}.label`),
    assetKey: series.key,
    seriesKey: series.key,
    assetPath: series.assetPath,
    encoding: 'gzip',
    regionKey: series.regionKey,
    regionLabel: series.regionLabel,
    matchNumber: series.matchNumber,
    roundNumber: expectedRoundNumber,
    gameId: positiveInteger(round.gameId, `${path}.gameId`),
    webGameId: positiveInteger(round.webGameId, `${path}.webGameId`),
    winner: nonEmptyString(round.winner, `${path}.winner`),
    startedLocal: nonEmptyString(round.startedLocal, `${path}.startedLocal`),
    redSchool: series.redSchool,
    blueSchool: series.blueSchool,
    roundCount: 1,
    assetRoundCount: series.roundCount,
    startMs,
    endMs,
    durationMs,
    frameStartIndex,
    frameCount,
    frameCountInRound: frameCount,
    assetFrameCount: series.frameCount,
    assetDurationMs: series.durationMs,
    compressedBytes: series.compressedBytes,
    sha256: series.sha256,
    competitionKey: competition.key,
    competitionLabel: competition.label,
    mapKey: competition.mapKey,
    mapLabel: competition.mapLabel,
  };
}

function parseSeries(
  value: unknown,
  path: string,
  regionKey: string,
  regionLabel: string,
  expectedMatchNumber: number,
  competition: StaticReplayCatalog['competition']
): StaticReplaySeriesDescriptor {
  const replay = objectAt(value, path);
  exactKeys(
    replay,
    [
      'key', 'label', 'assetPath', 'encoding', 'regionKey', 'regionLabel', 'matchNumber',
      'roundCount', 'redSchool', 'blueSchool', 'frameCount', 'durationMs',
      'compressedBytes', 'sha256', 'rounds',
    ],
    path
  );
  if (replay.encoding !== 'gzip') catalogError(`${path}.encoding`, 'must equal gzip');
  const parsedRegionKey = nonEmptyString(replay.regionKey, `${path}.regionKey`);
  const parsedRegionLabel = nonEmptyString(replay.regionLabel, `${path}.regionLabel`);
  if (parsedRegionKey !== regionKey || parsedRegionLabel !== regionLabel) {
    catalogError(path, 'region metadata must match its container');
  }
  const matchNumber = positiveInteger(replay.matchNumber, `${path}.matchNumber`);
  if (matchNumber !== expectedMatchNumber) {
    catalogError(`${path}.matchNumber`, `must equal ${expectedMatchNumber}`);
  }
  const roundCount = positiveInteger(replay.roundCount, `${path}.roundCount`);
  if (roundCount < 2 || roundCount > 4) catalogError(`${path}.roundCount`, 'must be 2..4');
  const frameCount = positiveInteger(replay.frameCount, `${path}.frameCount`);
  const durationMs = positiveInteger(replay.durationMs, `${path}.durationMs`);
  if (durationMs !== frameCount * REPLAY_TICK_MS) {
    catalogError(`${path}.durationMs`, 'must equal frameCount * 100');
  }
  const seriesBase: Omit<StaticReplaySeriesDescriptor, 'rounds'> = {
    key: nonEmptyString(replay.key, `${path}.key`),
    label: nonEmptyString(replay.label, `${path}.label`),
    assetPath: relativeAssetPath(replay.assetPath, `${path}.assetPath`, '.json.gzip'),
    encoding: 'gzip',
    regionKey,
    regionLabel,
    matchNumber,
    roundCount,
    redSchool: nonEmptyString(replay.redSchool, `${path}.redSchool`),
    blueSchool: nonEmptyString(replay.blueSchool, `${path}.blueSchool`),
    frameCount,
    durationMs,
    compressedBytes: positiveInteger(replay.compressedBytes, `${path}.compressedBytes`),
    sha256: sha256(replay.sha256, `${path}.sha256`),
  };
  if (!Array.isArray(replay.rounds) || replay.rounds.length !== roundCount) {
    catalogError(`${path}.rounds`, `must contain ${roundCount} rounds`);
  }
  const rounds = replay.rounds.map((round, index) =>
    parseRound(round, `${path}.rounds[${index}]`, seriesBase, index + 1, competition)
  );
  let nextStartMs = 0;
  for (const round of rounds) {
    if (round.startMs !== nextStartMs) {
      catalogError(`${path}.rounds`, 'must be contiguous with explicit 3000 ms gaps');
    }
    nextStartMs = round.endMs + ROUND_GAP_MS;
  }
  if (nextStartMs !== durationMs) {
    catalogError(`${path}.rounds`, 'must cover the complete shared series asset');
  }
  return { ...seriesBase, rounds };
}

export function parseStaticReplayCatalog(value: unknown): StaticReplayCatalog {
  const root = objectAt(value, 'root');
  exactKeys(
    root,
    ['schema', 'databaseSha256', 'competition', 'seriesCount', 'roundCount', 'regions'],
    'root'
  );
  if (root.schema !== STATIC_REPLAY_CATALOG_SCHEMA) {
    catalogError('schema', `must equal ${STATIC_REPLAY_CATALOG_SCHEMA}`);
  }
  const competition = parseCompetition(root.competition);
  const seriesCount = positiveInteger(root.seriesCount, 'seriesCount');
  const roundCount = positiveInteger(root.roundCount, 'roundCount');
  if (seriesCount !== EXPECTED_SERIES_COUNT || roundCount !== EXPECTED_ROUND_COUNT) {
    catalogError('root', `must declare ${EXPECTED_SERIES_COUNT} series and ${EXPECTED_ROUND_COUNT} rounds`);
  }
  if (!Array.isArray(root.regions) || root.regions.length !== EXPECTED_REGIONS.length) {
    catalogError('regions', `must contain exactly ${EXPECTED_REGIONS.length} regions`);
  }

  const seriesKeys = new Set<string>();
  const assetPaths = new Set<string>();
  const roundKeys = new Set<string>();
  const gameIds = new Set<number>();
  const webGameIds = new Set<number>();
  const regions = root.regions.map((candidate, regionIndex): StaticReplayRegion => {
    const expected = EXPECTED_REGIONS[regionIndex];
    const path = `regions[${regionIndex}]`;
    const region = objectAt(candidate, path);
    exactKeys(region, ['key', 'label', 'overviewTrack', 'replays'], path);
    const key = nonEmptyString(region.key, `${path}.key`);
    const label = nonEmptyString(region.label, `${path}.label`);
    if (key !== expected.key || label !== expected.label) {
      catalogError(path, `must identify ${expected.key}/${expected.label}`);
    }
    if (!Array.isArray(region.replays) || region.replays.length !== expected.series) {
      catalogError(`${path}.replays`, `must contain ${expected.series} series`);
    }
    const replays = region.replays.map((replay, replayIndex) => {
      const replayPath = `${path}.replays[${replayIndex}]`;
      const parsed = parseSeries(replay, replayPath, key, label, replayIndex + 1, competition);
      if (seriesKeys.has(parsed.key)) catalogError(`${replayPath}.key`, `duplicates ${parsed.key}`);
      if (assetPaths.has(parsed.assetPath)) {
        catalogError(`${replayPath}.assetPath`, `duplicates ${parsed.assetPath}`);
      }
      seriesKeys.add(parsed.key);
      assetPaths.add(parsed.assetPath);
      for (const round of parsed.rounds) {
        if (roundKeys.has(round.key)) catalogError(`${replayPath}.rounds`, `duplicates ${round.key}`);
        if (gameIds.has(round.gameId)) catalogError(`${replayPath}.rounds`, `duplicates gameId ${round.gameId}`);
        if (webGameIds.has(round.webGameId)) {
          catalogError(`${replayPath}.rounds`, `duplicates webGameId ${round.webGameId}`);
        }
        roundKeys.add(round.key);
        gameIds.add(round.gameId);
        webGameIds.add(round.webGameId);
      }
      return parsed;
    });
    const actualRounds = replays.reduce((sum, replay) => sum + replay.roundCount, 0);
    if (actualRounds !== expected.rounds) {
      catalogError(`${path}.replays`, `must contain ${expected.rounds} rounds`);
    }
    return {
      key,
      label,
      overviewTrack: parseOverviewTrack(region.overviewTrack, `${path}.overviewTrack`, key, expected.rounds),
      replays,
    };
  });

  if (seriesKeys.size !== seriesCount || roundKeys.size !== roundCount) {
    catalogError('root', 'declared totals do not match strict descriptors');
  }
  return {
    schema: STATIC_REPLAY_CATALOG_SCHEMA,
    databaseSha256: sha256(root.databaseSha256, 'databaseSha256'),
    competition,
    seriesCount,
    roundCount,
    regions,
  };
}

export const RMUC2026_REPLAY_CATALOG = parseStaticReplayCatalog(generatedCatalog);

export const RMUC2026_SERIES = RMUC2026_REPLAY_CATALOG.regions.flatMap(
  (region) => region.replays
);

export const RMUC2026_ROUNDS = RMUC2026_SERIES.flatMap((series) => series.rounds);

export const RMUC2026_OVERVIEW_SHARDS = RMUC2026_REPLAY_CATALOG.regions.map(
  (region) => region.overviewTrack
);

/** Kept as the configured replay export name; it now deliberately contains 613 single-game entries. */
export const RMUC2026_REGIONAL_REPLAYS: readonly StaticReplayRoundDescriptor[] = RMUC2026_ROUNDS;

export function configuredStaticReplays(
  configured = import.meta.env.VITE_GSM_STATIC_REPLAYS
): readonly StaticReplayRoundDescriptor[] {
  if (configured === undefined) return [];
  if (configured === 'rmuc2026-regionals') return RMUC2026_ROUNDS;
  throw new Error(`Unsupported VITE_GSM_STATIC_REPLAYS value: ${configured}`);
}
