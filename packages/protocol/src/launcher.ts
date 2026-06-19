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
  pid: number;
  startedAt: number;
  installId: string;
  executablePath: string;
  cwd: string;
  args: string[];
  status: 'running' | 'exited' | 'error';
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}

export interface LauncherStatus {
  install: GameInstallCandidate | null;
  candidates: GameInstallCandidate[];
  resources: HostResourceSnapshot;
  launches: HeadlessLaunch[];
  headlessArgs: string[];
  ready: boolean;
  reason?: string;
}

export interface AgentLauncherStatusMessage {
  kind: 'launcherStatus';
  status: LauncherStatus;
}

export interface LaunchHeadlessRequest {
  count?: number;
  installId?: string;
  force?: boolean;
}

export interface LaunchHeadlessResponse {
  ok: boolean;
  status: LauncherStatus;
  launched: HeadlessLaunch[];
  error?: string;
}
