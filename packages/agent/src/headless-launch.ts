import path from 'node:path';
import { buildRosterSpec, type HeadlessMatchConfig } from '@gsm/protocol';

export interface HeadlessLaunchConfig {
  args: string[];
  cwd?: string;
  executablePath?: string;
  windowsVerbatimArguments?: boolean;
  autoSaveAvailable?: boolean;
  autoSaveEnabled?: boolean;
  autoSaveMode?: 'watch-ws' | 'attrrecord-log' | 'configured-args' | 'off';
  error?: string;
}

export interface UeHeadlessLaunchOptions {
  executablePath?: string;
  projectPath?: string;
  mapId: number;
  render: 'nullrhi' | 'offscreen' | 'windowed';
  attrRecord: boolean;
  attrHz: number;
  logPath?: string;
  userDir?: string;
  hudHidden: number;
  netType: number;
  connMethod: number;
  autostartDelayMs: number;
  execDelayMs: number;
  exec?: string;
  execCmds?: string;
  matchIntervalSec: number;
  match?: HeadlessMatchConfig;
}

export interface StandaloneHeadlessLaunchOptions {
  executablePath?: string;
  cwd?: string;
  mapId: number;
  render: 'nullrhi' | 'offscreen' | 'windowed';
  attrRecord: boolean;
  attrHz: number;
  logPath?: string;
  userDir?: string;
  hudHidden: number;
  netType: number;
  connMethod: number;
  autostartDelayMs: number;
  execDelayMs: number;
  exec?: string;
  execCmds?: string;
  matchIntervalSec: number;
  match?: HeadlessMatchConfig;
}

const RENDER_TOKENS: Record<UeHeadlessLaunchOptions['render'], string[]> = {
  nullrhi: ['-nullrhi', '-nosound', '-maxfps=60'],
  offscreen: ['-RenderOffscreen', '-nosound', '-maxfps=60'],
  windowed: [],
};

export function buildUeHeadlessLaunch(options: UeHeadlessLaunchOptions): HeadlessLaunchConfig {
  if (!options.executablePath) {
    return { args: [], error: 'UE headless launch needs --ue-exe or GSM_UE_EXE.' };
  }
  if (!options.projectPath) {
    return { args: [], error: 'UE headless launch needs --ue-project or GSM_UE_PROJECT.' };
  }

  const match = matchLaunchValues(options);
  const args = [
    q(options.projectPath),
    '-game',
    ...RENDER_TOKENS[options.render],
    '-log',
    ...(options.logPath ? [`-abslog=${q(options.logPath)}`] : []),
    ...(options.userDir ? [`-UserDir=${q(options.userDir)}`] : []),
    '-blockexitprogram',
    '-autostart',
    `-mapid=${match.mapId}`,
    `-nettype=${match.netType}`,
    `-connmethod=${options.connMethod}`,
    `-autostartdelay=${options.autostartDelayMs}`,
    `-execdelay=${options.execDelayMs}`,
    `-hudhidden=${match.hudHidden}`,
    ...(match.exec ? [`-exec=${q(match.exec)}`] : []),
    ...(options.execCmds ? [`-ExecCmds=${q(options.execCmds)}`] : []),
    ...(match.attrRecord ? ['-attrrecord', `-attrrecordhz=${match.attrHz}`] : []),
    ...(options.match?.aiFill ? ['-aifill'] : []),
    ...headlessMatchArgs(options.match),
    ...(options.matchIntervalSec > 0 ? [`-matchinterval=${options.matchIntervalSec}`] : []),
  ];

  return {
    args,
    cwd: path.dirname(options.projectPath),
    executablePath: options.executablePath,
    windowsVerbatimArguments: true,
    autoSaveAvailable: true,
    autoSaveEnabled: false,
    autoSaveMode: 'watch-ws',
  };
}

export function buildStandaloneHeadlessLaunch(options: StandaloneHeadlessLaunchOptions): HeadlessLaunchConfig {
  if (!options.executablePath) {
    return { args: [], error: 'Standalone headless launch needs --standalone-exe or GSM_STANDALONE_EXE.' };
  }

  const match = matchLaunchValues(options);
  const args = [
    ...RENDER_TOKENS[options.render],
    '-log',
    ...(options.logPath ? [`-abslog=${q(options.logPath)}`] : []),
    ...(options.userDir ? [`-UserDir=${q(options.userDir)}`] : []),
    '-blockexitprogram',
    '-autostart',
    `-mapid=${match.mapId}`,
    `-nettype=${match.netType}`,
    `-connmethod=${options.connMethod}`,
    `-autostartdelay=${options.autostartDelayMs}`,
    `-execdelay=${options.execDelayMs}`,
    `-hudhidden=${match.hudHidden}`,
    ...(match.exec ? [`-exec=${q(match.exec)}`] : []),
    ...(options.execCmds ? [`-ExecCmds=${q(options.execCmds)}`] : []),
    ...(match.attrRecord ? ['-attrrecord', `-attrrecordhz=${match.attrHz}`] : []),
    ...(options.match?.aiFill ? ['-aifill'] : []),
    ...headlessMatchArgs(options.match),
    ...(options.matchIntervalSec > 0 ? [`-matchinterval=${options.matchIntervalSec}`] : []),
  ];

  return {
    args,
    cwd: options.cwd ?? path.dirname(options.executablePath),
    executablePath: options.executablePath,
    windowsVerbatimArguments: true,
    autoSaveAvailable: true,
    autoSaveEnabled: false,
    autoSaveMode: 'watch-ws',
  };
}

export function splitArgs(value: string | undefined, preserveQuotes = false): string[] {
  if (!value?.trim()) return [];
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of value) {
    if (quote) {
      if (char === quote) {
        if (preserveQuotes) current += char;
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      if (preserveQuotes) current += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

export function applyHeadlessMatchArgs(
  args: string[],
  match: HeadlessMatchConfig | undefined,
  options: { quoteExec?: boolean } = {},
): string[] {
  if (!match) return args;
  return [
    ...args.filter((arg) => !isMatchManagedArg(arg)),
    '-autostart',
    `-mapid=${match.mapId}`,
    `-nettype=${match.nettype}`,
    ...(match.aiFill ? ['-aifill'] : []),
    ...(match.hudHidden == null ? [] : [`-hudhidden=${match.hudHidden ? 1 : 0}`]),
    `-exec=${options.quoteExec ? q('SetMatchStatus 1') : 'SetMatchStatus 1'}`,
    ...headlessMatchArgs(match),
  ];
}

function headlessMatchArgs(match: HeadlessMatchConfig | undefined): string[] {
  if (!match) return [];
  return [
    `-roster=${buildRosterSpec(match)}`,
  ];
}

function matchLaunchValues(
  options: Pick<
    UeHeadlessLaunchOptions,
    'mapId' | 'netType' | 'hudHidden' | 'attrRecord' | 'attrHz' | 'exec' | 'match'
  >,
): { mapId: number; netType: number; hudHidden: number; attrRecord: boolean; attrHz: number; exec?: string } {
  const match = options.match;
  return {
    mapId: match?.mapId ?? options.mapId,
    netType: match?.nettype ?? options.netType,
    hudHidden: match?.hudHidden == null ? options.hudHidden : match.hudHidden ? 1 : 0,
    attrRecord: options.attrRecord,
    attrHz: options.attrHz,
    exec: options.exec ?? (match ? 'SetMatchStatus 1' : undefined),
  };
}

function isMatchManagedArg(arg: string): boolean {
  const lower = arg.toLowerCase();
  if (lower === '-autostart' || lower === '-aifill' || lower === '-attrrecord') return true;
  return [
    '-mapid=',
    '-map-id=',
    '-nettype=',
    '-net-type=',
    '-hudhidden=',
    '-hud-hidden=',
    '-attrrecordhz=',
    '-attr-hz=',
    '-roster=',
    '-exec=',
  ].some((prefix) => lower.startsWith(prefix));
}

function q(value: string | number): string {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}
