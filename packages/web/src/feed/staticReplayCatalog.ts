import generatedCatalog from './rmuc2026ReplayCatalog.generated.json';

const STATIC_REPLAY_CATALOG_SCHEMA = 'gsm-static-replay-catalog/1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;

export type StaticReplayEncoding = 'gzip';

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

export interface StaticReplayRegion {
  key: string;
  label: string;
  replays: readonly StaticReplayDescriptor[];
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

function sha256(value: unknown, path: string): string {
  const digest = nonEmptyString(value, path);
  if (!SHA256_PATTERN.test(digest)) catalogError(path, 'must be a lowercase SHA-256 digest');
  return digest;
}

function parseCompetition(value: unknown): StaticReplayCatalog['competition'] {
  const competition = objectAt(value, 'competition');
  exactKeys(competition, ['key', 'label', 'mapKey', 'mapLabel'], 'competition');
  return {
    key: nonEmptyString(competition.key, 'competition.key'),
    label: nonEmptyString(competition.label, 'competition.label'),
    mapKey: nonEmptyString(competition.mapKey, 'competition.mapKey'),
    mapLabel: nonEmptyString(competition.mapLabel, 'competition.mapLabel'),
  };
}

function parseReplay(
  value: unknown,
  path: string,
  regionKey: string,
  regionLabel: string,
  competition: StaticReplayCatalog['competition']
): StaticReplayDescriptor {
  const replay = objectAt(value, path);
  exactKeys(
    replay,
    [
      'key',
      'label',
      'assetPath',
      'encoding',
      'regionKey',
      'regionLabel',
      'matchNumber',
      'roundCount',
      'redSchool',
      'blueSchool',
      'frameCount',
      'durationMs',
      'compressedBytes',
      'sha256',
    ],
    path
  );

  const parsedRegionKey = nonEmptyString(replay.regionKey, `${path}.regionKey`);
  const parsedRegionLabel = nonEmptyString(replay.regionLabel, `${path}.regionLabel`);
  if (parsedRegionKey !== regionKey) catalogError(`${path}.regionKey`, 'must match its region');
  if (parsedRegionLabel !== regionLabel) catalogError(`${path}.regionLabel`, 'must match its region');
  if (replay.encoding !== 'gzip') catalogError(`${path}.encoding`, 'must equal gzip');

  const assetPath = nonEmptyString(replay.assetPath, `${path}.assetPath`);
  const assetSegments = assetPath.split('/');
  if (
    !assetPath.endsWith('.json.gzip') ||
    assetPath.startsWith('/') ||
    assetPath.includes('\\') ||
    URL_SCHEME_PATTERN.test(assetPath) ||
    assetSegments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    catalogError(`${path}.assetPath`, 'must be a relative .json.gzip asset path without traversal');
  }

  return {
    key: nonEmptyString(replay.key, `${path}.key`),
    label: nonEmptyString(replay.label, `${path}.label`),
    assetPath,
    encoding: 'gzip',
    regionKey: parsedRegionKey,
    regionLabel: parsedRegionLabel,
    matchNumber: positiveInteger(replay.matchNumber, `${path}.matchNumber`),
    roundCount: positiveInteger(replay.roundCount, `${path}.roundCount`),
    redSchool: nonEmptyString(replay.redSchool, `${path}.redSchool`),
    blueSchool: nonEmptyString(replay.blueSchool, `${path}.blueSchool`),
    frameCount: positiveInteger(replay.frameCount, `${path}.frameCount`),
    durationMs: positiveInteger(replay.durationMs, `${path}.durationMs`),
    compressedBytes: positiveInteger(replay.compressedBytes, `${path}.compressedBytes`),
    sha256: sha256(replay.sha256, `${path}.sha256`),
    competitionKey: competition.key,
    competitionLabel: competition.label,
    mapKey: competition.mapKey,
    mapLabel: competition.mapLabel,
  };
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
  if (!Array.isArray(root.regions) || root.regions.length === 0) {
    catalogError('regions', 'must be a non-empty array');
  }

  const regionKeys = new Set<string>();
  const replayKeys = new Set<string>();
  const assetPaths = new Set<string>();
  const regions = root.regions.map((candidate, regionIndex): StaticReplayRegion => {
    const path = `regions[${regionIndex}]`;
    const region = objectAt(candidate, path);
    exactKeys(region, ['key', 'label', 'replays'], path);
    const key = nonEmptyString(region.key, `${path}.key`);
    const label = nonEmptyString(region.label, `${path}.label`);
    if (regionKeys.has(key)) catalogError(`${path}.key`, `duplicates ${key}`);
    regionKeys.add(key);
    if (!Array.isArray(region.replays) || region.replays.length === 0) {
      catalogError(`${path}.replays`, 'must be a non-empty array');
    }
    const matchNumbers = new Set<number>();
    const replays = region.replays.map((replay, replayIndex) => {
      const replayPath = `${path}.replays[${replayIndex}]`;
      const parsed = parseReplay(replay, replayPath, key, label, competition);
      if (replayKeys.has(parsed.key)) catalogError(`${replayPath}.key`, `duplicates ${parsed.key}`);
      if (assetPaths.has(parsed.assetPath)) {
        catalogError(`${replayPath}.assetPath`, `duplicates ${parsed.assetPath}`);
      }
      if (matchNumbers.has(parsed.matchNumber)) {
        catalogError(`${replayPath}.matchNumber`, `duplicates M${parsed.matchNumber}`);
      }
      replayKeys.add(parsed.key);
      assetPaths.add(parsed.assetPath);
      matchNumbers.add(parsed.matchNumber);
      return parsed;
    });
    return { key, label, replays };
  });

  const seriesCount = positiveInteger(root.seriesCount, 'seriesCount');
  const roundCount = positiveInteger(root.roundCount, 'roundCount');
  const replays = regions.flatMap(region => region.replays);
  if (seriesCount !== replays.length) catalogError('seriesCount', 'does not match replay count');
  const summedRounds = replays.reduce((sum, replay) => sum + replay.roundCount, 0);
  if (roundCount !== summedRounds) catalogError('roundCount', 'does not match replay round totals');

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

export const RMUC2026_REGIONAL_REPLAYS = RMUC2026_REPLAY_CATALOG.regions.flatMap(
  region => region.replays
);

export function configuredStaticReplays(
  configured = import.meta.env.VITE_GSM_STATIC_REPLAYS
): readonly StaticReplayDescriptor[] {
  if (configured === undefined) return [];
  if (configured === 'rmuc2026-regionals') return RMUC2026_REGIONAL_REPLAYS;
  throw new Error(`Unsupported VITE_GSM_STATIC_REPLAYS value: ${configured}`);
}
