import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { loadEnv, type Plugin } from 'vite';

/**
 * Dev-only: bring up the discovery agent alongside the SPA so a single
 * `npm run dev` runs both — no separate terminal. By default this is the same
 * lightweight service the desktop app uses: real LAN discovery plus launcher.
 * The agent auto-discovers replay datasets under ./traces.
 *
 * Override with the GSM_AGENT env var (e.g. `GSM_AGENT="--mock"`, or
 * `GSM_AGENT="--trace-dirs traces/multi-15 --trace-loop"` for replay data). Set
 * `GSM_AGENT=off` to not spawn it (when you run the agent yourself).
 */
function gsmAgent(): Plugin {
  const DEFAULT_ARGS = '';
  const DEFAULT_AGENT_PORT = 7788;
  let child: ChildProcess | null = null;
  let ownerToken: string | null = null;
  let stopPromise: Promise<void> | null = null;
  return {
    name: 'gsm-agent',
    // Dev server only — NOT during `vitest` (which also runs a serve-like env and
    // would otherwise spawn a second agent that collides on the agent's port).
    // Desktop mode delegates agent ownership to the Rust lifecycle coordinator.
    apply: (_config, env) =>
      env.command === 'serve' &&
      env.mode !== 'test' &&
      env.mode !== 'desktop' &&
      !process.env.VITEST,
    async configureServer(server) {
      const cfg = process.env.GSM_AGENT ?? DEFAULT_ARGS;
      if (cfg.trim().toLowerCase() === 'off') return;
      const args = cfg.trim() ? cfg.trim().split(/\s+/) : [];
      const port = agentPortFromArgs(args) ?? DEFAULT_AGENT_PORT;
      const running = await localServiceStatus(port);
      if (running === 'current') {
        server.config.logger.info(`[gsm-agent] local service already running on localhost:${port}`);
        return;
      }
      if (running === 'stale') {
        server.config.logger.error(
          `[gsm-agent] localhost:${port} is occupied by an incompatible service; leaving it untouched`,
        );
        return;
      }
      const root = fileURLToPath(new URL('../..', import.meta.url));
      const isWin = process.platform === 'win32';
      const token = randomUUID();
      const spawned = spawn('npm', ['run', 'agent', '--', ...args], {
        cwd: root,
        stdio: 'inherit',
        shell: isWin,
        env: { ...process.env, GSM_OWNER_TOKEN: token },
      });
      child = spawned;
      ownerToken = token;
      spawned.on('error', (e) =>
        server.config.logger.error(`[gsm-agent] failed to start: ${e.message}`)
      );
      spawned.once('exit', () => {
        if (child === spawned) {
          child = null;
          ownerToken = null;
        }
      });

      const killOwnedAgentSync = (): void => {
        const owned = child;
        child = null;
        ownerToken = null;
        if (!owned) return;
        terminateOwnedChildSync(owned, isWin);
      };
      const stopOwnedAgent = (): Promise<void> => {
        if (stopPromise) return stopPromise;
        const owned = child;
        const tokenForChild = ownerToken;
        if (!owned || !tokenForChild) return Promise.resolve();
        stopPromise = (async () => {
          const accepted = await requestOwnedAgentShutdown(port, tokenForChild);
          if (accepted) await waitForChildExit(owned, 2000);
          if (isChildRunning(owned)) terminateOwnedChildSync(owned, isWin);
          if (child === owned) {
            child = null;
            ownerToken = null;
          }
        })().finally(() => {
          stopPromise = null;
        });
        return stopPromise;
      };

      server.httpServer?.once('close', () => void stopOwnedAgent());
      process.once('exit', killOwnedAgentSync);
      process.once('SIGINT', () => void stopOwnedAgent().finally(() => process.exit(0)));
      process.once('SIGTERM', () => void stopOwnedAgent().finally(() => process.exit(0)));
    },
  };
}

function isChildRunning(child: ChildProcess): boolean {
  return child.pid != null && child.exitCode == null && child.signalCode == null;
}

function terminateOwnedChildSync(child: ChildProcess, isWin: boolean): void {
  if (!isChildRunning(child) || child.pid == null) return;
  if (isWin) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* best effort */
  }
}

async function requestOwnedAgentShutdown(port: number, ownerToken: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(`http://localhost:${port}/shutdown`, {
      method: 'POST',
      headers: { 'x-gsm-owner-token': ownerToken },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isChildRunning(child)) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timeout);
      child.off('exit', done);
      resolve();
    };
    const timeout = setTimeout(done, timeoutMs);
    child.once('exit', done);
  });
}

function agentPortFromArgs(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--port=')) {
      const port = Number(arg.slice('--port='.length));
      return Number.isInteger(port) && port > 0 ? port : undefined;
    }
    if (arg === '--port') {
      const port = Number(args[i + 1]);
      return Number.isInteger(port) && port > 0 ? port : undefined;
    }
  }
  return undefined;
}

async function localServiceStatus(port: number): Promise<'current' | 'stale' | 'offline'> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  let response: Response;
  try {
    response = await fetch(`http://localhost:${port}/launcher`, {
      signal: controller.signal,
    });
  } catch {
    return 'offline';
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) return 'stale';
  try {
    const payload = await response.json() as {
      kind?: string;
      status?: { autoSave?: unknown; batches?: unknown };
    };
    if (payload.kind !== 'launcherStatus') return 'stale';
    return payload.status?.autoSave && Array.isArray(payload.status?.batches) ? 'current' : 'stale';
  } catch {
    return 'stale';
  }
}

/**
 * Dev-only perf telemetry sink. The SPA POSTs its per-window perf stats to
 * `/__perf/log` and we append them to `packages/web/perf-telemetry.log` (JSONL,
 * gitignored). This lets the *real* browser/GPU numbers be read straight off the
 * filesystem — WebGL perf can't be measured through a headless preview. A
 * `{type:'reset'}` beacon (sent on page load) truncates the file so each run
 * starts clean. Scoped to one path; never runs in build or vitest.
 */
function gsmPerfSink(): Plugin {
  const logPath = fileURLToPath(new URL('./perf-telemetry.log', import.meta.url));
  return {
    name: 'gsm-perf-sink',
    apply: (_config, env) => env.command === 'serve' && env.mode !== 'test' && !process.env.VITEST,
    configureServer(server) {
      server.middlewares.use('/__perf/log', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1_000_000) req.destroy(); // guard against runaway bodies
        });
        req.on('end', () => {
          void (async () => {
            try {
              const msg = JSON.parse(body);
              if (msg?.type === 'reset') await writeFile(logPath, '');
              else await appendFile(logPath, JSON.stringify(msg) + '\n');
            } catch {
              /* ignore malformed beacons */
            }
          })();
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const env = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(env)) {
    process.env[key] ??= value;
  }

  return {
  // Relative base only for the production build, so the built pages (deck.html /
  // index.html) and their /assets/* resolve when loaded from a non-root origin —
  // e.g. inside the Tauri webview's asset protocol. The dev server keeps an
  // absolute base so `npm run dev` / HMR are unchanged.
  base: command === 'build' ? './' : '/',
  plugins: [vue(), gsmAgent(), gsmPerfSink()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Consume the shared protocol package straight from source (no build step).
      '@gsm/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        // Two independent pages: the monitor (index) and the dock-strip deck.
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        deck: fileURLToPath(new URL('./deck.html', import.meta.url)),
      },
    },
  },
  server: {
    host: '0.0.0.0', // reachable across the LAN, like the game's own dev server
    port: 5180,
    strictPort: false,
  },
  };
});
