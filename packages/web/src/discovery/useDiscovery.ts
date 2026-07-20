import { ref, onUnmounted } from 'vue';
import {
  AGENT_BROWSER_PORT,
  type AgentBrowserMessage,
  type AgentLauncherStatusMessage,
  type AgentProcessListMessage,
  type DiscoveredProcess,
  type HeadlessMatchConfig,
  type LauncherStatus,
  type LaunchHeadlessResponse,
  type StopHeadlessResponse,
} from '@gsm/protocol';

/**
 * Subscribes to the local discovery agent's WebSocket for the live LAN process
 * list. If the agent isn't running, `connected` stays false and the list is
 * empty — the app still works against the built-in mock.
 */
export function useDiscovery(agentUrl = defaultAgentUrl()) {
  const processes = ref<DiscoveredProcess[]>([]);
  const connected = ref(false);
  const launcherStatus = ref<LauncherStatus | null>(null);
  const launcherBusy = ref(false);
  const launcherError = ref<string | null>(null);
  let ws: WebSocket | null = null;
  let retry: number | null = null;
  const agentHttpBase = agentUrl.replace(/^ws/i, 'http').replace(/\/$/, '');

  function connect() {
    ws = new WebSocket(agentUrl);
    ws.onopen = () => {
      connected.value = true;
      void refreshLauncher();
    };
    ws.onerror = () => (connected.value = false);
    ws.onclose = () => {
      connected.value = false;
      void refreshAgentSnapshot();
      scheduleRetry();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as AgentBrowserMessage;
        if (msg.kind === 'processes') processes.value = msg.processes;
        if (msg.kind === 'launcherStatus') launcherStatus.value = msg.status;
      } catch {
        /* ignore malformed */
      }
    };
  }

  function scheduleRetry() {
    if (retry == null)
      retry = window.setTimeout(() => {
        retry = null;
        void refreshAgentSnapshot();
        connect();
      }, 3000);
  }

  connect();
  onUnmounted(() => {
    ws?.close();
    if (retry != null) window.clearTimeout(retry);
  });

  async function refreshLauncher() {
    try {
      const response = await fetch(`${agentHttpBase}/launcher`);
      const msg = (await response.json()) as AgentLauncherStatusMessage;
      if (msg.kind === 'launcherStatus') launcherStatus.value = msg.status;
      connected.value = true;
      launcherError.value = null;
    } catch (err) {
      connected.value = false;
      launcherError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function refreshAgentSnapshot() {
    try {
      const [launcherResponse, processResponse] = await Promise.all([
        fetch(`${agentHttpBase}/launcher`),
        fetch(`${agentHttpBase}/processes`),
      ]);
      const launcherMsg = (await launcherResponse.json()) as AgentLauncherStatusMessage;
      const processMsg = (await processResponse.json()) as AgentProcessListMessage;
      if (launcherMsg.kind === 'launcherStatus') launcherStatus.value = launcherMsg.status;
      if (processMsg.kind === 'processes') processes.value = processMsg.processes;
      connected.value = true;
      launcherError.value = null;
    } catch {
      connected.value = false;
    }
  }

  async function launchHeadlessMatches(options: {
    targetMatches: number;
    parallelism: number;
    autoSave: boolean;
    force?: boolean;
    match?: HeadlessMatchConfig;
  }): Promise<LaunchHeadlessResponse> {
    launcherBusy.value = true;
    launcherError.value = null;
    try {
      const response = await fetch(`${agentHttpBase}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options),
      });
      const payload = (await response.json()) as LaunchHeadlessResponse;
      launcherStatus.value = payload.status;
      if (!response.ok || !payload.ok) {
        launcherError.value = payload.error ?? 'Launch failed.';
      }
      return payload;
    } catch (err) {
      launcherError.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      launcherBusy.value = false;
    }
  }

  async function stopHeadlessLaunch(id: string): Promise<StopHeadlessResponse> {
    launcherError.value = null;
    try {
      const response = await fetch(`${agentHttpBase}/launch/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const payload = (await response.json()) as StopHeadlessResponse;
      launcherStatus.value = payload.status;
      if (!response.ok || !payload.ok) {
        launcherError.value = payload.error ?? 'Stop failed.';
      }
      return payload;
    } catch (err) {
      launcherError.value = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async function stopHeadlessLaunches(ids: string[]): Promise<void> {
    for (const id of ids) await stopHeadlessLaunch(id);
  }

  return {
    processes,
    connected,
    launcherStatus,
    launcherBusy,
    launcherError,
    refreshLauncher,
    launchHeadlessMatches,
    stopHeadlessLaunch,
    stopHeadlessLaunches,
  };
}

function defaultAgentUrl(): string {
  const override = new URLSearchParams(window.location.search).get('agent')?.trim();
  return override || `ws://localhost:${AGENT_BROWSER_PORT}`;
}
