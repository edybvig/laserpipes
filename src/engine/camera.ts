import * as THREE from 'three';

// Slow cinematic drift: orbit with breathing radius and height, a gently
// wandering look-target, and an occasional smooth re-frame.

export class CameraRig {
  private theta = Math.random() * Math.PI * 2;
  private target = new THREE.Vector3();
  private targetGoal = new THREE.Vector3();
  private retargetIn = 8;

  constructor(private camera: THREE.PerspectiveCamera, private baseRadius = 30) {}

  update(dt: number, energy: number): void {
    const speed = 0.032 + energy * 0.045;
    this.theta += dt * speed;

    this.retargetIn -= dt;
    if (this.retargetIn <= 0) {
      this.retargetIn = 14 + Math.random() * 14;
      this.targetGoal.set(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 10,
      );
    }
    this.target.lerp(this.targetGoal, 1 - Math.exp(-dt * 0.4));

    const radius = this.baseRadius + Math.sin(this.theta * 0.63) * 6;
    const height = Math.sin(this.theta * 0.41) * 9 + 4;
    this.camera.position.set(
      Math.cos(this.theta) * radius,
      height,
      Math.sin(this.theta) * radius,
    );
    this.camera.lookAt(this.target);
  }
}
