import type { Conductor, ConductorState, EntityChannel, Pulse } from './types';

// The default "brain": two tiny neural nets, no training data, all evolution.
//  - A CPPN (mixed sin/tanh/gaussian activations) maps (x,y,z,t) → color,
//    painting organic laser color fields that flow through space.
//  - A steering MLP maps a pipe's situation → turn/branch/speed behavior.
// Every generation (~25s) the weights clone + mutate and we crossfade to the
// mutant, so the visual literally evolves its behavior forever.

type Activation = (x: number) => number;
const ACTS: Activation[] = [
  Math.sin,
  Math.tanh,
  (x) => Math.exp(-x * x), // gaussian
];

interface Net {
  sizes: number[];
  weights: Float32Array[]; // per layer: (in+1) * out, bias folded in
}

function randomNet(sizes: number[], scale = 1.4): Net {
  const weights = sizes.slice(1).map((out, layer) => {
    const inSize = sizes[layer] + 1;
    const w = new Float32Array(inSize * out);
    for (let i = 0; i < w.length; i++) w[i] = (Math.random() * 2 - 1) * scale;
    return w;
  });
  return { sizes, weights };
}

function mutateNet(net: Net, amount: number): Net {
  return {
    sizes: net.sizes,
    weights: net.weights.map((w) => {
      const m = new Float32Array(w);
      for (let i = 0; i < m.length; i++) {
        if (Math.random() < 0.25) m[i] += (Math.random() * 2 - 1) * amount;
      }
      return m;
    }),
  };
}

function evalNet(net: Net, input: number[], out: number[]): void {
  let current = input;
  for (let layer = 0; layer < net.weights.length; layer++) {
    const w = net.weights[layer];
    const outSize = net.sizes[layer + 1];
    const inSize = net.sizes[layer];
    const act = ACTS[layer % ACTS.length];
    const next = new Array<number>(outSize);
    for (let o = 0; o < outSize; o++) {
      let sum = w[o * (inSize + 1) + inSize]; // bias
      for (let i = 0; i < inSize; i++) sum += w[o * (inSize + 1) + i] * current[i];
      next[o] = layer === net.weights.length - 1 ? Math.tanh(sum) : act(sum * 0.8);
    }
    current = next;
  }
  for (let i = 0; i < out.length; i++) out[i] = current[i];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 1) + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

const GENERATION_SECONDS = 26;
const CROSSFADE_SECONDS = 5;

export class NeuralConductor implements Conductor {
  private cppnA: Net;
  private cppnB: Net;
  private steerA: Net;
  private steerB: Net;
  private blend = 1; // 0 = A, 1 = B; ramps toward 1 after each mutation
  private generationTimer = GENERATION_SECONDS * 0.5;
  private generation = 1;
  private entities: EntityChannel[] = [];
  private outA = [0, 0, 0];
  private outB = [0, 0, 0];
  private pulseQueue: Pulse[] = [];

  constructor() {
    const cppnSizes = [5, 10, 10, 8, 3];
    const steerSizes = [6, 8, 3];
    this.cppnA = randomNet(cppnSizes);
    this.cppnB = mutateNet(this.cppnA, 0.5);
    this.steerA = randomNet(steerSizes, 1.0);
    this.steerB = mutateNet(this.steerA, 0.4);
    for (let i = 0; i < 6; i++) {
      this.entities.push({
        id: `n${i}`,
        color: [1, 1, 1],
        fieldMix: 1,
        intensity: 0.75,
        speed: 1,
        turnBias: 0.3,
        branchChance: 0.01,
      });
    }
  }

  private sampleColor(x: number, y: number, z: number, t: number): [number, number, number] {
    const s = 0.055;
    const input = [x * s, y * s, z * s, Math.sin(t * 0.07), Math.cos(t * 0.11)];
    evalNet(this.cppnA, input, this.outA);
    evalNet(this.cppnB, input, this.outB);
    const b = this.blend;
    const h = (this.outA[0] * (1 - b) + this.outB[0] * b) * 0.5 + 0.5;
    const sat = 0.88 + 0.12 * ((this.outA[1] * (1 - b) + this.outB[1] * b) * 0.5 + 0.5);
    const lum = 0.46 + 0.12 * (this.outA[2] * (1 - b) + this.outB[2] * b);
    return hslToRgb(h, sat, lum);
  }

  update(dt: number, time: number): ConductorState {
    // Evolution clock: mutate, then crossfade to the mutant.
    this.generationTimer -= dt;
    if (this.generationTimer <= 0) {
      this.generationTimer = GENERATION_SECONDS + Math.random() * 10;
      this.cppnA = this.cppnB;
      this.steerA = this.steerB;
      this.cppnB = mutateNet(this.cppnA, 0.55);
      this.steerB = mutateNet(this.steerA, 0.45);
      this.blend = 0;
      this.generation++;
      this.pulseQueue.push({ strength: 0.45 }); // a soft strobe marks each new generation
    }
    this.blend = Math.min(1, this.blend + dt / CROSSFADE_SECONDS);

    // Steer each entity family with the evolving MLP.
    const steerOut = [0, 0, 0];
    for (let i = 0; i < this.entities.length; i++) {
      const phase = (i / this.entities.length) * Math.PI * 2;
      const input = [
        Math.sin(time * 0.05 + phase),
        Math.cos(time * 0.05 + phase),
        Math.sin(time * 0.013),
        Math.cos(time * 0.021 + phase * 2),
        i / this.entities.length,
        1,
      ];
      evalNet(this.steerA, input, this.outA);
      evalNet(this.steerB, input, steerOut);
      const b = this.blend;
      const o0 = this.outA[0] * (1 - b) + steerOut[0] * b;
      const o1 = this.outA[1] * (1 - b) + steerOut[1] * b;
      const o2 = this.outA[2] * (1 - b) + steerOut[2] * b;
      const e = this.entities[i];
      e.turnBias = 0.14 + (o0 * 0.5 + 0.5) * 0.5;
      e.branchChance = (o1 * 0.5 + 0.5) * 0.02;
      e.speed = 0.45 + (o2 * 0.5 + 0.5) * 0.9;
      e.intensity = 0.55 + 0.45 * Math.abs(Math.sin(time * 0.1 + phase));
    }

    const energy = 0.5 + 0.3 * Math.sin(time * 0.05) * Math.sin(time * 0.023 + 1.7);
    const pulses = this.pulseQueue;
    this.pulseQueue = [];
    return {
      energy: Math.max(0.15, energy),
      entities: this.entities,
      pulses,
      colorAt: (x, y, z, t) => this.sampleColor(x, y, z, t),
      caption: `NEURAL · GEN ${this.generation}`,
    };
  }
}
