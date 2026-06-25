/**
 * Trace Replayer - replays a recorded WatchAttributeMapsResult trace through the
 * monitor's existing attributeStore pipeline.
 *
 * Large replay directories must not keep every frame resident. This reader only
 * parses the trace header at startup, then scans one JSON frame at a time while a
 * browser is actually connected.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import {
  EJSONRPCType,
  METHOD_WATCH_ATTRIBUTE_MAPS_RESULT,
  type WatchAttributeMapsResult,
} from '@gsm/protocol';

export interface TraceFrame {
  result: WatchAttributeMapsResult;
}

export interface TraceFileInfo {
  v: number;
  src?: string;
  fmt?: string;
  mapId: number;
  frameCount: number;
  durMs: number;
  gtMs: number;
  summary?: { winner?: string; teamDamage?: number[]; bots?: unknown[] };
}

export interface ReplayerOptions {
  tracePath: string;
  wsPort?: number;
  speed?: number;
  loop?: boolean;
}

interface TraceHeader {
  info: TraceFileInfo;
  framesOffset: number;
}

const TRACE_HEADER_READ_BYTES = 256 * 1024;
const TRACE_HEADER_MAX_BYTES = 64 * 1024 * 1024;
const TRACE_FRAME_READ_BYTES = 128 * 1024;

export function readTraceInfo(tracePath: string): TraceFileInfo {
  return readTraceHeader(tracePath).info;
}

export class TraceReplayer {
  private readonly info: TraceFileInfo;
  private readonly framesOffset: number;
  private reader: TraceFrameReader | null = null;
  private wss: WebSocketServer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idx = 0;
  private clients = new Set<WebSocket>();
  private readonly wsPort: number;
  private readonly speed: number;
  private readonly loop: boolean;
  private alive = false;
  private loggedFirstFrame = false;

  // State for compact-delta reconstruction.
  private pmap = new Map<number, Record<string, number>>();

  constructor(private readonly opts: ReplayerOptions) {
    this.wsPort = opts.wsPort ?? 9240;
    this.speed = opts.speed ?? 1;
    this.loop = opts.loop ?? false;
    const header = readTraceHeader(opts.tracePath);
    this.info = header.info;
    this.framesOffset = header.framesOffset;
    console.error(
      `[replayer] ${this.info.frameCount} frames, ${(this.info.durMs / 1000).toFixed(0)}s, map=${this.info.mapId}`,
    );
  }

  static inspect(tracePath: string): TraceFileInfo {
    return readTraceInfo(tracePath);
  }

  async start() {
    this.wss = new WebSocketServer({ port: this.wsPort });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);

      // Send synthetic keyframe (full current state) to late joiners.
      if (this.info.fmt === 'compact-delta' && this.pmap.size > 0) {
        const keyframe: WatchAttributeMapsResult['watch_attribute_maps_results'] = [];
        for (const [mid, attrs] of this.pmap) {
          keyframe.push({ sync_type: 0, attribute_map_id: mid, attributes: { ...attrs } });
        }
        this.send(ws, { watch_attribute_maps_results: keyframe });
      }

      ws.on('close', () => {
        this.clients.delete(ws);
        if (this.clients.size === 0) this.pause();
      });
      ws.on('error', () => {
        this.clients.delete(ws);
        if (this.clients.size === 0) this.pause();
      });
      this.resume();
    });
    this.wss.on('error', (e) => console.error(`[replayer] WS error: ${e.message}`));
    console.error(`[replayer] ws://localhost:${this.wsPort}`);
    this.alive = true;
  }

  async stop() {
    this.alive = false;
    this.pause();
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
    console.error('[replayer] stopped');
  }

  private resume() {
    if (!this.alive || this.clients.size === 0 || this.timer) return;
    if (!this.reader) {
      this.reader = new TraceFrameReader(this.opts.tracePath, this.framesOffset);
      this.idx = 0;
      this.pmap.clear();
      this.loggedFirstFrame = false;
    }
    this.tick();
  }

  private pause() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.reader?.close();
    this.reader = null;
    this.idx = 0;
    this.pmap.clear();
    this.loggedFirstFrame = false;
  }

  private tick() {
    if (!this.alive || this.clients.size === 0 || !this.reader) return;
    const raw = this.reader.nextFrame();
    if (!raw) {
      if (this.loop) {
        this.reader.reset();
        this.idx = 0;
        this.pmap.clear();
        this.loggedFirstFrame = false;
        this.tick();
      } else {
        this.pause();
      }
      return;
    }

    const params =
      this.info.fmt === 'compact-delta'
        ? this.convertCompact(raw as Array<[number, number[], number]>)
        : (raw as TraceFrame).result;

    if (!this.loggedFirstFrame) {
      console.error(`[replayer] first frame: ${params.watch_attribute_maps_results.length} updates`);
      this.loggedFirstFrame = true;
    }

    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) this.send(ws, params);
    }
    this.idx += 1;
    const frameCount = Math.max(1, this.info.frameCount);
    const avg = this.info.durMs > 0 ? this.info.durMs / frameCount : 100;
    const delay = this.speed > 0 ? Math.max(16, avg / this.speed) : 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  private convertCompact(frame: Array<[number, number[], number]>): WatchAttributeMapsResult {
    const updates: WatchAttributeMapsResult['watch_attribute_maps_results'] = [];
    for (const [mid, flat, marker] of frame) {
      const isKeyframe = marker === 0;
      const prev = isKeyframe ? {} : (this.pmap.get(mid) ?? {});
      const attrs: Record<string, number> = {};
      for (let i = 0; i < flat.length; i += 2) {
        const key = String(flat[i]);
        const value = flat[i + 1];
        attrs[key] = value;
        prev[key] = value;
      }
      this.pmap.set(mid, prev);
      updates.push({
        sync_type: isKeyframe ? 0 : 1,
        attribute_map_id: mid,
        attributes: attrs,
      });
    }
    return { watch_attribute_maps_results: updates };
  }

  private send(ws: WebSocket, params: WatchAttributeMapsResult) {
    ws.send(
      JSON.stringify({
        type: EJSONRPCType.Request,
        method: METHOD_WATCH_ATTRIBUTE_MAPS_RESULT,
        params,
      }),
    );
  }
}

class TraceFrameReader {
  private fd: number | null = null;
  private offset = 0;
  private buffer = '';
  private reachedEnd = false;

  constructor(
    private readonly tracePath: string,
    private readonly framesOffset: number,
  ) {
    this.reset();
  }

  reset() {
    this.close();
    this.fd = openSync(this.tracePath, 'r');
    this.offset = this.framesOffset;
    this.buffer = '';
    this.reachedEnd = false;
  }

  close() {
    if (this.fd == null) return;
    closeSync(this.fd);
    this.fd = null;
  }

  nextFrame(): unknown | null {
    while (true) {
      const parsed = this.tryTakeFrame();
      if (parsed !== undefined) return parsed;
      if (!this.readMore()) {
        const rest = this.buffer.trim();
        if (rest === '' || rest === ']' || rest === ']}') return null;
        throw new Error(`Trace frame is truncated in ${this.tracePath}`);
      }
    }
  }

  private tryTakeFrame(): unknown | null | undefined {
    let start = 0;
    while (start < this.buffer.length) {
      const ch = this.buffer[start];
      if (ch === ',' || isWhitespace(ch)) {
        start += 1;
        continue;
      }
      break;
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    if (this.buffer.length === 0) return undefined;
    if (this.buffer[0] === ']') {
      this.buffer = this.buffer.slice(1);
      return null;
    }

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const ch = this.buffer[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '[' || ch === '{') {
        depth += 1;
      } else if (ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const json = this.buffer.slice(0, i + 1);
          this.buffer = this.buffer.slice(i + 1);
          return JSON.parse(json);
        }
      }
    }
    return undefined;
  }

  private readMore(): boolean {
    if (this.reachedEnd || this.fd == null) return false;
    const chunk = Buffer.allocUnsafe(TRACE_FRAME_READ_BYTES);
    const bytes = readSync(this.fd, chunk, 0, chunk.length, this.offset);
    if (bytes <= 0) {
      this.reachedEnd = true;
      return false;
    }
    this.offset += bytes;
    this.buffer += chunk.toString('utf8', 0, bytes);
    return true;
  }
}

function readTraceHeader(tracePath: string): TraceHeader {
  const fd = openSync(tracePath, 'r');
  try {
    const size = statSync(tracePath).size;
    const chunks: Buffer[] = [];
    let readOffset = 0;
    let text = '';
    let match: RegExpExecArray | null = null;

    while (readOffset < size && readOffset < TRACE_HEADER_MAX_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(TRACE_HEADER_READ_BYTES, size - readOffset));
      const bytes = readSync(fd, chunk, 0, chunk.length, readOffset);
      if (bytes <= 0) break;
      chunks.push(chunk.subarray(0, bytes));
      readOffset += bytes;
      text = Buffer.concat(chunks).toString('utf8');
      match = /"frames"\s*:\s*\[/.exec(text);
      if (match) break;
    }

    if (!match) {
      throw new Error(`Trace header did not contain a frames array: ${tracePath}`);
    }

    const headerText = text.slice(0, match.index);
    const framesOffset = Buffer.byteLength(text.slice(0, match.index + match[0].length), 'utf8');
    const info = JSON.parse(`${headerText}"frames":[]}`) as Partial<TraceFileInfo> & {
      frames?: unknown[];
    };
    return {
      framesOffset,
      info: {
        v: Number(info.v ?? 0),
        src: info.src,
        fmt: info.fmt,
        mapId: Number(info.mapId ?? 9),
        frameCount: Number(info.frameCount ?? info.frames?.length ?? 0),
        durMs: Number(info.durMs ?? 0),
        gtMs: Number(info.gtMs ?? 0),
        summary: info.summary,
      },
    };
  } finally {
    closeSync(fd);
  }
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}
