export interface GameInstallCandidate {
  id: string;
  source: 'steam' | 'configured';
  name: string;
  installDir: string;
  executablePath?: string;
  steamAppId?: string;
  libraryPath?: string;
  manifestPath?: string;
  issues: string[];
}

export interface ResourceBudget {
  perMatchMemoryBytes: number;
  perMatchCpuCores: number;
  reservedMemoryBytes: number;
}

export interface HostResourceSnapshot {
  capturedAt: number;
  platform: string;
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    freePercent: number;
  };
  cpu: {
    logicalCores: number;
    usedPercent?: number;
    freePercent?: number;
    rawUsedPercent?: number;
    rawFreePercent?: number;
  };
  budget: ResourceBudget;
  sampledAdditionalMatches?: number;
  recommendedAdditionalMatches: number;
}

export interface HeadlessLaunch {
  id: string;
  batchId?: string;
  pid: number;
  startedAt: number;
  installId: string;
  executablePath: string;
  cwd: string;
  args: string[];
  logPath?: string;
  userDir?: string;
  saveDir?: string;
  targetMatches?: number;
  completedMatches?: number;
  autoSave?: boolean;
  status: 'running' | 'exited' | 'error';
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}

export interface HeadlessLaunchBatch {
  id: string;
  startedAt: number;
  targetMatches: number;
  parallelism: number;
  autoSave: boolean;
  saveDir?: string;
  completedMatches: number;
  launchIds: string[];
  status: 'running' | 'complete' | 'exited' | 'error';
  completedAt?: number;
  error?: string;
}

export interface LauncherAutoSaveStatus {
  available: boolean;
  enabledByDefault: boolean;
  mode: 'attrrecord-log' | 'configured-args' | 'off';
  defaultSaveDir?: string;
  reason?: string;
}

export interface LauncherStatus {
  install: GameInstallCandidate | null;
  candidates: GameInstallCandidate[];
  resources: HostResourceSnapshot;
  launches: HeadlessLaunch[];
  batches: HeadlessLaunchBatch[];
  headlessArgs: string[];
  autoSave: LauncherAutoSaveStatus;
  ready: boolean;
  reason?: string;
}

export interface AgentLauncherStatusMessage {
  kind: 'launcherStatus';
  status: LauncherStatus;
}

import type { HeadlessMatchConfig } from './team';

export interface LaunchHeadlessRequest {
  /** Back-compat: when targetMatches/parallelism are absent, count is used for both. */
  count?: number;
  /** Total matches this batch should run before the agent stops its worker process(es). */
  targetMatches?: number;
  /** Number of headless worker processes to run concurrently for this batch. */
  parallelism?: number;
  installId?: string;
  autoSave?: boolean;
  saveDir?: string;
  force?: boolean;
  /** Optional custom-match roster. When set, the agent launches one match with
   *  this config (the roster is passed as an autostart parameter). */
  match?: HeadlessMatchConfig;
}

export interface LaunchHeadlessResponse {
  ok: boolean;
  status: LauncherStatus;
  launched: HeadlessLaunch[];
  error?: string;
}

export interface StopHeadlessRequest {
  id?: string;
  pid?: number;
}

export interface StopHeadlessResponse {
  ok: boolean;
  status: LauncherStatus;
  stopped?: HeadlessLaunch;
  error?: string;
}
