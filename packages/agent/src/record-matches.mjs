#!/usr/bin/env node
/**
 * Smart match recorder: launches ONE UE process and monitors the log for
 * match boundaries via ATTR-RECORD data. When N matches have been recorded,
 * kills the UE process and extracts ATTR-RECORD lines.
 *
 * Match detection: when `gt` (game time) drops by >1000ms vs previous frame,
 * it's a new match (same logic as analyze-trace.mjs).
 *
 * Usage: node record-matches.mjs --count 15 --out traces/multi-15
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildUeLaunch, ueLaunchLine } from './ue-launch-args.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const has = (flag) => args.includes(flag);
  return {
    count: parseInt(get('--count') ?? '5', 10),
    out: get('--out') ?? 'traces/recorded',
    mapId: get('--mapid') ?? '9',
    ueExe: get('--ue-exe') ?? 'C:/UE57_v3/Engine/Binaries/Win64/UnrealEditor.exe',
    uproject: get('--uproject') ?? 'C:/Users/Chclk/Documents/Unreal Projects/gestalt_system/RobotBridgeDemo.uproject',
    matchTimeoutMin: parseInt(get('--match-timeout-min') ?? '10', 10),
    // attrrecord sample rate (Hz); kept at 10 to match historical traces.
    hz: get('--hz') ?? '10',
    // HUD override: 0=visible (nullrhi ignores render anyway), 1=hidden.
    hudHidden: get('--hudhidden') ?? '0',
    // >0 → pass -matchinterval=<sec> ("打完重开"): robust continuous play on maps
    // whose match logic does NOT self-loop (the AI-test map id=9 already loops).
    matchInterval: get('--match-interval') ?? null,
    verbose: has('--verbose'),
  };
}

function parseLine(line) {
  const i = line.indexOf('[ATTR-RECORD]');
  if (i < 0) return null;
  const j = line.indexOf('{', i);
  if (j < 0) return null;
  try { return JSON.parse(line.substring(j)); } catch { return null; }
}

async function main() {
  const cfg = parseArgs();
  console.log(`[recorder] target: ${cfg.count} matches → ${cfg.out}`);
  console.log(`[recorder] engine: ${cfg.ueExe}`);
  console.log(`[recorder] project: ${cfg.uproject}`);

  const root = path.dirname(cfg.uproject);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const logDir = path.join(root, 'Saved', 'ai-selftest');
  // Per-run abslog (parallel-safe); UE writes the full log here, ATTR-RECORD included.
  const logPath = path.join(logDir, `record_${stamp}.log`);
  const userDir = path.join(logDir, `userdir_${stamp}`);

  await mkdir(logDir, { recursive: true });
  await mkdir(userDir, { recursive: true });

  // Build the SAME command line ai-match-selftest.ps1 uses (equals+quoted, passed
  // verbatim). Space-form flag/value pairs via spawn leave stray positionals that
  // UE -game loads as a map → "load default map?" → headless exit. See
  // ue-launch-args.mjs for the full write-up of that pitfall.
  const { args: ueArgs, spawnOptions } = buildUeLaunch({
    uproject: cfg.uproject,
    mapId: cfg.mapId,
    userDir,
    logPath,
    render: 'nullrhi',
    attrHz: cfg.hz,
    hudHidden: cfg.hudHidden,
    matchIntervalSec: cfg.matchInterval ? Number(cfg.matchInterval) : 0,
  });

  console.log(`[recorder] launching UE (log: ${path.basename(logPath)})`);
  if (cfg.verbose) console.log(`[recorder] cmd: ${ueLaunchLine(cfg.ueExe, ueArgs)}`);
  const proc = spawn(cfg.ueExe, ueArgs, {
    cwd: root,
    stdio: 'ignore',
    detached: false,
    windowsHide: true,
    ...spawnOptions,
  });

  console.log(`[recorder] UE PID: ${proc.pid}`);

  // Wait for log file to appear
  let waited = 0;
  while (!existsSync(logPath) && waited < 120) {
    await sleep(2000);
    waited += 2;
  }
  if (!existsSync(logPath)) {
    console.error('[recorder] ERROR: log file never appeared');
    proc.kill('SIGKILL');
    process.exit(1);
  }
  console.log(`[recorder] log file ready after ${waited}s`);

  // Tail the log, counting match boundaries
  let lastGt = 0;
  let matchCount = 0;
  let lastSt = 0;
  let totalLines = 0;
  let lastMatchEndGt = 0;
  const matchStartTimes = [];

  const deadline = Date.now() + (cfg.count * cfg.matchTimeoutMin * 60 * 1000);

  // Re-open tail periodically
  const checkInterval = setInterval(async () => {
    if (proc.exitCode !== null) {
      console.log(`[recorder] UE exited with code ${proc.exitCode}`);
      clearInterval(checkInterval);
      await finalize();
      return;
    }

    if (Date.now() > deadline) {
      console.log(`[recorder] TIMEOUT: ${cfg.count * cfg.matchTimeoutMin}min elapsed`);
      proc.kill('SIGKILL');
      clearInterval(checkInterval);
      await finalize();
      return;
    }

    try {
      const stat = statSync(logPath);
      if (stat.size === 0) return;

      const stream = createReadStream(logPath, {
        encoding: 'utf-8',
        start: Math.max(0, stat.size - 5 * 1024 * 1024), // tail last 5MB
      });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const rec = parseLine(line);
        if (!rec) continue;
        totalLines++;

        // Match boundary: gt drops significantly
        if (rec.gt !== undefined && lastGt > 0 && rec.gt < lastGt - 1000 && rec.st === 1) {
          matchCount++;
          const elapsed = rec.gt > 0 ? (rec.gt / 60000).toFixed(1) : '?';
          matchStartTimes.push(Date.now());
          console.log(`[recorder] MATCH ${matchCount}/${cfg.count} started (prev game lasted ${(lastGt/60000).toFixed(1)}min, gt reset to ${rec.gt})`);
          if (matchCount >= cfg.count) {
            console.log(`[recorder] target reached! ${matchCount} matches detected.`);
            // Let the current match finish (give it some time after the last detection)
            clearInterval(checkInterval);
            setTimeout(async () => {
              proc.kill('SIGKILL');
              await finalize();
            }, 30000); // 30s grace after last match start
            return;
          }
        }

        if (rec.gt !== undefined) lastGt = rec.gt;
        if (rec.st !== undefined) lastSt = rec.st;
      }
    } catch (err) {
      // File may be locked; try again next interval
      if (cfg.verbose) console.error(`[recorder] read error: ${err.message}`);
    }
  }, 15000); // check every 15 seconds

  async function finalize() {
    clearInterval(checkInterval);
    // Force kill if still alive
    try { proc.kill('SIGKILL'); } catch {}

    console.log(`[recorder] UE stopped. Matches detected: ${matchCount}`);

    if (matchCount === 0) {
      console.error('[recorder] ERROR: no matches detected');
      process.exit(1);
    }

    // Extract ATTR-RECORD lines
    console.log('[recorder] extracting ATTR-RECORD lines...');
    const outDir = path.resolve(cfg.out);
    await mkdir(outDir, { recursive: true });

    const combinedLog = path.join(outDir, `combined.log`);
    const stream = createReadStream(logPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const outLines = [];
    for await (const line of rl) {
      if (line.includes('[ATTR-RECORD]')) {
        outLines.push(line);
      }
    }

    await writeFile(combinedLog, outLines.join('\n'), 'utf-8');
    const sizeMB = (Buffer.byteLength(outLines.join('\n')) / 1e6).toFixed(1);
    console.log(`[recorder] wrote ${outLines.length} ATTR-RECORD lines (${sizeMB}MB) → ${combinedLog}`);

    // Run analyze-trace
    console.log('[recorder] analyzing...');
    const { execSync } = await import('node:child_process');
    const analyzeScript = path.join(__dirname, 'analyze-trace.mjs');
    try {
      const result = execSync(
        `node "${analyzeScript}" "${combinedLog}" --out "${outDir}"`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      console.log(result.trim());
    } catch (err) {
      console.error(`[recorder] analyze error: ${err.stderr || err.message}`);
    }

    console.log(`[recorder] DONE. Trace files in: ${outDir}`);
    process.exit(0);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
