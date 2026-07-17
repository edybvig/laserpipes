# LaserPipes

A never-ending, data-driven reimagining of the classic Windows 3D Pipes screensaver —
rendered as a festival laser show. Runs on desktop and mobile as an installable PWA.

## Modes

- **Neural** (default): two tiny in-browser neural networks with zero training data.
  A CPPN (mixed sin/tanh/gaussian activations) paints an ever-shifting color field,
  and a small steering MLP decides how pipes turn, branch, and speed up. Every
  ~25 seconds the weights mutate and the visual crossfades to the new "generation" —
  it literally evolves its behavior forever.
- **F1**: real Formula 1 telemetry from the free [OpenF1 API](https://openf1.org).
  One laser per driver in team color — speed drives growth, throttle drives
  brightness, braking forces turns, DRS fires pulses. Replays the most recent race
  time-accelerated. (Note: OpenF1 blocks free API access *while* a session is live.)
- **Mic** (toggle): WebAudio spectral-flux beat detection layers pulses and energy
  from whatever music is playing in the room onto either mode.

## Controls

Four sliders, auto-hiding UI: **Speed**, **Density**, **Color mood** (hue rotation),
**Glow** (bloom). Settings persist locally.

## Develop

```sh
npm install
npm run dev
```

## Build

```sh
npm run build   # typechecks + outputs dist/ with PWA service worker
```

Deployed via GitHub Actions to GitHub Pages on every push to `main`.
