// Minimal auto-hiding control bar: mode toggle, mic toggle, 4 sliders,
// fullscreen. Settings persist to localStorage.

import type { F1Prefs } from '../conductor/f1';

export type Mode = 'neural' | 'f1';

export interface Settings {
  mode: Mode;
  speed: number; // 0–1
  density: number; // 0–1
  colorMood: number; // 0–1 hue rotation
  glow: number; // 0–1
  f1: F1Prefs;
}

const STORAGE_KEY = 'laserpipes-settings';
const DEFAULTS: Settings = {
  mode: 'neural',
  speed: 0.5,
  density: 0.45,
  colorMood: 0,
  glow: 0.55,
  f1: { excluded: [], highlights: [], variants: {} },
};

export interface ControlsCallbacks {
  onMode(mode: Mode): void;
  onMicToggle(): Promise<boolean> | boolean;
  onChange(settings: Settings): void;
  onRefresh(): void;
  onF1Setup(): void;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULTS, ...parsed, f1: { ...DEFAULTS.f1, ...(parsed.f1 ?? {}) } };
    }
  } catch {
    /* corrupted storage: fall through to defaults */
  }
  return { ...DEFAULTS };
}

export class Controls {
  readonly settings: Settings;
  private root: HTMLElement;
  private hideTimer = 0;
  private micButton!: HTMLButtonElement;
  private setupButton!: HTMLButtonElement;
  private modeButtons = new Map<Mode, HTMLButtonElement>();
  private sliderEls = new Map<string, HTMLElement>();

  constructor(private callbacks: ControlsCallbacks) {
    this.settings = loadSettings();
    this.root = document.getElementById('controls')!;
    this.build();
    this.wireAutoHide();
  }

  /** Write settings to storage without firing onChange (e.g. F1 pref edits). */
  persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* private mode etc. */
    }
  }

  private save(): void {
    this.persist();
    this.callbacks.onChange(this.settings);
  }

  private build(): void {
    const topRow = document.createElement('div');
    topRow.className = 'row';

    const seg = document.createElement('div');
    seg.className = 'seg';
    const modes: [Mode, string][] = [
      ['neural', 'NEURAL'],
      ['f1', 'F1 LIVE'],
    ];
    for (const [mode, label] of modes) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', () => this.setMode(mode, true));
      seg.appendChild(button);
      this.modeButtons.set(mode, button);
    }
    topRow.appendChild(seg);

    this.micButton = document.createElement('button');
    this.micButton.className = 'pill';
    this.micButton.textContent = '🎙 MIC';
    this.micButton.addEventListener('click', async () => {
      const on = await this.callbacks.onMicToggle();
      this.micButton.classList.toggle('active', on);
    });
    topRow.appendChild(this.micButton);

    this.setupButton = document.createElement('button');
    this.setupButton.className = 'pill';
    this.setupButton.textContent = '🏁 SETUP';
    this.setupButton.addEventListener('click', () => this.callbacks.onF1Setup());
    topRow.appendChild(this.setupButton);

    const refresh = document.createElement('button');
    refresh.className = 'pill';
    refresh.textContent = '⟳';
    refresh.title = 'Restart the visualization';
    refresh.addEventListener('click', () => this.callbacks.onRefresh());
    topRow.appendChild(refresh);

    const fullscreen = document.createElement('button');
    fullscreen.className = 'pill';
    fullscreen.textContent = '⛶';
    fullscreen.title = 'Fullscreen';
    fullscreen.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.().catch(() => undefined);
    });
    topRow.appendChild(fullscreen);
    this.root.appendChild(topRow);

    const sliders = document.createElement('div');
    sliders.className = 'sliders';
    const defs: [keyof Omit<Settings, 'mode' | 'f1'>, string][] = [
      ['speed', 'SPEED'],
      ['density', 'DENSITY'],
      ['colorMood', 'COLOR MOOD'],
      ['glow', 'GLOW'],
    ];
    for (const [key, label] of defs) {
      const wrap = document.createElement('div');
      wrap.className = 'slider';
      const l = document.createElement('label');
      l.textContent = label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '1';
      input.step = '0.01';
      input.value = String(this.settings[key]);
      input.addEventListener('input', () => {
        this.settings[key] = parseFloat(input.value);
        this.save();
      });
      wrap.append(l, input);
      sliders.appendChild(wrap);
      this.sliderEls.set(key, wrap);
    }
    this.root.appendChild(sliders);

    this.updateModeUI();
  }

  setMode(mode: Mode, fromUser: boolean): void {
    if (fromUser && mode === this.settings.mode) return;
    this.settings.mode = mode;
    this.updateModeUI();
    this.save();
    this.callbacks.onMode(mode);
  }

  /** Reflect an externally-forced mode (e.g. F1 API down → back to neural). */
  reflectMode(mode: Mode): void {
    this.settings.mode = mode;
    this.updateModeUI();
  }

  setMicActive(on: boolean): void {
    this.micButton.classList.toggle('active', on);
  }

  private updateModeUI(): void {
    for (const [mode, button] of this.modeButtons) {
      button.classList.toggle('active', mode === this.settings.mode);
    }
    // F1 has no glow, no mood shift, a locked driver count, and no mic.
    const f1 = this.settings.mode === 'f1';
    this.micButton.style.display = f1 ? 'none' : '';
    this.setupButton.style.display = f1 ? '' : 'none';
    for (const key of ['density', 'colorMood', 'glow']) {
      const el = this.sliderEls.get(key);
      if (el) el.style.display = f1 ? 'none' : '';
    }
  }

  private wireAutoHide(): void {
    const show = () => {
      this.root.classList.remove('hidden');
      clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => this.root.classList.add('hidden'), 3800);
    };
    for (const event of ['pointermove', 'pointerdown', 'touchstart', 'keydown']) {
      window.addEventListener(event, show, { passive: true });
    }
    // Keep visible while actively interacting with the bar itself.
    this.root.addEventListener('pointermove', () => clearTimeout(this.hideTimer));
    show();
  }
}

export function showToast(message: string, ms = 4000): void {
  const toast = document.getElementById('toast')!;
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), ms);
}
