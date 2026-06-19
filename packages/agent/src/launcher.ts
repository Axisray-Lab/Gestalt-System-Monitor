import { spawn } from 'node:child_process';
import type {
  GameInstallCandidate,
  HeadlessLaunch,
  LaunchHeadlessRequest,
  LaunchHeadlessResponse,
  LauncherStatus,
  ResourceBudget,
} from '@gsm/protocol';
import { ResourceMonitor } from './resources';
import { discoverGameInstalls, type SteamDiscoveryOptions } from './steam';

export interface LaunchManagerOptions extends SteamDiscoveryOptions {
  headlessArgs: string[];
  resourceBudget: ResourceBudget;
}

export class LaunchManager {
  private candidates: GameInstallCandidate[] = [];
  private readonly launches = new Map<string, HeadlessLaunch>();
  private readonly resources: ResourceMonitor;
  private readonly refreshTimer: NodeJS.Timeout;

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
  }

  dispose() {
    clearInterval(this.refreshTimer);
    this.resources.dispose();
  }

  refreshInstalls() {
    this.candidates = discoverGameInstalls(this.options);
  }

  status(): LauncherStatus {
    const install = this.preferredInstall();
    const resources = this.resources.snapshot();
    const launches = [...this.launches.values()].sort((a, b) => b.startedAt - a.startedAt);
    const reason = readyReason(install, resources.recommendedAdditionalMatches);

    return {
      install,
      candidates: this.candidates,
      resources,
      launches,
      headlessArgs: this.options.headlessArgs,
      ready: reason == null,
      reason,
    };
  }

  launch(request: LaunchHeadlessRequest): LaunchHeadlessResponse {
    const count = normalizeCount(request.count);
    if (count == null) return this.errorResponse('Launch count must be between 1 and 16.');

    const install = request.installId
      ? this.candidates.find((candidate) => candidate.id === request.installId) ?? null
      : this.preferredInstall();
    if (!install?.executablePath) {
      return this.errorResponse('Gestalt System is not ready to launch.');
    }

    const resources = this.resources.snapshot();
    if (!request.force && count > resources.recommendedAdditionalMatches) {
      return this.errorResponse(
        `Only ${resources.recommendedAdditionalMatches} additional headless match(es) are recommended with current free resources.`,
      );
    }

    const launched: HeadlessLaunch[] = [];
    for (let i = 0; i < count; i += 1) {
      const launch = this.spawnMatch(install);
      launched.push(launch);
    }
    this.onChange();

    return {
      ok: true,
      status: this.status(),
      launched,
    };
  }

  private preferredInstall(): GameInstallCandidate | null {
    return (
      this.candidates.find((candidate) => candidate.executablePath && candidate.issues.length === 0) ??
      this.candidates[0] ??
      null
    );
  }

  private spawnMatch(install: GameInstallCandidate): HeadlessLaunch {
    const executablePath = install.executablePath!;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const launch: HeadlessLaunch = {
      id,
      pid: -1,
      startedAt: Date.now(),
      installId: install.id,
      executablePath,
      cwd: install.installDir,
      args: this.options.headlessArgs,
      status: 'running',
    };

    try {
      const child = spawn(executablePath, this.options.headlessArgs, {
        cwd: install.installDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });

      launch.pid = child.pid ?? -1;
      child.once('exit', (code, signal) => {
        launch.status = 'exited';
        launch.exitCode = code;
        launch.signal = signal;
        this.onChange();
      });
      child.once('error', (err) => {
        launch.status = 'error';
        launch.error = err.message;
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

  private errorResponse(error: string): LaunchHeadlessResponse {
    return {
      ok: false,
      error,
      status: this.status(),
      launched: [],
    };
  }
}

function readyReason(
  install: GameInstallCandidate | null,
  recommendedAdditionalMatches: number,
): string | undefined {
  if (!install) return 'Gestalt System was not found in configured or Steam libraries.';
  if (!install.executablePath) return install.issues[0] ?? 'No launchable executable was found.';
  if (recommendedAdditionalMatches < 1) return 'Available resources are below the launch budget.';
  return undefined;
}

function normalizeCount(count: number | undefined): number | null {
  const value = count ?? 1;
  if (!Number.isInteger(value) || value < 1 || value > 16) return null;
  return value;
}
