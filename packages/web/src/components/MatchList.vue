<script setup lang="ts">
import type { MatchView } from '@/feed/types';

defineProps<{
  matches: MatchView[];
  focusedKey: string | null;
  agentConnected: boolean;
}>();
const emit = defineEmits<{
  (e: 'focus', key: string): void;
  (e: 'overview'): void;
}>();
</script>

<template>
  <aside class="sidebar">
    <div class="brand">Gestalt<span>·</span>System Monitor</div>

    <button v-if="focusedKey !== null" class="overview-btn" @click="emit('overview')">
      ← Overview
    </button>

    <div class="sec-title">
      Matches
      <span class="dot" :class="{ on: agentConnected }" :title="agentConnected ? 'agent online' : 'agent offline'" />
    </div>

    <div v-if="!agentConnected" class="hint">
      discovery agent offline — showing the built-in mock only. run
      <code>npm run agent</code> (or <code>agent:mock</code>) to see LAN matches
    </div>

    <button
      v-for="m in matches"
      :key="m.key"
      class="proc"
      :class="{ active: m.key === focusedKey }"
      @click="emit('focus', m.key)"
    >
      <span class="s-dot" :data-status="m.status" />
      <span class="proc-text">
        <span class="proc-name">{{ m.label }}</span>
        <span class="proc-sub">
          {{ m.playerCount != null ? m.playerCount + 'p · ' : '' }}{{ m.status }}
        </span>
      </span>
    </button>
  </aside>
</template>
