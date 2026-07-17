// Minimal auto-hiding control bar: mode toggle, mic toggle, 4 sliders,
// fullscreen. Settings persist to localStorage.

export type Mode = 'neural' | 'f1';

export interface Settings {
  mode: Mode;
  speed: number; // 0–1
  density: number; // 0–1
  colorMood: number; // 0–1 hue rotation
  glow: number; // 0–1
}

const STORAGE_KEY = 'laserpipes-settings';
const DEFAULTS: Settings = { mode: 'neural', speed: 0.5, density: 0.45, colorMood: 0, glow: 0.55 };

export interface ControlsCallbacks {
  onMode(mode: Mode): void;
  onMicToggle(): Promise<boolean> | boolean;
  onChange(settings: Settings): void;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
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
  private modeButtons = new Map<Mode, HTMLButtonElement>();

  constructor(private callbacks: ControlsCallbacks) {
    this.settings = loadSettings();
    this.root = document.getElementById('controls')!;
    this.build();
    this.wireAutoHide();
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* private mode etc. */
    }
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
    const defs: [keyof Omit<Settings, 'mode'>, string][] = [
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
