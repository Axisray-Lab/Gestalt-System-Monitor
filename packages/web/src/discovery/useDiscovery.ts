import { ref, onUnmounted } from 'vue';
import {
  AGENT_BROWSER_PORT,
  type AgentProcessListMessage,
  type DiscoveredProcess,
} from '@gsm/protocol';

/**
 * Subscribes to the local discovery agent's WebSocket for the live LAN process
 * list. If the agent isn't running, `connected` stays false and the list is
 * empty — the app still works against the built-in mock.
 */
export function useDiscovery(agentUrl = `ws://localhost:${AGENT_BROWSER_PORT}`) {
  const processes = ref<DiscoveredProcess[]>([]);
  const connected = ref(false);
  let ws: WebSocket | null = null;
  let retry: number | null = null;

  function connect() {
    ws = new WebSocket(agentUrl);
    ws.onopen = () => (connected.value = true);
    ws.onerror = () => (connected.value = false);
    ws.onclose = () => {
      connected.value = false;
      scheduleRetry();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as AgentProcessListMessage;
        if (msg.kind === 'processes') processes.value = msg.processes;
      } catch {
        /* ignore malformed */
      }
    };
  }

  function scheduleRetry() {
    if (retry == null)
      retry = window.setTimeout(() => {
        retry = null;
        connect();
      }, 3000);
  }

  connect();
  onUnmounted(() => {
    ws?.close();
    if (retry != null) window.clearTimeout(retry);
  });

  return { processes, connected };
}
