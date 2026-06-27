import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
  HeadlessMatchConfig,
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
  match?: HeadlessMatchConfig;
}

export interface LaunchManagerOptions extends SteamDiscoveryOptions {
  createLaunchConfig: (context?: HeadlessLaunchContext) => HeadlessLaunchConfig;
  autoSave: LauncherAutoSaveStatus;
  defaultSaveDir: string;
  resourceBudget: ResourceBudget;
}

interface RecordingState {
  launchId: string;
  targetMatches: number;
  progressPath: string;
  summaryPath: string;
  eventsPath: string;
  consolePath: string;
  stderrPath: string;
  traceDir: string;
  wsUrl?: string;
  process?: ChildProcess;
  completedMatches: number;
  lastError?: string;
}

const MAX_PARALLEL_LAUNCHES = 16;
const MAX_TARGET_MATCHES = 500;
const RECORD_POLL_MS = 3000;

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

  /**
   * Synchronously tear down everything this manager spawned: every still-running
   * launched game (`-blockexitprogram` means only a forced kill frees them) and
   * every recorder child. Call this from the agent's SIGINT/SIGTERM handler so a
   * dying agent does not orphan game windows + recorders. Uses spawnSync because an
   * async `spawn().unref()` kill can be lost when the process exits right after.
   */
  shutdownAll(): void {
    for (const launch of this.launches.values()) {
      if (launch.status !== 'running') continue;
      if (launch.pid > 0) terminateProcessTreeSync(launch.pid);
      launch.status = 'exited';
      launch.exitCode = null;
      launch.signal = 'SIGTERM';
    }
    for (const state of this.recordings.values()) {
      if (state.process?.pid) {
        terminateProcessTreeSync(state.process.pid);
        state.process = undefined;
      }
    }
    this.dispose();
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
    const customMatch = request.match;
    const targetMatches = customMatch ? 1 : normalizeTargetMatches(request.targetMatches ?? request.count);
    if (targetMatches == null) {
      return this.errorResponse(`Target matches must be between 1 and ${MAX_TARGET_MATCHES}.`);
    }

    const parallelism = customMatch ? 1 : normalizeParallelism(request.parallelism ?? request.count, targetMatches);
    if (parallelism == null) {
      return this.errorResponse(
        `Parallel workers must be between 1 and ${Math.min(MAX_PARALLEL_LAUNCHES, targetMatches)}.`,
      );
    }

    const autoSave = request.autoSave ?? (customMatch ? false : this.options.autoSave.enabledByDefault);
    if (targetMatches > parallelism && !autoSave) {
      return this.errorResponse('Batch match counting needs WS telemetry autosave enabled.');
    }
    if (autoSave && !this.options.autoSave.available) {
      return this.errorResponse(this.options.autoSave.reason ?? 'Autosave is not available for this launch profile.');
    }

    const launchMatch = customMatch;
    const preview = this.options.createLaunchConfig({ targetMatches, parallelism, autoSave, match: launchMatch });
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
      recording?: Omit<RecordingState, 'launchId'>;
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
        match: launchMatch,
      });
      if (config.error) return this.errorResponse(config.error);
      const recording = saveDir
        ? {
            targetMatches,
            progressPath: path.join(saveDir, `${workerName}.progress.json`),
            summaryPath: path.join(saveDir, `${workerName}_attribute_summary.json`),
            eventsPath: path.join(saveDir, `${workerName}.events.jsonl`),
            consolePath: path.join(saveDir, `${workerName}.recorder.log`),
            stderrPath: path.join(saveDir, `${workerName}.recorder.err.log`),
            traceDir: path.join(saveDir, workerName),
            completedMatches: 0,
          }
        : undefined;
      launchConfigs.push({ config, logPath, userDir, recording, workerIndex: i });
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
      if (item.recording) {
        this.recordings.set(launch.id, {
          launchId: launch.id,
          ...item.recording,
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
    this.stopRecording(launch.id);
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

  setLaunchWsUrl(launchId: string, wsUrl: string): void {
    const recording = this.recordings.get(launchId);
    if (!recording || !wsUrl) return;
    if (recording.wsUrl === wsUrl && recording.process) return;
    recording.wsUrl = wsUrl;
    if (!recording.process) this.startRecording(recording);
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

    const progress = readJsonFile<{ completed_matches?: number; closed?: boolean }>(state.progressPath);
    const summary = readJsonFile<{ completed_matches?: number }>(state.summaryPath);
    const traceMatches = countTraceMatches(state.traceDir);
    let completedMatches = state.completedMatches;
    if (typeof progress?.completed_matches === 'number' && Number.isFinite(progress.completed_matches)) {
      completedMatches = Math.max(0, Math.floor(progress.completed_matches));
    }
    if (typeof summary?.completed_matches === 'number' && Number.isFinite(summary.completed_matches)) {
      completedMatches = Math.max(completedMatches, Math.floor(summary.completed_matches));
    }
    completedMatches = Math.max(completedMatches, traceMatches);

    let changed = false;
    if (state.completedMatches !== completedMatches) {
      state.completedMatches = completedMatches;
      changed = true;
    }
    if (launch.completedMatches !== state.completedMatches) {
      launch.completedMatches = state.completedMatches;
      changed = true;
    }
    if (
      state.wsUrl &&
      !state.process &&
      launch.status === 'running' &&
      state.completedMatches < state.targetMatches
    ) {
      this.startRecording(state);
      changed = true;
    }
    return changed;
  }

  private startRecording(state: RecordingState): void {
    if (!state.wsUrl || state.process) return;
    try {
      fs.mkdirSync(path.dirname(state.progressPath), { recursive: true });
      fs.mkdirSync(state.traceDir, { recursive: true });
      for (const file of [state.progressPath, state.summaryPath, state.eventsPath, state.consolePath, state.stderrPath]) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* best effort cleanup */
        }
      }
      const recorder = fileURLToPath(new URL('./record-ws.mjs', import.meta.url));
      const args = [
        recorder,
        '--url',
        state.wsUrl,
        '--target',
        String(state.targetMatches),
        '--progress',
        state.progressPath,
        '--summary',
        state.summaryPath,
        '--events',
        state.eventsPath,
        '--trace-dir',
        state.traceDir,
        '--quiet',
      ];
      const stdout = fs.openSync(state.consolePath, 'a');
      const stderr = fs.openSync(state.stderrPath, 'a');
      state.process = spawn(process.execPath, args, {
        stdio: ['ignore', stdout, stderr],
        windowsHide: true,
      });
      state.process.once('exit', (code, signal) => {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
        state.process = undefined;
        if (code && code !== 0) state.lastError = `recorder exited code=${code} signal=${signal ?? ''}`.trim();
      });
      state.process.once('error', (err) => {
        state.lastError = err.message;
        state.process = undefined;
        try {
          fs.closeSync(stdout);
          fs.closeSync(stderr);
        } catch {
          /* stream may already be closed */
        }
      });
      state.process.unref();
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private stopRecording(launchId: string): void {
    const state = this.recordings.get(launchId);
    if (!state?.process?.pid) return;
    terminateProcessTree(state.process.pid);
    state.process = undefined;
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
      this.finalizeAutoSave(batch, launches);
      return true;
    }

    return changed;
  }

  private finalizeAutoSave(batch: HeadlessLaunchBatch, launches: HeadlessLaunch[]): void {
    if (!batch.autoSave || !batch.saveDir) return;
    const workers = launches.map((launch) => {
      const recording = this.recordings.get(launch.id);
      const progress = recording ? readJsonFile(recording.progressPath) : null;
      const summary = recording ? readJsonFile(recording.summaryPath) : null;
      return {
        launchId: launch.id,
        pid: launch.pid,
        wsUrl: recording?.wsUrl,
        completedMatches: launch.completedMatches ?? 0,
        progressPath: recording?.progressPath,
        summaryPath: recording?.summaryPath,
        traceDir: recording?.traceDir,
        recorderError: recording?.lastError,
        progress,
        summary,
      };
    });
    const summaryPath = path.join(batch.saveDir, 'recording-summary.json');
    const payload = {
      schema: 'monitor-autosave-watch-ws/1',
      generatedAt: new Date().toISOString(),
      batch: {
        id: batch.id,
        targetMatches: batch.targetMatches,
        completedMatches: batch.completedMatches,
        parallelism: batch.parallelism,
        status: batch.status,
        startedAt: batch.startedAt,
        completedAt: batch.completedAt,
      },
      workers,
    };
    try {
      fs.writeFileSync(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch {
      /* keep launch status reporting even if autosave summary cannot be written */
    }
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

function readJsonFile<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function countTraceMatches(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => /\.trace\.json$/i.test(name)).length;
  } catch {
    return 0;
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

/**
 * Blocking variant for shutdown paths: the kill must complete before the agent
 * process exits, so the whole game/recorder subtree is actually reaped instead of
 * being orphaned by a fire-and-forget `spawn().unref()`.
 */
function terminateProcessTreeSync(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    /* best effort */
  }
}
