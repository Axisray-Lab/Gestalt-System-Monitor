<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDiscovery } from '@/discovery/useDiscovery';
import { useMatches, type MatchHooks } from '@/feed/useMatches';
import { DioramaScene } from '@/three/DioramaScene';
import MatchList from '@/components/MatchList.vue';

const { processes, connected } = useDiscovery();

// Single source of truth for which unit is focused. Two-way synced with the
// scene: the sidebar/Esc/clicks all funnel through here, and the scene reports
// its own click-focus back via onFocusChange (the focus() call is idempotent,
// so the watch re-driving the scene is a harmless no-op).
const focusedKey = ref<string | null>(null);

const host = ref<HTMLDivElement>();
let scene: DioramaScene | null = null;

// Hooks forward feed lifecycle into the scene. `scene` is assigned in onMounted,
// and start() (which first triggers these) is only called after that — so the
// closures always see a live scene.
const hooks: MatchHooks = {
  onAdd: (key, label) => scene?.addUnit(key, label),
  onRemove: (key) => scene?.removeUnit(key),
  onMap: (key, map) => scene?.setMap(key, map),
  onSnapshot: (key, snap) => scene?.updateSnapshot(key, snap),
};
const { matches, start } = useMatches(processes, hooks);

watch(focusedKey, (k) => scene?.applyFocus(k));

onMounted(() => {
  scene = new DioramaScene(host.value!, {
    onFocusChange: (k) => (focusedKey.value = k),
  });
  start();
});

onBeforeUnmount(() => {
  scene?.dispose();
  scene = null;
});
</script>

<template>
  <div class="app">
    <MatchList
      :matches="matches"
      :focused-key="focusedKey"
      :agent-connected="connected"
      @focus="focusedKey = $event"
      @overview="focusedKey = null"
    />
    <main class="stage">
      <div ref="host" class="canvas-host" />
    </main>
  </div>
</template>
