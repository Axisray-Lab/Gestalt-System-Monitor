import path from 'node:path';

export interface HeadlessLaunchConfig {
  args: string[];
  cwd?: string;
  executablePath?: string;
  windowsVerbatimArguments?: boolean;
  autoSaveAvailable?: boolean;
  autoSaveEnabled?: boolean;
  autoSaveMode?: 'attrrecord-log' | 'configured-args' | 'off';
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

  const args = [
    q(options.projectPath),
    '-game',
    ...RENDER_TOKENS[options.render],
    '-log',
    ...(options.logPath ? [`-abslog=${q(options.logPath)}`] : []),
    ...(options.userDir ? [`-UserDir=${q(options.userDir)}`] : []),
    '-blockexitprogram',
    '-autostart',
    `-mapid=${options.mapId}`,
    `-nettype=${options.netType}`,
    `-connmethod=${options.connMethod}`,
    `-autostartdelay=${options.autostartDelayMs}`,
    `-execdelay=${options.execDelayMs}`,
    `-hudhidden=${options.hudHidden}`,
    ...(options.exec ? [`-exec=${q(options.exec)}`] : []),
    ...(options.execCmds ? [`-ExecCmds=${q(options.execCmds)}`] : []),
    ...(options.attrRecord ? ['-attrrecord', `-attrrecordhz=${options.attrHz}`] : []),
    ...(options.matchIntervalSec > 0 ? [`-matchinterval=${options.matchIntervalSec}`] : []),
  ];

  return {
    args,
    cwd: path.dirname(options.projectPath),
    executablePath: options.executablePath,
    windowsVerbatimArguments: true,
    autoSaveAvailable: true,
    autoSaveEnabled: options.attrRecord,
    autoSaveMode: 'attrrecord-log',
  };
}

export function buildStandaloneHeadlessLaunch(options: StandaloneHeadlessLaunchOptions): HeadlessLaunchConfig {
  if (!options.executablePath) {
    return { args: [], error: 'Standalone headless launch needs --standalone-exe or GSM_STANDALONE_EXE.' };
  }

  const args = [
    ...RENDER_TOKENS[options.render],
    '-log',
    ...(options.logPath ? [`-abslog=${q(options.logPath)}`] : []),
    ...(options.userDir ? [`-UserDir=${q(options.userDir)}`] : []),
    '-blockexitprogram',
    '-autostart',
    `-mapid=${options.mapId}`,
    `-nettype=${options.netType}`,
    `-connmethod=${options.connMethod}`,
    `-autostartdelay=${options.autostartDelayMs}`,
    `-execdelay=${options.execDelayMs}`,
    `-hudhidden=${options.hudHidden}`,
    ...(options.exec ? [`-exec=${q(options.exec)}`] : []),
    ...(options.execCmds ? [`-ExecCmds=${q(options.execCmds)}`] : []),
    ...(options.attrRecord ? ['-attrrecord', `-attrrecordhz=${options.attrHz}`] : []),
    ...(options.matchIntervalSec > 0 ? [`-matchinterval=${options.matchIntervalSec}`] : []),
  ];

  return {
    args,
    cwd: options.cwd ?? path.dirname(options.executablePath),
    executablePath: options.executablePath,
    windowsVerbatimArguments: true,
    autoSaveAvailable: true,
    autoSaveEnabled: options.attrRecord,
    autoSaveMode: 'attrrecord-log',
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

function q(value: string | number): string {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}
