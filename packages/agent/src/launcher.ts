import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GameInstallCandidate,
  HeadlessLaunch,
  HeadlessLaunchBatch,
  LaunchHeadlessRequest,
  LaunchHeadlessResponse,
  LauncherAutoSaveStatus,
  LauncherStatus,
  ResourceBudget,
  StopHeadlessRequest,
  StopHeadlessResponse,
} from '@gsm/protocol';
import type { HeadlessLaunchConfig } from './headless-launch';
import { ResourceMonitor } from './resources';
import { discoverGameInstalls, type SteamDiscoveryOptions } from './steam';

export interface HeadlessLaunchContext {
  batchId?: string;
  workerIndex?: number;
  targetMatches?: number;
  parallelism?: number;
  autoSave?: boolean;
  logPath?: string;
  userDir?: string;
}

export interface LaunchManagerOptions extends SteamDiscoveryOptions {
  createLaunchConfig: (context?: HeadlessLaunchContext) => HeadlessLaunchConfig;
  autoSave: LauncherAutoSaveStatus;
  defaultSaveDir: string;
  resourceBudget: ResourceBudget;
}

interface RecordingState {
  launchId: string;
  logPath: string;
  offset: number;
  buffer: string;
  lastGt?: number;
  completedMatches: number;
}

const MAX_PARALLEL_LAUNCHES = 16;
const MAX_TARGET_MATCHES = 500;
const RECORD_POLL_MS = 3000;
const ATTR_RECORD_MARKER = '[ATTR-RECORD]';

export class LaunchManager {
  private candidates: GameInstallCandidate[] = [];
  private readonly launches = new Map<string, HeadlessLaunch>();
  private readonly batches = new Map<string, HeadlessLaunchBatch>();
  private readonly recordings = new Map<string, RecordingState>();
  private readonly resources: ResourceMonitor;
  private readonly refreshTimer: NodeJS.Timeout;
  private readonly recordingTimer: NodeJS.Timeout;

  constructor(
    private readonly options: LaunchManagerOptions,
    private readonly onChange: () => void,
  ) {
    this.resources = new ResourceMonitor(options.resourceBudget);
    this.refreshInstalls();
    this.refreshTimer = setInterval(() => {
      this.refreshInstalls();
      this.onChange();
    }, 15000);
    this.refreshTimer.unref?.();
    this.recordingTimer = setInterval(() => this.refreshRecordings(), RECORD_POLL_MS);
    this.recordingTimer.unref?.();
  }

  dispose() {
    clearInterval(this.refreshTimer);
    clearInterval(this.recordingTimer);
    this.resources.dispose();
  }

  refreshInstalls() {
    this.candidates = discoverGameInstalls(this.options);
  }

  status(): LauncherStatus {
    const install = this.preferredInstall();
    const resources = this.resources.snapshot();
    const launches = [...this.launches.values()].sort((a, b) => b.startedAt - a.startedAt);
    const preview = this.options.createLaunchConfig();
    const reason = readyReason(install, resources.recommendedAdditionalMatches, preview.error);

    return {
      install,
      candidates: this.candidates,
      resources,
      launches,
      batches: [...this.batches.values()].sort((a, b) => b.startedAt - a.startedAt),
      headlessArgs: preview.args,
      autoSave: this.options.autoSave,
      ready: reason == null,
      reason,
    };
  }

  launch(request: LaunchHeadlessRequest): LaunchHeadlessResponse {
    const targetMatches = normalizeTargetMatches(request.targetMatches ?? request.count);
    if (targetMatches == null) {
      return this.errorResponse(`Target matches must be between 1 and ${MAX_TARGET_MATCHES}.`);
    }

    const parallelism = normalizeParallelism(request.parallelism ?? request.count, targetMatches);
    if (parallelism == null) {
      return this.errorResponse(
        `Parallel workers must be between 1 and ${Math.min(MAX_PARALLEL_LAUNCHES, targetMatches)}.`,
      );
    }

    const autoSave = request.autoSave ?? this.options.autoSave.enabledByDefault;
    if (targetMatches > parallelism && !autoSave) {
      return this.errorResponse('Batch match counting needs autosave/ATTR-RECORD enabled.');
    }
    if (autoSave && !this.options.autoSave.available) {
      return this.errorResponse(this.options.autoSave.reason ?? 'Autosave is not available for this launch profile.');
    }

    const preview = this.options.createLaunchConfig({ targetMatches, parallelism, autoSave });
    if (preview.error) return this.errorResponse(preview.error);

    const install = request.installId
      ? this.candidates.find((candidate) => candidate.id === request.installId) ?? null
      : this.preferredInstall();
    if (!install?.executablePath) {
      return this.errorResponse('Gestalt System is not ready to launch.');
    }

    const resources = this.resources.snapshot();
    if (!request.force && parallelism > resources.recommendedAdditionalMatches) {
      return this.errorResponse(
        `Only ${resources.recommendedAdditionalMatches} additional headless match(es) are recommended with current free resources.`,
      );
    }

    const batchId = newId();
    const saveDir = autoSave ? path.resolve(request.saveDir ?? path.join(this.options.defaultSaveDir, batchId)) : undefined;
    if (saveDir) fs.mkdirSync(saveDir, { recursive: true });

    const launchConfigs: Array<{
      config: HeadlessLaunchConfig;
      logPath?: string;
      userDir?: string;
      workerIndex: number;
    }> = [];
    for (let i = 0; i < parallelism; i += 1) {
      const workerName = `worker-${String(i + 1).padStart(2, '0')}`;
      const logPath = saveDir ? path.join(saveDir, `${workerName}.log`) : undefined;
      const userDir = saveDir ? path.join(saveDir, `${workerName}-user`) : undefined;
      if (userDir) fs.mkdirSync(userDir, { recursive: true });
      const config = this.options.createLaunchConfig({
        batchId,
        workerIndex: i,
        targetMatches,
        autoSave,
        logPath,
        userDir,
      });
      if (config.error) return this.errorResponse(config.error);
      launchConfigs.push({ config, logPath, userDir, workerIndex: i });
    }

    const batch: HeadlessLaunchBatch = {
      id: batchId,
      startedAt: Date.now(),
      targetMatches,
      parallelism,
      autoSave,
      saveDir,
      completedMatches: 0,
      launchIds: [],
      status: 'running',
    };
    this.batches.set(batchId, batch);

    const launched: HeadlessLaunch[] = [];
    for (const item of launchConfigs) {
      const launch = this.spawnMatch(install, batch, item);
      launched.push(launch);
      batch.launchIds.push(launch.id);
      if (item.logPath) {
        this.recordings.set(launch.id, {
          launchId: launch.id,
          logPath: item.logPath,
          offset: 0,
          buffer: '',
          completedMatches: 0,
        });
      }
    }
    this.onChange();

    return {
      ok: true,
      status: this.status(),
      launched,
    };
  }

  stop(request: StopHeadlessRequest): StopHeadlessResponse {
    const launch =
      (request.id ? this.launches.get(request.id) : null) ??
      [...this.launches.values()].find((candidate) => candidate.pid === request.pid);

    if (!launch) return this.stopErrorResponse('Launch was not found.');
    if (launch.status !== 'running') {
      return {
        ok: true,
        status: this.status(),
        stopped: launch,
      };
    }

    terminateProcessTree(launch.pid);
    launch.status = 'exited';
    launch.exitCode = null;
    launch.signal = 'SIGTERM';
    this.refreshBatch(launch.batchId);
    this.onChange();

    return {
      ok: true,
      status: this.status(),
      stopped: launch,
    };
  }

  private preferredInstall(): GameInstallCandidate | null {
    return (
      this.candidates.find((candidate) => candidate.executablePath && candidate.issues.length === 0) ??
      this.candidates[0] ??
      null
    );
  }

  private spawnMatch(
    install: GameInstallCandidate,
    batch: HeadlessLaunchBatch,
    item: { config: HeadlessLaunchConfig; logPath?: string; userDir?: string; workerIndex: number },
  ): HeadlessLaunch {
    const executablePath = item.config.executablePath ?? install.executablePath!;
    const cwd = item.config.cwd ?? install.installDir;
    const id = newId();
    const launch: HeadlessLaunch = {
      id,
      batchId: batch.id,
      pid: -1,
      startedAt: Date.now(),
      installId: install.id,
      executablePath,
      cwd,
      args: item.config.args,
      logPath: item.logPath,
      userDir: item.userDir,
      saveDir: batch.saveDir,
      targetMatches: batch.targetMatches,
      completedMatches: 0,
      autoSave: batch.autoSave,
      status: 'running',
    };

    try {
      const child = spawn(executablePath, item.config.args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: item.config.windowsVerbatimArguments,
        windowsHide: true,
      });

      launch.pid = child.pid ?? -1;
      child.once('exit', (code, signal) => {
        launch.status = 'exited';
        launch.exitCode = code;
        launch.signal = signal;
        this.refreshBatch(launch.batchId);
        this.onChange();
      });
      child.once('error', (err) => {
        launch.status = 'error';
        launch.error = err.message;
        this.refreshBatch(launch.batchId);
        this.onChange();
      });
      child.unref();
    } catch (err) {
      launch.status = 'error';
      launch.error = err instanceof Error ? err.message : String(err);
    }

    this.launches.set(id, launch);
    return launch;
  }

  private refreshRecordings(): void {
    let changed = false;
    for (const state of this.recordings.values()) {
      changed = this.refreshRecording(state) || changed;
    }
    for (const batch of this.batches.values()) {
      changed = this.refreshBatch(batch.id) || changed;
    }
    if (changed) this.onChange();
  }

  private refreshRecording(state: RecordingState): boolean {
    const launch = this.launches.get(state.launchId);
    if (!launch || launch.status === 'error') return false;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(state.logPath);
    } catch {
      return false;
    }

    if (stat.size < state.offset) {
      state.offset = 0;
      state.buffer = '';
      state.lastGt = undefined;
      state.completedMatches = 0;
    }
    if (stat.size === state.offset) return false;

    let changed = false;
    const fd = fs.openSync(state.logPath, 'r');
    try {
      while (state.offset < stat.size) {
        const len = Math.min(256 * 1024, stat.size - state.offset);
        const chunk = Buffer.allocUnsafe(len);
        const read = fs.readSync(fd, chunk, 0, len, state.offset);
        if (read <= 0) break;
        state.offset += read;
        changed = processRecordingText(state, chunk.toString('utf8', 0, read)) || changed;
      }
    } finally {
      fs.closeSync(fd);
    }

    if (launch.completedMatches !== state.completedMatches) {
      launch.completedMatches = state.completedMatches;
      changed = true;
    }
    return changed;
  }

  private refreshBatch(batchId: string | undefined): boolean {
    if (!batchId) return false;
    const batch = this.batches.get(batchId);
    if (!batch) return false;

    const launches = batch.launchIds
      .map((id) => this.launches.get(id))
      .filter((launch): launch is HeadlessLaunch => Boolean(launch));
    const completedMatches = launches.reduce((sum, launch) => sum + (launch.completedMatches ?? 0), 0);
    let changed = false;

    if (batch.completedMatches !== completedMatches) {
      batch.completedMatches = completedMatches;
      changed = true;
    }

    if (batch.status !== 'running') return changed;

    if (completedMatches >= batch.targetMatches) {
      batch.status = 'complete';
      batch.completedAt = Date.now();
      for (const launch of launches) {
        if (launch.status === 'running') {
          terminateProcessTree(launch.pid);
          launch.status = 'exited';
          launch.exitCode = null;
          launch.signal = 'SIGTERM';
        }
      }
      this.finalizeAutoSave(batch, launches);
      return true;
    }

    if (launches.length > 0 && launches.every((launch) => launch.status !== 'running')) {
      batch.status = launches.some((launch) => launch.status === 'error') ? 'error' : 'exited';
      batch.completedAt = Date.now();
      batch.error =
        batch.status === 'error'
          ? launches.find((launch) => launch.error)?.error ?? 'One or more headless workers failed.'
          : undefined;
      return true;
    }

    return changed;
  }

  private finalizeAutoSave(batch: HeadlessLaunchBatch, launches: HeadlessLaunch[]): void {
    if (!batch.autoSave || !batch.saveDir) return;
    const lines: string[] = [];
    for (const launch of launches) {
      if (!launch.logPath) continue;
      try {
        const text = fs.readFileSync(launch.logPath, 'utf8');
        for (const line of text.split(/\r?\n/)) {
          if (line.includes(ATTR_RECORD_MARKER)) lines.push(line);
        }
      } catch {
        /* keep the other worker logs */
      }
    }

    if (lines.length === 0) return;
    const combinedLog = path.join(batch.saveDir, 'combined.log');
    fs.writeFileSync(combinedLog, `${lines.join('\n')}\n`, 'utf8');

    const analyzer = fileURLToPath(new URL('./analyze-trace.mjs', import.meta.url));
    const child = spawn(process.execPath, [analyzer, combinedLog, '--out', batch.saveDir], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }

  private errorResponse(error: string): LaunchHeadlessResponse {
    return {
      ok: false,
      error,
      status: this.status(),
      launched: [],
    };
  }

  private stopErrorResponse(error: string): StopHeadlessResponse {
    return {
      ok: false,
      error,
      status: this.status(),
    };
  }
}

function readyReason(
  install: GameInstallCandidate | null,
  recommendedAdditionalMatches: number,
  launchConfigError?: string,
): string | undefined {
  if (launchConfigError) return launchConfigError;
  if (!install) return 'Gestalt System was not found in configured or Steam libraries.';
  if (!install.executablePath) return install.issues[0] ?? 'No launchable executable was found.';
  if (recommendedAdditionalMatches < 1) return 'Available resources are below the launch budget.';
  return undefined;
}

function normalizeTargetMatches(count: number | undefined): number | null {
  const value = count ?? 1;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TARGET_MATCHES) return null;
  return value;
}

function normalizeParallelism(count: number | undefined, targetMatches: number): number | null {
  const value = count ?? 1;
  const max = Math.min(MAX_PARALLEL_LAUNCHES, targetMatches);
  if (!Number.isInteger(value) || value < 1 || value > max) return null;
  return value;
}

function processRecordingText(state: RecordingState, text: string): boolean {
  state.buffer += text;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? '';

  let changed = false;
  for (const line of lines) {
    const record = parseAttrRecord(line);
    if (!record || typeof record.gt !== 'number') continue;
    if (
      state.lastGt != null &&
      record.gt < state.lastGt - 1000 &&
      (record.st == null || record.st === 1)
    ) {
      state.completedMatches += 1;
      changed = true;
    }
    state.lastGt = record.gt;
  }
  return changed;
}

function parseAttrRecord(line: string): { gt?: number; st?: number } | null {
  const marker = line.indexOf(ATTR_RECORD_MARKER);
  if (marker < 0) return null;
  const jsonStart = line.indexOf('{', marker);
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(line.slice(jsonStart)) as { gt?: number; st?: number };
  } catch {
    return null;
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function terminateProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* best effort */
    }
  }
}
