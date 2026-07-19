import type { DriverInfo, F1Prefs, RaceOption } from '../conductor/f1';
import { showToast } from './controls';

// F1 setup sheet: race picker, "how to read it" key, and the driver grid —
// tap a row to include/exclude, tap the swatch to cycle color presets,
// tap ★ to highlight (bold pipes, max 3).

export interface F1PanelCallbacks {
  onPrefsChange(prefs: Partial<F1Prefs>): void;
  loadRaces(): Promise<RaceOption[]>;
}

const MAX_HIGHLIGHTS = 3;

function cssColor(c: [number, number, number]): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

export class F1Panel {
  private root: HTMLElement;
  private raceSelect: HTMLSelectElement;
  private driversEl: HTMLElement;
  private racesLoaded = false;
  private prefs: F1Prefs = { excluded: [], highlights: [], variants: {} };
  private drivers: DriverInfo[] = [];

  constructor(private callbacks: F1PanelCallbacks) {
    this.root = document.getElementById('f1panel')!;

    const header = document.createElement('div');
    header.className = 'f1-header';
    const title = document.createElement('span');
    title.className = 'f1-title';
    title.textContent = 'F1 SETUP';
    const close = document.createElement('button');
    close.className = 'pill';
    close.textContent = '✕';
    close.addEventListener('click', () => this.hide());
    header.append(title, close);
    this.root.appendChild(header);

    const raceRow = document.createElement('div');
    raceRow.className = 'f1-race-row';
    const raceLabel = document.createElement('label');
    raceLabel.textContent = 'RACE';
    this.raceSelect = document.createElement('select');
    this.raceSelect.addEventListener('change', () => {
      const key = parseInt(this.raceSelect.value, 10);
      if (!Number.isNaN(key)) this.callbacks.onPrefsChange({ sessionKey: key });
    });
    raceRow.append(raceLabel, this.raceSelect);
    this.root.appendChild(raceRow);

    const key = document.createElement('div');
    key.className = 'f1-key';
    key.innerHTML = `
      <div class="f1-key-title">HOW TO READ IT</div>
      <div>Each pipe is one driver, growing through the grid in team color.</div>
      <ul>
        <li><b>Speed</b> → how fast the pipe grows</li>
        <li><b>Throttle</b> → how bright it burns</li>
        <li><b>Braking</b> → sharp turns</li>
        <li><b>DRS open</b> → a pulse flash</li>
      </ul>
      <div>Old pipe dissolves behind the field forever. Tap a driver to hide them,
      the swatch to change their color preset, ★ to bold up to ${MAX_HIGHLIGHTS}.</div>`;
    this.root.appendChild(key);

    this.driversEl = document.createElement('div');
    this.driversEl.className = 'f1-drivers';
    this.root.appendChild(this.driversEl);
  }

  get visible(): boolean {
    return this.root.classList.contains('open');
  }

  show(): void {
    this.root.classList.add('open');
    if (!this.racesLoaded) {
      this.racesLoaded = true;
      this.callbacks
        .loadRaces()
        .then((races) => this.setRaces(races))
        .catch(() => {
          this.racesLoaded = false;
          showToast('Could not load the race list from OpenF1');
        });
    }
  }

  hide(): void {
    this.root.classList.remove('open');
  }

  setRaces(races: RaceOption[]): void {
    this.raceSelect.innerHTML = '';
    for (const race of races) {
      const opt = document.createElement('option');
      opt.value = String(race.sessionKey);
      opt.textContent = race.label;
      this.raceSelect.appendChild(opt);
    }
    if (this.prefs.sessionKey) this.raceSelect.value = String(this.prefs.sessionKey);
  }

  /** Called when a conductor becomes ready (or prefs restored from storage). */
  setDrivers(drivers: DriverInfo[], prefs: F1Prefs): void {
    this.drivers = drivers;
    this.prefs = prefs;
    if (prefs.sessionKey) this.raceSelect.value = String(prefs.sessionKey);
    this.renderDrivers();
  }

  private commit(): void {
    this.callbacks.onPrefsChange({
      excluded: [...this.prefs.excluded],
      highlights: [...this.prefs.highlights],
      variants: { ...this.prefs.variants },
    });
    this.renderDrivers();
  }

  private renderDrivers(): void {
    this.driversEl.innerHTML = '';
    const excluded = new Set(this.prefs.excluded);
    const highlights = new Set(this.prefs.highlights);
    for (const driver of this.drivers) {
      const row = document.createElement('div');
      row.className = 'f1-driver';
      if (excluded.has(driver.number)) row.classList.add('off');

      const variant = Math.min(2, this.prefs.variants[driver.number] ?? 0);
      const swatch = document.createElement('button');
      swatch.className = 'f1-swatch';
      swatch.style.background = cssColor(driver.variants[variant]);
      swatch.title = 'Change color preset';
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        this.prefs.variants[driver.number] = (variant + 1) % 3;
        this.commit();
      });

      const name = document.createElement('span');
      name.className = 'f1-name';
      name.textContent = driver.acronym;
      name.title = driver.fullName;

      const star = document.createElement('button');
      star.className = 'f1-star';
      star.textContent = highlights.has(driver.number) ? '★' : '☆';
      if (highlights.has(driver.number)) star.classList.add('on');
      star.title = `Bold this driver (max ${MAX_HIGHLIGHTS})`;
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        if (highlights.has(driver.number)) {
          this.prefs.highlights = this.prefs.highlights.filter((n) => n !== driver.number);
        } else if (this.prefs.highlights.length >= MAX_HIGHLIGHTS) {
          showToast(`Up to ${MAX_HIGHLIGHTS} highlighted drivers — unstar one first`);
          return;
        } else {
          this.prefs.highlights.push(driver.number);
        }
        this.commit();
      });

      row.append(swatch, name, star);
      row.addEventListener('click', () => {
        if (excluded.has(driver.number)) {
          this.prefs.excluded = this.prefs.excluded.filter((n) => n !== driver.number);
        } else {
          if (this.drivers.length - this.prefs.excluded.length <= 1) {
            showToast('At least one driver has to stay on track');
            return;
          }
          this.prefs.excluded.push(driver.number);
        }
        this.commit();
      });
      this.driversEl.appendChild(row);
    }
  }
}
