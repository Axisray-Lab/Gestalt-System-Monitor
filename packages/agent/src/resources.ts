import os from 'node:os';
import type { HostResourceSnapshot, ResourceBudget } from '@gsm/protocol';

interface CpuSample {
  idle: number;
  total: number;
}

const CPU_EMA_ALPHA = 0.18;
const SLOT_DECREASE_HOLD_MS = 4000;
const SLOT_INCREASE_HOLD_MS = 10000;

export class ResourceMonitor {
  private lastCpu?: CpuSample;
  private rawCpuUsedPercent?: number;
  private smoothedCpuUsedPercent?: number;
  private stableRecommendedMatches?: number;
  private pendingRecommendedMatches?: { value: number; since: number };
  private timer: NodeJS.Timeout;

  constructor(private readonly budget: ResourceBudget) {
    this.sampleCpu();
    this.timer = setInterval(() => this.sampleCpu(), 1500);
    this.timer.unref?.();
  }

  dispose() {
    clearInterval(this.timer);
  }

  snapshot(): HostResourceSnapshot {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = percent(usedBytes, totalBytes);
    const freePercent = percent(freeBytes, totalBytes);
    const logicalCores = Math.max(1, os.cpus().length);
    const cpuFreePercent =
      this.smoothedCpuUsedPercent == null
        ? undefined
        : clamp(100 - this.smoothedCpuUsedPercent, 0, 100);

    const memoryMatches = Math.floor(
      Math.max(0, freeBytes - this.budget.reservedMemoryBytes) / this.budget.perMatchMemoryBytes,
    );
    const cpuFreeCores =
      cpuFreePercent == null ? logicalCores : (logicalCores * cpuFreePercent) / 100;
    const cpuMatches = Math.floor(cpuFreeCores / this.budget.perMatchCpuCores);
    const sampledMatches = Math.max(0, Math.min(memoryMatches, cpuMatches));
    const recommendedAdditionalMatches = this.stabilizeRecommendedMatches(sampledMatches);

    return {
      capturedAt: Date.now(),
      platform: os.platform(),
      memory: {
        totalBytes,
        freeBytes,
        usedBytes,
        usedPercent,
        freePercent,
      },
      cpu: {
        logicalCores,
        usedPercent: this.smoothedCpuUsedPercent,
        freePercent: cpuFreePercent,
        rawUsedPercent: this.rawCpuUsedPercent,
        rawFreePercent:
          this.rawCpuUsedPercent == null ? undefined : clamp(100 - this.rawCpuUsedPercent, 0, 100),
      },
      budget: this.budget,
      sampledAdditionalMatches: sampledMatches,
      recommendedAdditionalMatches,
    };
  }

  private sampleCpu() {
    const current = readCpuSample();
    if (this.lastCpu) {
      const idleDelta = current.idle - this.lastCpu.idle;
      const totalDelta = current.total - this.lastCpu.total;
      if (totalDelta > 0) {
        this.rawCpuUsedPercent = clamp((1 - idleDelta / totalDelta) * 100, 0, 100);
        this.smoothedCpuUsedPercent =
          this.smoothedCpuUsedPercent == null
            ? this.rawCpuUsedPercent
            : this.smoothedCpuUsedPercent * (1 - CPU_EMA_ALPHA) +
              this.rawCpuUsedPercent * CPU_EMA_ALPHA;
      }
    }
    this.lastCpu = current;
  }

  private stabilizeRecommendedMatches(sampledMatches: number): number {
    const now = Date.now();
    if (this.stableRecommendedMatches == null) {
      this.stableRecommendedMatches = sampledMatches;
      return sampledMatches;
    }

    if (sampledMatches === this.stableRecommendedMatches) {
      this.pendingRecommendedMatches = undefined;
      return this.stableRecommendedMatches;
    }

    if (this.pendingRecommendedMatches?.value !== sampledMatches) {
      this.pendingRecommendedMatches = { value: sampledMatches, since: now };
      return this.stableRecommendedMatches;
    }

    const holdMs =
      sampledMatches < this.stableRecommendedMatches
        ? SLOT_DECREASE_HOLD_MS
        : SLOT_INCREASE_HOLD_MS;
    if (now - this.pendingRecommendedMatches.since >= holdMs) {
      this.stableRecommendedMatches = sampledMatches;
      this.pendingRecommendedMatches = undefined;
    }

    return this.stableRecommendedMatches;
  }
}

function readCpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return clamp((value / total) * 100, 0, 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
