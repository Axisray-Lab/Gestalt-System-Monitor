<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDiscovery } from '@/discovery/useDiscovery';
import { useMatches, type MatchHooks } from '@/feed/useMatches';
import { DeckScene } from '@/three/DeckScene';
import { renderArenaThumbnail } from '@/three/arenaThumbnail';
import DeckStrip from '@/components/DeckStrip.vue';

const { processes } = useDiscovery();
const openedKey = ref<string | null>(null);
const thumb = ref<string | null>(null);
const stageHost = ref<HTMLDivElement>();
let scene: DeckScene | null = null;

const hooks: MatchHooks = {
  onAdd: (key, label) => scene?.addUnit(key, label),
  onRemove: (key) => scene?.removeUnit(key),
  onMap: (key, map) => scene?.setMap(key, map),
  onSnapshot: (key, snap) => scene?.updateSnapshot(key, snap),
};
const { matches, start } = useMatches(processes, hooks, { mockCount: 7 });

watch(openedKey, (k) => (k ? scene?.show(k) : scene?.hide()));

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') openedKey.value = null;
}

onMounted(() => {
  scene = new DeckScene(stageHost.value!);
  start();
  renderArenaThumbnail('RMUC2026AI').then((url) => (thumb.value = url));
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  scene?.dispose();
  scene = null;
});
</script>

<template>
  <div class="deckapp" :class="{ opened: openedKey !== null }">
    <div class="deck-stage"><div ref="stageHost" class="deck-stage-host" /></div>
    <div class="deck-dock">
      <DeckStrip
        :matches="matches"
        :focused-key="openedKey"
        :thumb="thumb"
        @focus="openedKey = $event"
      />
    </div>
    <div class="deck-topbar">
      <span class="deck-brand">Match<span>·</span>Deck</span>
      <button v-if="openedKey !== null" class="deck-back" @click="openedKey = null">← 返回甲板</button>
    </div>
  </div>
</template>

<style scoped>
.deckapp {
  position: absolute;
  inset: 0;
  background: var(--bg);
  overflow: hidden;
}
.deck-stage {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 240px;
  opacity: 0;
  transform: scale(0.82) translateY(40px);
  transform-origin: 50% 100%;
  pointer-events: none;
  transition: opacity 0.45s ease, transform 0.5s cubic-bezier(0.2, 0.7, 0.2, 1);
}
.deckapp.opened .deck-stage {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.deck-stage-host {
  position: absolute;
  inset: 0;
}
.deck-dock {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 240px;
  border-top: 1px solid var(--line);
  background: rgba(11, 15, 20, 0.55);
  transition: transform 0.45s ease, opacity 0.45s ease;
}
.deckapp.opened .deck-dock {
  transform: translateY(150px);
  opacity: 0.5;
}
.deck-topbar {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  z-index: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  pointer-events: none;
}
.deck-brand {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--text);
}
.deck-brand span {
  color: var(--accent);
  margin: 0 3px;
}
.deck-back {
  pointer-events: auto;
  background: rgba(19, 26, 34, 0.85);
  border: 1px solid var(--line);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}
.deck-back:hover {
  border-color: var(--accent);
}
</style>
