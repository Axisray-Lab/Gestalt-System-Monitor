import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GameInstallCandidate } from '@gsm/protocol';

export interface SteamDiscoveryOptions {
  gameName: string;
  steamAppId?: string;
  manualInstallDir?: string;
  executablePath?: string;
  executableName?: string;
}

export function discoverGameInstalls(options: SteamDiscoveryOptions): GameInstallCandidate[] {
  const candidates: GameInstallCandidate[] = [];
  const seen = new Set<string>();

  const configured = configuredCandidate(options);
  if (configured) {
    candidates.push(configured);
    seen.add(pathKey(configured.installDir));
  }

  for (const libraryPath of findSteamLibraries()) {
    const steamapps = path.join(libraryPath, 'steamapps');
    for (const manifestPath of listAppManifests(steamapps)) {
      const manifest = parseVdfPairs(readText(manifestPath));
      const appId = manifest.appid ?? manifest.AppId ?? appIdFromManifestPath(manifestPath);
      const name = manifest.name ?? options.gameName;
      const installDirName = manifest.installdir;

      if (!matchesTarget({ appId, name }, options) || !installDirName) continue;

      const installDir = path.join(steamapps, 'common', installDirName);
      const key = pathKey(installDir);
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push(buildCandidate({
        id: `steam:${appId ?? key}`,
        source: 'steam',
        name,
        installDir,
        steamAppId: appId,
        libraryPath,
        manifestPath,
        options,
      }));
    }
  }

  return candidates.sort((a, b) => candidateRank(b) - candidateRank(a));
}

function configuredCandidate(options: SteamDiscoveryOptions): GameInstallCandidate | null {
  const configuredPath = options.executablePath
    ? path.resolve(options.executablePath)
    : options.manualInstallDir
      ? path.resolve(options.manualInstallDir)
      : null;
  if (!configuredPath) return null;

  const stat = statSafe(configuredPath);
  const installDir = stat?.isFile() ? path.dirname(configuredPath) : configuredPath;
  return buildCandidate({
    id: 'configured:local',
    source: 'configured',
    name: options.gameName,
    installDir,
    executablePath: stat?.isFile() ? configuredPath : undefined,
    options,
  });
}

function buildCandidate(input: {
  id: string;
  source: GameInstallCandidate['source'];
  name: string;
  installDir: string;
  options: SteamDiscoveryOptions;
  executablePath?: string;
  steamAppId?: string;
  libraryPath?: string;
  manifestPath?: string;
}): GameInstallCandidate {
  const issues: string[] = [];
  const installStat = statSafe(input.installDir);
  if (!installStat?.isDirectory()) issues.push('Install directory was found but is not readable.');

  const executablePath =
    input.executablePath ?? findExecutable(input.installDir, input.name, input.options);
  if (!executablePath) issues.push('No launchable executable was found in the install directory.');

  return {
    id: input.id,
    source: input.source,
    name: input.name,
    installDir: input.installDir,
    executablePath,
    steamAppId: input.steamAppId,
    libraryPath: input.libraryPath,
    manifestPath: input.manifestPath,
    issues,
  };
}

function findSteamLibraries(): string[] {
  const roots = uniquePaths(findSteamRoots());
  const libraries = new Set<string>();
  for (const root of roots) {
    libraries.add(root);
    const libraryVdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    const text = readText(libraryVdf);
    for (const libraryPath of parseLibraryFolderPaths(text)) {
      libraries.add(libraryPath);
    }
  }
  return uniquePaths([...libraries]).filter((libraryPath) =>
    statSafe(path.join(libraryPath, 'steamapps'))?.isDirectory(),
  );
}

function findSteamRoots(): string[] {
  const roots: string[] = [];
  const envRoots = ['STEAM_PATH', 'STEAM_DIR']
    .map((key) => process.env[key])
    .filter((value): value is string => Boolean(value));
  roots.push(...envRoots);

  if (process.platform === 'win32') {
    roots.push(...readWindowsSteamRegistry());
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const programFiles = process.env.ProgramFiles;
    if (programFilesX86) roots.push(path.join(programFilesX86, 'Steam'));
    if (programFiles) roots.push(path.join(programFiles, 'Steam'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Steam'));
  } else {
    roots.push(
      path.join(os.homedir(), '.steam', 'steam'),
      path.join(os.homedir(), '.local', 'share', 'Steam'),
    );
  }

  return roots;
}

function readWindowsSteamRegistry(): string[] {
  const keys = [
    'HKCU\\Software\\Valve\\Steam',
    'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam',
    'HKLM\\SOFTWARE\\Valve\\Steam',
  ];
  const values = ['SteamPath', 'InstallPath'];
  const roots: string[] = [];

  for (const key of keys) {
    for (const value of values) {
      try {
        const output = execFileSync('reg', ['query', key, '/v', value], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const match = output.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i'));
        if (match?.[1]) roots.push(match[1].trim().replaceAll('/', '\\'));
      } catch {
        /* registry key/value may not exist */
      }
    }
  }

  return roots;
}

function listAppManifests(steamapps: string): string[] {
  try {
    return fs
      .readdirSync(steamapps, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^appmanifest_\d+\.acf$/i.test(entry.name))
      .map((entry) => path.join(steamapps, entry.name));
  } catch {
    return [];
  }
}

function parseLibraryFolderPaths(text: string): string[] {
  const paths: string[] = [];
  const re = /"path"\s+"((?:\\.|[^"])*)"/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    paths.push(unescapeVdf(match[1]));
  }
  return paths;
}

function parseVdfPairs(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const re = /"([^"]+)"\s+"((?:\\.|[^"])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    values[match[1]] = unescapeVdf(match[2]);
  }
  return values;
}

function unescapeVdf(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function matchesTarget(
  manifest: { appId?: string; name?: string },
  options: SteamDiscoveryOptions,
): boolean {
  if (options.steamAppId && manifest.appId === options.steamAppId) return true;
  return normalizeName(manifest.name ?? '') === normalizeName(options.gameName);
}

function findExecutable(
  installDir: string,
  manifestName: string,
  options: SteamDiscoveryOptions,
): string | undefined {
  const explicit = firstExistingPath([
    options.executablePath,
    options.executableName ? path.join(installDir, options.executableName) : undefined,
  ]);
  if (explicit) return explicit;

  const names = executableNameCandidates(manifestName, options.gameName);
  const direct = firstExistingPath(names.map((name) => path.join(installDir, name)));
  if (direct) return direct;

  const targetKeys = new Set(names.map((name) => normalizeName(path.parse(name).name)));
  const found = scanExecutables(installDir);
  const scored = found
    .map((file) => ({ file, score: executableScore(file, targetKeys) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.file;
}

function executableNameCandidates(...names: string[]): string[] {
  const extensions = process.platform === 'win32' ? ['.exe'] : [''];
  const stems = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    stems.add(trimmed);
    stems.add(trimmed.replace(/\s+/g, ''));
    stems.add(trimmed.replace(/\s+/g, '-'));
    stems.add(trimmed.replace(/\s+/g, '_'));
  }

  const candidates: string[] = [];
  for (const stem of stems) {
    if (path.extname(stem)) {
      candidates.push(stem);
      continue;
    }
    for (const ext of extensions) candidates.push(`${stem}${ext}`);
  }
  return candidates;
}

function scanExecutables(root: string): string[] {
  const out: string[] = [];
  const maxDepth = 3;
  const maxFiles = 2000;

  function visit(dir: string, depth: number) {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
      } else if (entry.isFile() && isExecutableFile(entry.name)) {
        out.push(fullPath);
      }
      if (out.length >= maxFiles) return;
    }
  }

  visit(root, 0);
  return out;
}

function executableScore(file: string, targetKeys: Set<string>): number {
  const base = normalizeName(path.parse(file).name);
  if (targetKeys.has(base)) return 100;
  for (const key of targetKeys) {
    if (base.includes(key) || key.includes(base)) return 70;
  }
  return 0;
}

function isExecutableFile(name: string): boolean {
  if (process.platform === 'win32') return /\.exe$/i.test(name);
  return !path.extname(name);
}

function firstExistingPath(paths: Array<string | undefined>): string | undefined {
  return paths.find((candidate) => Boolean(candidate && statSafe(candidate)?.isFile()));
}

function candidateRank(candidate: GameInstallCandidate): number {
  return (candidate.executablePath ? 100 : 0) + (candidate.source === 'configured' ? 10 : 0);
}

function appIdFromManifestPath(manifestPath: string): string | undefined {
  return path.basename(manifestPath).match(/^appmanifest_(\d+)\.acf$/i)?.[1];
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function statSafe(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of paths) {
    const normalized = path.normalize(item);
    const key = pathKey(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(normalized);
    }
  }
  return out;
}

function pathKey(value: string): string {
  return path.normalize(value).toLowerCase();
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
