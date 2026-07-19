import * as THREE from 'three';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
} from 'postprocessing';
import type { Segment, PipeHead } from './pipeSim';

// Laser look: thin additive instanced capsule-ish segments + joint spheres,
// a dissolving ring buffer (old segments dim to black behind the growth),
// bright head sprites at each pipe tip, and mip-blurred bloom on top.

const TUBE_RADIUS = 0.075;
const FADE_WINDOW_FRAC = 0.3; // trailing fraction of the buffer that dissolves

export interface RendererQuality {
  capacity: number;
  pixelRatio: number;
  bloomHalfRes: boolean;
}

export function detectQuality(): RendererQuality {
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || Math.min(innerWidth, innerHeight) < 500;
  return mobile
    ? { capacity: 3200, pixelRatio: Math.min(devicePixelRatio, 2), bloomHalfRes: true }
    : { capacity: 5200, pixelRatio: Math.min(devicePixelRatio, 2), bloomHalfRes: false };
}

/** Ring buffer of instanced segments + joints; evicted slots return their token. */
class SegmentPool {
  readonly tubes: THREE.InstancedMesh;
  readonly joints: THREE.InstancedMesh;
  private head = 0;
  private used = 0;
  private baseColors: Float32Array;
  private tokens: Int32Array;
  private capacity: number;
  private dirQuats: THREE.Quaternion[] = [];
  private tmpMat = new THREE.Matrix4();
  private tmpPos = new THREE.Vector3();
  private tmpScale = new THREE.Vector3();
  private tmpColor = new THREE.Color();

  constructor(capacity: number, material: THREE.MeshBasicMaterial, public onEvict: (token: number) => void) {
    this.capacity = capacity;
    this.baseColors = new Float32Array(capacity * 3);
    this.tokens = new Int32Array(capacity).fill(-1);

    const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    const jointGeo = new THREE.SphereGeometry(1, 8, 6);
    this.tubes = new THREE.InstancedMesh(tubeGeo, material, capacity);
    this.joints = new THREE.InstancedMesh(jointGeo, material, capacity);
    for (const mesh of [this.tubes, this.joints]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      const colors = new Float32Array(capacity * 3);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    // Hide all slots initially with zero-scale matrices.
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) {
      this.tubes.setMatrixAt(i, zero);
      this.joints.setMatrixAt(i, zero);
    }

    const up = new THREE.Vector3(0, 1, 0);
    for (const d of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]) {
      this.dirQuats.push(new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(...d).normalize()));
    }
  }

  push(seg: Segment, gainBase: number): void {
    const i = this.head;
    if (this.tokens[i] >= 0) this.onEvict(this.tokens[i]);
    this.tokens[i] = seg.cellToken;

    const dx = seg.to[0] - seg.from[0];
    const dy = seg.to[1] - seg.from[1];
    const dz = seg.to[2] - seg.from[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let dirIdx = 0;
    if (Math.abs(dx) > 0.5) dirIdx = dx > 0 ? 0 : 1;
    else if (Math.abs(dy) > 0.5) dirIdx = dy > 0 ? 2 : 3;
    else dirIdx = dz > 0 ? 4 : 5;

    const radius = TUBE_RADIUS * (seg.bold ? 2.3 : 1);
    this.tmpPos.set(seg.from[0] + dx / 2, seg.from[1] + dy / 2, seg.from[2] + dz / 2);
    this.tmpScale.set(radius, len + radius, radius);
    this.tmpMat.compose(this.tmpPos, this.dirQuats[dirIdx], this.tmpScale);
    this.tubes.setMatrixAt(i, this.tmpMat);

    this.tmpPos.set(seg.to[0], seg.to[1], seg.to[2]);
    this.tmpScale.setScalar(radius * 1.6);
    this.tmpMat.compose(this.tmpPos, new THREE.Quaternion(), this.tmpScale);
    this.joints.setMatrixAt(i, this.tmpMat);

    const gain = (gainBase + seg.intensity * 0.95) * (seg.bold ? 1.25 : 1);
    this.baseColors[i * 3] = seg.color[0] * gain;
    this.baseColors[i * 3 + 1] = seg.color[1] * gain;
    this.baseColors[i * 3 + 2] = seg.color[2] * gain;
    this.tmpColor.setRGB(this.baseColors[i * 3], this.baseColors[i * 3 + 1], this.baseColors[i * 3 + 2]);
    this.tubes.setColorAt(i, this.tmpColor);
    this.joints.setColorAt(i, this.tmpColor.multiplyScalar(0.85));

    this.head = (i + 1) % this.capacity;
    this.used = Math.min(this.used + 1, this.capacity);
    this.tubes.instanceMatrix.needsUpdate = true;
    this.joints.instanceMatrix.needsUpdate = true;
    // Without this, fresh segments render black until the fade loop's first
    // flush — the original "moving dots with no pipes" startup bug.
    this.tubes.instanceColor!.needsUpdate = true;
    this.joints.instanceColor!.needsUpdate = true;
  }

  clear(): void {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) {
      this.tubes.setMatrixAt(i, zero);
      this.joints.setMatrixAt(i, zero);
      this.tokens[i] = -1;
    }
    this.baseColors.fill(0);
    (this.tubes.instanceColor!.array as Float32Array).fill(0);
    (this.joints.instanceColor!.array as Float32Array).fill(0);
    this.head = 0;
    this.used = 0;
    this.tubes.instanceMatrix.needsUpdate = true;
    this.joints.instanceMatrix.needsUpdate = true;
    this.tubes.instanceColor!.needsUpdate = true;
    this.joints.instanceColor!.needsUpdate = true;
  }

  /** Dim the oldest slots so the sculpture perpetually dissolves behind itself. */
  updateFade(): void {
    if (this.used < this.capacity * 0.5) return; // nothing old enough yet
    const window = Math.floor(this.capacity * FADE_WINDOW_FRAC);
    for (let k = 0; k < window; k++) {
      const slot = (this.head + k) % this.capacity;
      if (this.tokens[slot] < 0) continue;
      const alpha = (k / window) ** 1.6;
      this.tmpColor.setRGB(
        this.baseColors[slot * 3] * alpha,
        this.baseColors[slot * 3 + 1] * alpha,
        this.baseColors[slot * 3 + 2] * alpha,
      );
      this.tubes.setColorAt(slot, this.tmpColor);
      this.joints.setColorAt(slot, this.tmpColor);
    }
    this.tubes.instanceColor!.needsUpdate = true;
    this.joints.instanceColor!.needsUpdate = true;
  }
}

function makeGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export type RenderStyle = 'laser' | 'solid';

export class LaserRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: BloomEffect;
  private pool: SegmentPool;
  private material: THREE.MeshBasicMaterial;
  private headSprites: THREE.Sprite[] = [];
  private glowTex: THREE.Texture;
  private style: RenderStyle = 'laser';
  private glowSetting = 0.55;
  /** Transient global flash (pulses), decays each frame. */
  private pulseLevel = 0;

  constructor(canvas: HTMLCanvasElement, quality: RendererQuality, onEvict: (token: number) => void) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      powerPreference: 'high-performance',
      antialias: false,
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(quality.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020207);
    this.scene.fog = new THREE.FogExp2(0x020207, 0.019);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 300);

    this.material = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
    });

    this.pool = new SegmentPool(quality.capacity, this.material, onEvict);
    this.scene.add(this.pool.tubes, this.pool.joints);

    this.glowTex = makeGlowTexture();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new BloomEffect({
      luminanceThreshold: 0.32,
      luminanceSmoothing: 0.3,
      mipmapBlur: true,
      intensity: 1.2,
      radius: 0.68,
    });
    this.composer.addPass(new EffectPass(this.camera, this.bloom));

    this.applyStyle();
    this.resize();
  }

  addSegment(seg: Segment): void {
    // Solid style pushes base gain up so opaque pipes read fully saturated.
    this.pool.push(seg, this.style === 'solid' ? 0.75 : 0.45);
  }

  clearAll(): void {
    this.pool.clear();
  }

  /** Glow slider: 0–1 → bloom + exposure. Ignored in solid style (no glow). */
  setGlow(glow: number): void {
    this.glowSetting = glow;
    this.applyStyle();
  }

  /** laser = additive + bloom (neural); solid = opaque, no glow (F1). */
  setStyle(style: RenderStyle): void {
    this.style = style;
    this.applyStyle();
  }

  private applyStyle(): void {
    if (this.style === 'solid') {
      this.material.blending = THREE.NormalBlending;
      this.material.depthWrite = true;
      this.bloom.intensity = 0;
      this.renderer.toneMappingExposure = 1.05;
    } else {
      this.material.blending = THREE.AdditiveBlending;
      this.material.depthWrite = false;
      this.bloom.intensity = 0.3 + this.glowSetting * 2.0;
      this.renderer.toneMappingExposure = 0.85 + this.glowSetting * 0.45;
    }
    this.material.needsUpdate = true;
  }

  firePulse(strength: number): void {
    this.pulseLevel = Math.min(1.5, this.pulseLevel + strength);
  }

  updateHeads(heads: PipeHead[], energy: number): void {
    while (this.headSprites.length < heads.length) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
        }),
      );
      this.scene.add(sprite);
      this.headSprites.push(sprite);
    }
    for (let i = 0; i < this.headSprites.length; i++) {
      const sprite = this.headSprites[i];
      const head = heads[i];
      if (!head) {
        sprite.visible = false;
        continue;
      }
      sprite.visible = true;
      sprite.position.set(head.pos[0], head.pos[1], head.pos[2]);
      const solid = this.style === 'solid';
      const s = (0.5 + head.intensity * 0.65 + this.pulseLevel * 0.6) * (solid ? 0.7 : 1);
      sprite.scale.setScalar(s);
      (sprite.material as THREE.SpriteMaterial).color.setRGB(
        head.color[0] * (0.9 + energy * 0.6),
        head.color[1] * (0.9 + energy * 0.6),
        head.color[2] * (0.9 + energy * 0.6),
      );
      (sprite.material as THREE.SpriteMaterial).opacity = (0.4 + 0.4 * head.intensity) * (solid ? 0.6 : 1);
    }
  }

  render(dt: number): void {
    this.pulseLevel = Math.max(0, this.pulseLevel - dt * 2.4);
    // Pulses flash every segment at once via the shared material multiplier.
    this.material.color.setScalar(1 + this.pulseLevel * 0.9);
    this.pool.updateFade();
    this.composer.render(dt);
  }

  resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }
}
