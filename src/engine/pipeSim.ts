import type { ConductorState, EntityChannel } from '../conductor/types';

// Grid-based pipe growth: the classic 3D Pipes random walk, modernized.
// Pipes prefer to continue straight, turn with probability turnBias, never
// revisit occupied cells, and retire when boxed in — a new one spawns forever.

export interface GridSize {
  x: number;
  y: number;
  z: number;
}

export interface Segment {
  from: [number, number, number];
  to: [number, number, number];
  color: [number, number, number];
  intensity: number;
  /** Render thicker (highlighted entity). */
  bold: boolean;
  /** Opaque token the renderer hands back when this segment is evicted. */
  cellToken: number;
}

export interface PipeHead {
  pos: [number, number, number];
  color: [number, number, number];
  intensity: number;
  label?: string;
}

interface Pipe {
  cx: number;
  cy: number;
  cz: number;
  dir: number;
  entityIdx: number;
  steps: number;
  acc: number;
  lastColor: [number, number, number];
  lastIntensity: number;
}

const DIRS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const MAX_PIPES = 32;
const MAX_STEPS = 220;

export class PipeSim {
  readonly grid: GridSize;
  private occupancy: Uint8Array;
  private pipes: Pipe[] = [];
  /** Base steps per second at speed multiplier 1. */
  baseRate = 9;
  /** Slider-controlled: desired number of concurrent pipes. */
  targetPipes = 10;
  /** Slider-controlled: 0–1 hue rotation applied to all conductor colors. */
  hueShift = 0;
  private time = 0;
  private spawnCooldown = 0;

  constructor(grid: GridSize, private emit: (s: Segment) => void) {
    this.grid = grid;
    this.occupancy = new Uint8Array(grid.x * grid.y * grid.z);
  }

  /** World-space center of a cell (grid is centered on the origin). */
  cellCenter(cx: number, cy: number, cz: number): [number, number, number] {
    return [cx - (this.grid.x - 1) / 2, cy - (this.grid.y - 1) / 2, cz - (this.grid.z - 1) / 2];
  }

  private cellIndex(cx: number, cy: number, cz: number): number {
    return (cx * this.grid.y + cy) * this.grid.z + cz;
  }

  freeCell(token: number): void {
    if (token >= 0 && token < this.occupancy.length) this.occupancy[token] = 0;
  }

  /** Kill living pipes (structure keeps dissolving); new ones respawn next tick. */
  resetPipes(): void {
    this.pipes.length = 0;
  }

  /** Full restart: no pipes, empty grid. */
  resetAll(): void {
    this.pipes.length = 0;
    this.occupancy.fill(0);
  }

  private isFree(cx: number, cy: number, cz: number): boolean {
    if (cx < 0 || cy < 0 || cz < 0 || cx >= this.grid.x || cy >= this.grid.y || cz >= this.grid.z) return false;
    return this.occupancy[this.cellIndex(cx, cy, cz)] === 0;
  }

  private spawnPipe(entityIdx: number): boolean {
    for (let attempt = 0; attempt < 24; attempt++) {
      const cx = 1 + Math.floor(Math.random() * (this.grid.x - 2));
      const cy = 1 + Math.floor(Math.random() * (this.grid.y - 2));
      const cz = 1 + Math.floor(Math.random() * (this.grid.z - 2));
      if (!this.isFree(cx, cy, cz)) continue;
      this.occupancy[this.cellIndex(cx, cy, cz)] = 1;
      this.pipes.push({
        cx,
        cy,
        cz,
        dir: Math.floor(Math.random() * 6),
        entityIdx,
        steps: 0,
        acc: Math.random(),
        lastColor: [1, 1, 1],
        lastIntensity: 1,
      });
      return true;
    }
    return false;
  }

  private pickDirection(pipe: Pipe, turnBias: number): number {
    const wantTurn = Math.random() < turnBias;
    const order: number[] = [];
    if (!wantTurn) order.push(pipe.dir);
    // Perpendicular candidates in random order (never reverse into ourselves).
    const perps: number[] = [];
    for (let d = 0; d < 6; d++) {
      if (d === pipe.dir || d === (pipe.dir ^ 1)) continue;
      perps.push(d);
    }
    for (let i = perps.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [perps[i], perps[j]] = [perps[j], perps[i]];
    }
    order.push(...perps);
    if (wantTurn) order.push(pipe.dir);
    for (const d of order) {
      const [dx, dy, dz] = DIRS[d];
      if (this.isFree(pipe.cx + dx, pipe.cy + dy, pipe.cz + dz)) return d;
    }
    return -1;
  }

  private applyHueShift(c: [number, number, number]): [number, number, number] {
    if (this.hueShift < 0.005) return c;
    // Hue rotation matrix around the RGB gray axis.
    const angle = this.hueShift * Math.PI * 2;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const third = 1 / 3;
    const rt = Math.sqrt(third);
    const a = cosA + (1 - cosA) * third;
    const b1 = (1 - cosA) * third - rt * sinA;
    const c1 = (1 - cosA) * third + rt * sinA;
    const [r, g, b] = c;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [
      clamp(a * r + b1 * g + c1 * b),
      clamp(c1 * r + a * g + b1 * b),
      clamp(b1 * r + c1 * g + a * b),
    ];
  }

  private stepPipe(pipe: Pipe, channel: EntityChannel, state: ConductorState): boolean {
    const d = this.pickDirection(pipe, channel.turnBias);
    if (d === -1 || pipe.steps > MAX_STEPS) return false;
    pipe.dir = d;
    const [dx, dy, dz] = DIRS[d];
    const from = this.cellCenter(pipe.cx, pipe.cy, pipe.cz);
    pipe.cx += dx;
    pipe.cy += dy;
    pipe.cz += dz;
    pipe.steps++;
    const token = this.cellIndex(pipe.cx, pipe.cy, pipe.cz);
    this.occupancy[token] = 1;
    const to = this.cellCenter(pipe.cx, pipe.cy, pipe.cz);

    const field = state.colorAt(to[0], to[1], to[2], this.time);
    const mix = channel.fieldMix;
    const color = this.applyHueShift([
      channel.color[0] * (1 - mix) + field[0] * mix,
      channel.color[1] * (1 - mix) + field[1] * mix,
      channel.color[2] * (1 - mix) + field[2] * mix,
    ]);
    pipe.lastColor = color;
    pipe.lastIntensity = channel.intensity;
    this.emit({ from, to, color, intensity: channel.intensity, bold: !!channel.bold, cellToken: token });

    // Occasional branch: hand off a perpendicular start to a fresh pipe.
    if (this.pipes.length < MAX_PIPES && Math.random() < channel.branchChance) {
      const bd = this.pickDirection({ ...pipe }, 1);
      if (bd !== -1 && bd !== pipe.dir) {
        this.pipes.push({
          cx: pipe.cx,
          cy: pipe.cy,
          cz: pipe.cz,
          dir: bd,
          entityIdx: pipe.entityIdx,
          steps: Math.floor(pipe.steps * 0.5),
          acc: 0,
          lastColor: color,
          lastIntensity: channel.intensity,
        });
      }
    }
    return true;
  }

  /** Advance the sim; speedScale is the global speed slider × energy. */
  update(dt: number, state: ConductorState, speedScale: number): void {
    this.time += dt;
    const entities = state.entities;
    if (entities.length === 0) return;

    // Population control.
    const target = state.lockEntityCount
      ? entities.length
      : Math.min(MAX_PIPES, Math.max(1, this.targetPipes));
    this.spawnCooldown -= dt;
    if (this.pipes.length < target && this.spawnCooldown <= 0) {
      let entityIdx: number;
      if (state.lockEntityCount) {
        // Find an entity with no living pipe.
        const alive = new Set(this.pipes.map((p) => p.entityIdx));
        entityIdx = entities.findIndex((_, i) => !alive.has(i));
        if (entityIdx === -1) entityIdx = Math.floor(Math.random() * entities.length);
      } else {
        entityIdx = Math.floor(Math.random() * entities.length);
      }
      this.spawnPipe(entityIdx);
      this.spawnCooldown = 0.08;
    } else if (this.pipes.length > target + 2) {
      // Gently retire the oldest surplus pipe.
      this.pipes.sort((a, b) => b.steps - a.steps);
      this.pipes.pop();
    }

    for (let i = this.pipes.length - 1; i >= 0; i--) {
      const pipe = this.pipes[i];
      const channel = entities[Math.min(pipe.entityIdx, entities.length - 1)];
      pipe.acc += dt * this.baseRate * channel.speed * speedScale;
      let ok = true;
      let guard = 0;
      while (pipe.acc >= 1 && ok && guard < 6) {
        pipe.acc -= 1;
        ok = this.stepPipe(pipe, channel, state);
        guard++;
      }
      if (!ok) this.pipes.splice(i, 1);
    }
  }

  getHeads(state: ConductorState): PipeHead[] {
    return this.pipes.map((p) => {
      const channel = state.entities[Math.min(p.entityIdx, state.entities.length - 1)];
      return {
        pos: this.cellCenter(p.cx, p.cy, p.cz),
        color: p.lastColor,
        intensity: p.lastIntensity,
        label: channel?.label,
      };
    });
  }
}
