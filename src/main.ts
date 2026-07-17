import './ui/controls.css';
import { PipeSim } from './engine/pipeSim';
import { LaserRenderer, detectQuality } from './engine/laserRenderer';
import { CameraRig } from './engine/camera';
import { NeuralConductor } from './conductor/neural';
import { F1Conductor } from './conductor/f1';
import { MicOverlay } from './conductor/audio';
import { Controls, showToast, type Mode } from './ui/controls';
import type { Conductor } from './conductor/types';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const captionEl = document.getElementById('caption')!;

const quality = detectQuality();
const sim = new PipeSim({ x: 32, y: 20, z: 32 }, (segment) => renderer.addSegment(segment));
const renderer = new LaserRenderer(canvas, quality, (token) => sim.freeCell(token));
const rig = new CameraRig(renderer.camera, 37);
const mic = new MicOverlay();

let conductor: Conductor = new NeuralConductor();

function switchMode(mode: Mode): void {
  conductor.dispose?.();
  if (mode === 'f1') {
    conductor = new F1Conductor((status, message) => {
      if (status === 'error') {
        showToast(`${message} — back to Neural mode`, 6000);
        controls.reflectMode('neural');
        conductor.dispose?.();
        conductor = new NeuralConductor();
      } else if (status === 'ready') {
        showToast(`OpenF1 connected · ${message}`);
      }
    });
  } else {
    conductor = new NeuralConductor();
  }
}

const controls = new Controls({
  onMode: switchMode,
  onMicToggle: async () => {
    if (mic.active) {
      mic.disable();
      return false;
    }
    try {
      await mic.enable();
      showToast('Mic on — beats drive the lasers');
      return true;
    } catch {
      showToast('Microphone access was blocked');
      return false;
    }
  },
  onChange: apply,
});

function apply(): void {
  const s = controls.settings;
  sim.baseRate = 2 + s.speed * 9;
  sim.targetPipes = Math.round(2 + s.density * 16);
  sim.hueShift = s.colorMood;
  renderer.setGlow(s.glow);
}
apply();
if (controls.settings.mode === 'f1') switchMode('f1');

let last = performance.now();
let caption = '';
let simTime = 0;

function tick(dt: number): void {
  simTime += dt;
  const state = conductor.update(dt, simTime);

  // Mic overlay layers onto whatever the conductor produced.
  let energy = state.energy;
  if (mic.active) {
    const audio = mic.update(dt);
    energy = Math.min(1, energy * 0.6 + audio.energy * 0.9);
    if (audio.beat > 0) state.pulses.push({ strength: audio.beat });
  }

  for (const pulse of state.pulses) renderer.firePulse(pulse.strength);

  sim.update(dt, state, 0.4 + energy * 1.2);
  renderer.updateHeads(sim.getHeads(state), energy);
  rig.update(dt, energy);
  renderer.render(dt);

  if (state.caption !== caption) {
    caption = state.caption ?? '';
    captionEl.textContent = caption;
  }
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  tick(dt);
}
requestAnimationFrame(frame);

// Dev helper: fast-forward N seconds at a fixed step (rAF is throttled in
// headless/preview panes, which stalls the sim between screenshots).
(window as unknown as { __debug: unknown }).__debug = {
  sim,
  renderer,
  ff: (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) tick(1 / 60);
  },
};

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
}

window.addEventListener('resize', () => renderer.resize());
document.addEventListener('visibilitychange', () => {
  // Avoid a giant dt burst when the tab returns.
  last = performance.now();
});
