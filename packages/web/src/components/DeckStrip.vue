<script setup lang="ts">
import { ref, watch } from 'vue';
import type { MatchView } from '@/feed/types';

const props = defineProps<{
  matches: MatchView[];
  focusedKey: string | null;
  thumb: string | null;
}>();
const emit = defineEmits<{ (e: 'focus', key: string): void }>();

const center = ref(0);
const hovered = ref<number | null>(null);
const userMoved = ref(false);

// Keep the deck centred on the middle card until the user first navigates.
watch(
  () => props.matches.length,
  (n) => {
    if (n > 0 && !userMoved.value) center.value = Math.floor((n - 1) / 2);
    if (center.value > n - 1) center.value = Math.max(0, n - 1);
  },
  { immediate: true }
);

function onCard(i: number): void {
  if (props.focusedKey !== null) return;
  if (i === center.value) emit('focus', props.matches[i].key);
  else {
    userMoved.value = true;
    center.value = i;
    hovered.value = null;
  }
}
function onLeave(i: number): void {
  if (hovered.value === i) hovered.value = null;
}
function onWheel(e: WheelEvent): void {
  if (props.focusedKey !== null) return;
  e.preventDefault();
  userMoved.value = true;
  const d = e.deltaY > 0 ? 1 : -1;
  center.value = Math.max(0, Math.min(props.matches.length - 1, center.value + d));
}

// Non-linear dense layout: near ±2 cards spread, the rest collapse into a tight,
// edge-on pile at each side (rotated + receded + dimmed).
function styleFor(i: number): Record<string, string> {
  if (props.focusedKey !== null) {
    if (props.matches[i].key === props.focusedKey)
      return { transform: 'translate(-50%,-50%) translateY(72px) rotateX(74deg) scale(0.9)', opacity: '0.5', zIndex: '400' };
    const o = i - center.value;
    return {
      transform: `translate(-50%,-50%) translateX(${(o < 0 ? -1 : 1) * 540}px) translateZ(-340px) scale(0.66)`,
      opacity: '0',
      zIndex: '1',
      pointerEvents: 'none',
    };
  }
  const off = i - center.value;
  const s = off < 0 ? -1 : 1;
  const a = Math.abs(off);
  let x: number, tz: number, sc: number, op: number, ry: number;
  if (a <= 2) {
    x = off * 132;
    tz = -a * 80;
    sc = 1 - a * 0.055;
    op = 1;
    ry = off * -9;
  } else {
    const k = Math.min(a - 2, 7);
    x = s * (264 + k * 9);
    tz = -(172 + k * 30);
    sc = Math.max(0.5, 0.9 - k * 0.045);
    op = Math.max(0.42, 0.85 - k * 0.1);
    ry = s * -30;
  }
  let ty = 0;
  if (i === hovered.value) {
    ty = -32;
    sc += 0.08;
    tz += 72;
    op = 1;
    ry *= 0.4;
  }
  return {
    transform: `translate(-50%,-50%) translateX(${x}px) translateY(${ty}px) translateZ(${tz}px) rotateY(${ry}deg) scale(${sc})`,
    opacity: String(op),
    zIndex: String(300 - a),
    pointerEvents: a <= 9 ? 'auto' : 'none',
  };
}
</script>

<template>
  <div class="deck" @wheel="onWheel">
    <div
      v-for="(m, i) in matches"
      :key="m.key"
      class="card"
      :class="{ live: focusedKey === null && Math.abs(i - center) <= 1 }"
      :style="styleFor(i)"
      @mouseenter="hovered = i"
      @mouseleave="onLeave(i)"
      @click="onCard(i)"
    >
      <div class="face" :style="thumb ? { backgroundImage: `url(${thumb})` } : undefined" />
      <div class="label"><span class="sdot" :data-status="m.status" />{{ m.label }}</div>
      <div class="badge">LIVE</div>
    </div>
    <div class="deck-hint">悬停预览 · 点击中间卡片聚焦（可拖拽旋转视角）· 滚轮翻页</div>
  </div>
</template>

<style scoped>
.deck {
  position: absolute;
  inset: 0;
  perspective: 1500px;
}
.card {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 288px;
  height: 184px;
  margin: -92px 0 0 -144px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.52s cubic-bezier(0.2, 0.7, 0.2, 1), opacity 0.52s;
  will-change: transform;
}
.card.live {
  border-color: #34506b;
}
.face {
  height: 148px;
  background: #0e151c center/cover no-repeat;
}
.card:not(.live) .face {
  filter: saturate(0.4) brightness(0.78);
}
.label {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 11px;
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
}
.sdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #777;
  flex: none;
}
.sdot[data-status='open'] {
  background: #3ec07a;
}
.sdot[data-status='connecting'] {
  background: #e0a93e;
}
.sdot[data-status='error'],
.sdot[data-status='closed'] {
  background: var(--red);
}
.badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 11px;
  color: #7fd1a8;
  background: rgba(18, 38, 28, 0.7);
  border-radius: 4px;
  padding: 0 6px;
  opacity: 0;
}
.card.live .badge {
  opacity: 1;
}
.deck-hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
  pointer-events: none;
}
</style>
