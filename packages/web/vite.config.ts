import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

/**
 * Dev-only: bring up the discovery agent alongside the SPA so a single
 * `npm run dev` runs both — no separate terminal. The agent listens for real LAN
 * matches AND auto-replays the local recorded datasets (multi-1 / multi-15 /
 * multi-50) as stacked packets, so the monitor shows content without depending on
 * live discovery.
 *
 * Override with the GSM_AGENT env var (e.g. `GSM_AGENT="--mock"`, or
 * `GSM_AGENT="--trace-dirs traces/multi-15"` for a lighter set). Set
 * `GSM_AGENT=off` to not spawn it (when you run the agent yourself).
 */
function gsmAgent(): Plugin {
  // --trace-loop: the local datasets are a persistent "match view", so loop them
  // continuously — otherwise each recording plays once, ends, and its pieces drop
  // out after the stale timeout.
  const DEFAULT_ARGS =
    '--trace-dirs traces/human-play,traces/multi-1,traces/multi-15,traces/multi-50 --trace-loop';
  let child: ChildProcess | null = null;
  return {
    name: 'gsm-agent',
    // Dev server only — NOT during `vitest` (which also runs a serve-like env and
    // would otherwise spawn a second agent that collides on the agent's port).
    apply: (_config, env) => env.command === 'serve' && env.mode !== 'test' && !process.env.VITEST,
    configureServer(server) {
      const cfg = process.env.GSM_AGENT ?? DEFAULT_ARGS;
      if (cfg.trim().toLowerCase() === 'off') return;
      const args = cfg.trim() ? cfg.trim().split(/\s+/) : [];
      const root = fileURLToPath(new URL('../..', import.meta.url));
      const isWin = process.platform === 'win32';
      child = spawn('npm', ['run', 'agent', '--', ...args], {
        cwd: root,
        stdio: 'inherit',
        shell: isWin,
      });
      child.on('error', (e) =>
        server.config.logger.error(`[gsm-agent] failed to start: ${e.message}`)
      );
      const kill = (): void => {
        const c = child;
        child = null;
        if (!c || c.killed || c.pid == null) return;
        // npm spawns a process tree (npm → tsx → node); kill the whole tree.
        if (isWin) {
          try { spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); }
          catch { /* best effort */ }
        } else {
          try { c.kill('SIGTERM'); } catch { /* best effort */ }
        }
      };
      server.httpServer?.once('close', kill);
      process.once('exit', kill);
      process.once('SIGINT', () => { kill(); process.exit(0); });
      process.once('SIGTERM', () => { kill(); process.exit(0); });
    },
  };
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
export default defineConfig({
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
});
