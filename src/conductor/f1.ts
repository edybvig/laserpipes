import type { Conductor, ConductorState, EntityChannel, Pulse } from './types';

// Real Formula 1 telemetry via the free OpenF1 API (api.openf1.org).
// Live during race weekends; otherwise a time-accelerated replay of the most
// recent race. One laser per driver in team color: speed drives growth,
// throttle drives brightness, braking forces turns, DRS fires pulses.

const API = 'https://api.openf1.org/v1';
const REPLAY_SPEED = 12;
const WINDOW_SECONDS = 300; // session-time span fetched per request
const LIVE_POLL_SECONDS = 4;

interface CarSample {
  t: number; // epoch ms
  speed: number; // km/h
  throttle: number; // 0–100
  brake: number; // 0–100
  drs: boolean;
}

interface DriverTrack {
  number: number;
  acronym: string;
  color: [number, number, number];
  samples: CarSample[];
  cursor: number;
  drsOpen: boolean;
}

export type F1Status = 'loading' | 'ready' | 'error';

function hexToRgb(hex: string | null): [number, number, number] {
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return [0.8, 0.8, 0.85];
  let r = parseInt(hex.slice(0, 2), 16) / 255;
  let g = parseInt(hex.slice(2, 4), 16) / 255;
  let b = parseInt(hex.slice(4, 6), 16) / 255;
  // Lift very dark team colors so they still read as lasers.
  const max = Math.max(r, g, b);
  if (max < 0.45 && max > 0) {
    const lift = 0.55 / max;
    r *= lift;
    g *= lift;
    b *= lift;
  }
  return [r, g, b];
}

const DRS_OPEN = new Set([10, 12, 14]);

export class F1Conductor implements Conductor {
  private drivers = new Map<number, DriverTrack>();
  private entities: EntityChannel[] = [];
  private pulseQueue: Pulse[] = [];
  private disposed = false;
  private abort = new AbortController();

  private live = false;
  private sessionKey = 0;
  private sessionLabel = '';
  /** Session-time clock (epoch ms) that the visual is currently showing. */
  private playhead = 0;
  private sessionStart = 0;
  private sessionEnd = 0;
  private fetchedUntil = 0;
  private fetching = false;
  private livePollTimer = 0;
  private status: F1Status = 'loading';
  private statusMessage = 'Connecting to OpenF1…';

  constructor(private onStatus: (status: F1Status, message: string) => void) {
    this.init().catch((err) => {
      if (this.disposed) return;
      this.status = 'error';
      // A bare network/CORS failure usually means OpenF1 is gating access:
      // during live sessions the free tier is blocked entirely.
      this.statusMessage =
        err instanceof TypeError
          ? 'OpenF1 unreachable — it blocks free access while a session is live; try after the session'
          : err instanceof Error
            ? err.message
            : 'OpenF1 unavailable';
      this.onStatus('error', this.statusMessage);
    });
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${API}${path}`, { signal: this.abort.signal });
    if (!res.ok) throw new Error(`OpenF1 ${res.status} on ${path.split('?')[0]}`);
    return res.json() as Promise<T>;
  }

  private async init(): Promise<void> {
    const year = new Date().getFullYear();
    let sessions = await this.get<any[]>(`/sessions?year=${year}`);
    if (!sessions.length) sessions = await this.get<any[]>(`/sessions?year=${year - 1}`);
    if (!sessions.length) throw new Error('No F1 sessions found');
    sessions.sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));

    const now = Date.now();
    const liveSession = sessions.find(
      (s) => Date.parse(s.date_start) <= now && now <= Date.parse(s.date_end) + 5 * 60_000,
    );
    let session = liveSession;
    if (!session) {
      const past = sessions.filter((s) => Date.parse(s.date_end) < now);
      session = past.filter((s) => s.session_name === 'Race').pop() ?? past.pop();
    }
    if (!session) throw new Error('No usable F1 session');

    this.live = !!liveSession;
    this.sessionKey = session.session_key;
    this.sessionStart = Date.parse(session.date_start);
    this.sessionEnd = Date.parse(session.date_end);
    this.sessionLabel = `${session.country_name ?? session.circuit_short_name} ${session.session_name} ${session.year}`;

    const drivers = await this.get<any[]>(`/drivers?session_key=${this.sessionKey}`);
    for (const d of drivers) {
      if (this.drivers.has(d.driver_number)) continue;
      this.drivers.set(d.driver_number, {
        number: d.driver_number,
        acronym: d.name_acronym ?? `#${d.driver_number}`,
        color: hexToRgb(d.team_colour),
        samples: [],
        cursor: 0,
        drsOpen: false,
      });
      this.entities.push({
        id: `d${d.driver_number}`,
        color: hexToRgb(d.team_colour),
        fieldMix: 0.12,
        intensity: 0.6,
        speed: 1,
        turnBias: 0.2,
        branchChance: 0,
        label: d.name_acronym,
      });
    }

    if (this.live) {
      this.playhead = now - 15_000; // OpenF1 realtime data lags a few seconds
      this.fetchedUntil = this.playhead;
    } else {
      // Skip pre-race idling: start a few minutes into the session.
      this.playhead = Date.parse(session.date_start) + 6 * 60_000;
      this.fetchedUntil = this.playhead;
      await this.fetchWindow();
    }

    if (this.disposed) return;
    this.status = 'ready';
    this.statusMessage = this.live ? 'LIVE' : `REPLAY ${REPLAY_SPEED}×`;
    this.onStatus('ready', this.statusMessage);
  }

  private ingest(rows: any[]): void {
    for (const row of rows) {
      const track = this.drivers.get(row.driver_number);
      if (!track) continue;
      track.samples.push({
        t: Date.parse(row.date),
        speed: row.speed ?? 0,
        throttle: row.throttle ?? 0,
        brake: row.brake ?? 0,
        drs: DRS_OPEN.has(row.drs),
      });
    }
    // Trim consumed history so replays don't grow unbounded.
    for (const track of this.drivers.values()) {
      if (track.cursor > 4000) {
        track.samples.splice(0, track.cursor - 100);
        track.cursor = 100;
      }
    }
  }

  private async fetchWindow(): Promise<void> {
    if (this.fetching || this.disposed) return;
    this.fetching = true;
    try {
      const a = new Date(this.fetchedUntil).toISOString();
      const bMs = Math.min(this.fetchedUntil + WINDOW_SECONDS * 1000, this.sessionEnd);
      const b = new Date(bMs).toISOString();
      const rows = await this.get<any[]>(
        `/car_data?session_key=${this.sessionKey}&date>${encodeURIComponent(a)}&date<${encodeURIComponent(b)}`,
      );
      this.ingest(rows);
      this.fetchedUntil = bMs;
    } finally {
      this.fetching = false;
    }
  }

  private async fetchLive(): Promise<void> {
    if (this.fetching || this.disposed) return;
    this.fetching = true;
    try {
      const a = new Date(this.fetchedUntil).toISOString();
      const rows = await this.get<any[]>(
        `/car_data?session_key=${this.sessionKey}&date>${encodeURIComponent(a)}`,
      );
      this.ingest(rows);
      for (const track of this.drivers.values()) {
        const last = track.samples[track.samples.length - 1];
        if (last) this.fetchedUntil = Math.max(this.fetchedUntil, last.t);
      }
    } finally {
      this.fetching = false;
    }
  }

  /** Sample a driver's telemetry at the playhead (linear interpolation). */
  private sampleAt(track: DriverTrack, t: number): CarSample | null {
    const s = track.samples;
    if (s.length === 0) return null;
    while (track.cursor < s.length - 1 && s[track.cursor + 1].t <= t) track.cursor++;
    const cur = s[track.cursor];
    const next = s[Math.min(track.cursor + 1, s.length - 1)];
    if (cur.t > t + 10_000) return null; // data hasn't reached this time yet
    const span = next.t - cur.t;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - cur.t) / span)) : 0;
    return {
      t,
      speed: cur.speed + (next.speed - cur.speed) * f,
      throttle: cur.throttle + (next.throttle - cur.throttle) * f,
      brake: Math.max(cur.brake, next.brake),
      drs: cur.drs,
    };
  }

  update(dt: number): ConductorState {
    if (this.status !== 'ready') {
      return {
        energy: 0.3,
        entities: [],
        pulses: [],
        colorAt: () => [0.3, 0.4, 0.9],
        caption: this.status === 'loading' ? 'CONNECTING TO OPENF1…' : this.statusMessage,
      };
    }

    if (this.live) {
      this.playhead += dt * 1000;
      this.livePollTimer -= dt;
      if (this.livePollTimer <= 0) {
        this.livePollTimer = LIVE_POLL_SECONDS;
        this.fetchLive().catch(() => undefined);
      }
    } else {
      this.playhead += dt * 1000 * REPLAY_SPEED;
      if (this.playhead >= this.sessionEnd) {
        // Loop the replay from early in the session.
        this.playhead = this.sessionStart + 6 * 60_000;
        this.fetchedUntil = this.playhead;
        for (const track of this.drivers.values()) {
          track.samples.length = 0;
          track.cursor = 0;
          track.drsOpen = false;
        }
      }
      if (this.playhead > this.fetchedUntil - (WINDOW_SECONDS * 1000) / 3) {
        this.fetchWindow().catch(() => undefined);
      }
    }

    let energySum = 0;
    let energyCount = 0;
    for (let i = 0; i < this.entities.length; i++) {
      const entity = this.entities[i];
      const track = this.drivers.get(parseInt(entity.id.slice(1), 10))!;
      const sample = this.sampleAt(track, this.playhead);
      if (!sample) {
        entity.speed = 0.15;
        entity.intensity = 0.2;
        continue;
      }
      const v = Math.min(1, sample.speed / 330);
      entity.speed = 0.3 + v * 2.2;
      entity.intensity = 0.35 + (sample.throttle / 100) * 0.65;
      entity.turnBias = sample.brake > 30 ? 0.55 : 0.14;
      if (sample.drs && !track.drsOpen) {
        this.pulseQueue.push({ strength: 0.3, color: entity.color });
      }
      track.drsOpen = sample.drs;
      energySum += v;
      energyCount++;
    }

    const energy = energyCount ? 0.25 + 0.75 * (energySum / energyCount) : 0.3;
    const pulses = this.pulseQueue;
    this.pulseQueue = [];
    return {
      energy,
      entities: this.entities,
      pulses,
      lockEntityCount: true,
      // A deep ambient field so team colors stay dominant.
      colorAt: (_x, _y, _z, t) => [0.25 + 0.1 * Math.sin(t * 0.2), 0.3, 0.9],
      caption: `F1 ${this.statusMessage} · ${this.sessionLabel}`.toUpperCase(),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
  }
}
