// The Conductor abstraction: every mode (neural, F1, …) produces the same
// normalized signal object each frame, and the visual engine only consumes that.

export interface EntityChannel {
  id: string;
  /** Base color of this entity's pipes, 0–1 rgb. */
  color: [number, number, number];
  /** How much the conductor's color field overrides the base color (0 = pure entity color). */
  fieldMix: number;
  /** Emissive gain, 0–1. */
  intensity: number;
  /** Growth speed multiplier (~0.3–2.5). */
  speed: number;
  /** Probability of turning at each step, 0–1. */
  turnBias: number;
  /** Probability of spawning a branch at each step, 0–1. */
  branchChance: number;
  label?: string;
}

export interface Pulse {
  /** 0–1, how hard the whole scene flashes/bursts. */
  strength: number;
  color?: [number, number, number];
}

export interface ConductorState {
  /** 0–1 global intensity; scales brightness and motion. */
  energy: number;
  entities: EntityChannel[];
  /** One-shot events consumed by the engine this frame. */
  pulses: Pulse[];
  /** Color field sampled at pipe heads (world coords + seconds), 0–1 rgb. */
  colorAt(x: number, y: number, z: number, t: number): [number, number, number];
  /** When true the sim keeps exactly one pipe per entity alive (F1: one per driver). */
  lockEntityCount?: boolean;
  /** Small status line shown in the corner (e.g. "REPLAY · Monaco GP"). */
  caption?: string;
}

export interface Conductor {
  update(dt: number, time: number): ConductorState;
  dispose?(): void;
}
