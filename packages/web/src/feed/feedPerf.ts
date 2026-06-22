/**
 * Process-wide feed cost counters, summed across every open WS feed and read once
 * per perf window by the HUD/telemetry. This isolates how much of the "Other"
 * (outside-the-render-loop) frame time is the attribute-store fold + snapshot
 * projection vs. GC/layout — the dominant main-thread cost when many matches stream
 * at once. Timing is a couple of `performance.now()` calls per message (negligible).
 */
export const feedPerf = {
  /** ms spent in JSON.parse of the raw WS payload (every message, every socket). */
  parseMs: 0,
  /** ms spent in AttributeStore.applyResult (the per-message fold). */
  applyMs: 0,
  /** ms spent in AttributeStore.toSnapshot (the active-board projection). */
  projectMs: 0,
  /** ms spent in the renderer's per-snapshot work (MatchUnit.updateSnapshot: vehicle
   *  apply + CSS2D panel DOM updates on the focused board). Driven by the feed rate. */
  sceneSnapMs: 0,
  /** number of WS messages received (parsed). */
  messages: 0,
};

export interface FeedPerfSnapshot {
  parseMs: number;
  applyMs: number;
  projectMs: number;
  sceneSnapMs: number;
  messages: number;
}

/** Read-and-reset: returns the accumulated window then zeroes the counters. */
export function drainFeedPerf(): FeedPerfSnapshot {
  const snapshot = {
    parseMs: feedPerf.parseMs,
    applyMs: feedPerf.applyMs,
    projectMs: feedPerf.projectMs,
    sceneSnapMs: feedPerf.sceneSnapMs,
    messages: feedPerf.messages,
  };
  feedPerf.parseMs = 0;
  feedPerf.applyMs = 0;
  feedPerf.projectMs = 0;
  feedPerf.sceneSnapMs = 0;
  feedPerf.messages = 0;
  return snapshot;
}
