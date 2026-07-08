import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { XARM5_JOINTS, XArm5JointModel } from "./kinematics";

/**
 * Official UFACTORY xArm 5 model in the native ROS arm-base frame.
 *
 * World = arm-base frame: **Z up**, meters, base at the origin, +X forward,
 * +Y left — identical to the frame the Magnus rollout `state`/`action` data is
 * recorded in (mm), so recorded TCP poses map in 1:1 (after mm -> m).
 *
 * Kinematics (joint origins/axes/limits) come from the official
 * `xarm5_default_kinematics.yaml` / `xarm5.urdf.xacro`; visuals are the official
 * STL meshes. Each joint = a fixed origin frame (xyz + rpy) then a revolute
 * child frame rotating about local +Z.
 */

const rad2deg = (r: number) => (r * 180) / Math.PI;
const deg2rad = (d: number) => (d * Math.PI) / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const WORLD_DOWN = new THREE.Vector3(0, 0, -1); // Z-up world
const GRIPPER_LOCAL_AXIS = new THREE.Vector3(0, 0, 1); // gripper points along +Z toward the fingertips
const VERTICAL_WEIGHT = 0.24;

interface JointRuntime {
  model: XArm5JointModel;
  group: THREE.Group; // fixed origin frame
  childFrame: THREE.Group; // revolute frame (rotates about local Z)
  valueDeg: number;
}

export interface IKResult {
  angles: number[]; // degrees
  error: number; // meters, TCP-to-target
  success: boolean;
  iterations: number;
}

export class Xarm5Robot {
  readonly root: THREE.Group;
  readonly joints: JointRuntime[] = [];
  readonly endEffector: THREE.Object3D; // tool flange point
  readonly gripper: THREE.Group;
  readonly tcp: THREE.Object3D; // controlled point (grasp point between fingers)

  private leftFinger!: THREE.Mesh;
  private rightFinger!: THREE.Mesh;
  private gripOpen = 1;
  private loader = new STLLoader();

  // scratch
  private _v1 = new THREE.Vector3();
  private _v2 = new THREE.Vector3();
  private _v3 = new THREE.Vector3();
  private _q = new THREE.Quaternion();

  constructor(opts: { onMeshLoad?: () => void } = {}) {
    this.root = new THREE.Group();
    this.root.name = "xarm5";
    this.addMesh(this.root, "/assets/xarm5/visual/link_base.stl", "white", opts.onMeshLoad);

    let parent: THREE.Object3D = this.root;
    XARM5_JOINTS.forEach((m, i) => {
      const group = new THREE.Group();
      group.position.set(m.origin.xyz[0], m.origin.xyz[1], m.origin.xyz[2]);
      group.rotation.set(m.origin.rpy[0], m.origin.rpy[1], m.origin.rpy[2]);
      parent.add(group);

      const child = new THREE.Group();
      group.add(child);
      this.addMesh(child, `/assets/xarm5/visual/link${i + 1}.stl`, i === 4 ? "silver" : "white", opts.onMeshLoad);

      this.joints.push({ model: m, group, childFrame: child, valueDeg: m.homeDeg });
      parent = child;
    });

    // End tool + gripper + controlled point.
    const tool = new THREE.Group();
    parent.add(tool);
    this.addMesh(tool, "/assets/end_tool/visual/end_tool_1300.stl", "dark", opts.onMeshLoad);

    this.endEffector = new THREE.Object3D();
    this.endEffector.position.set(0.085, 0, 0);
    tool.add(this.endEffector);

    this.gripper = this.buildGripper();
    this.endEffector.add(this.gripper);

    this.tcp = new THREE.Object3D();
    this.tcp.position.set(0, 0, 0.09);
    this.gripper.add(this.tcp);

    this.setAnglesDeg(XARM5_JOINTS.map((j) => j.homeDeg));
  }

  private addMesh(parent: THREE.Object3D, url: string, kind: "white" | "silver" | "dark", onLoad?: () => void): void {
    const material = new THREE.MeshStandardMaterial({
      color: kind === "white" ? 0xdde3e6 : kind === "silver" ? 0xaeb8bd : 0x283136,
      roughness: 0.52,
      metalness: kind === "dark" ? 0.08 : 0.14,
    });
    this.loader.load(
      url,
      (geometry) => {
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
        onLoad?.();
      },
      undefined,
      () => {
        const fallback = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), material);
        parent.add(fallback);
      }
    );
  }

  private buildGripper(): THREE.Group {
    const group = new THREE.Group();
    group.rotation.z = -Math.PI / 2;
    const palmMat = new THREE.MeshStandardMaterial({ color: 0x252c30, roughness: 0.5, metalness: 0.1 });
    const fingerMat = new THREE.MeshStandardMaterial({ color: 0xe6ecef, roughness: 0.46, metalness: 0.12 });

    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.018, 0.05), palmMat);
    palm.position.z = 0.022;
    palm.castShadow = true;
    group.add(palm);

    this.leftFinger = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.068), fingerMat);
    this.rightFinger = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.068), fingerMat);
    this.leftFinger.position.set(-0.025, -0.022, 0.058);
    this.rightFinger.position.set(0.025, -0.022, 0.058);
    this.leftFinger.castShadow = true;
    this.rightFinger.castShadow = true;
    group.add(this.leftFinger, this.rightFinger);
    return group;
  }

  // --- Forward kinematics ----------------------------------------------------

  setAnglesDeg(angles: number[]): void {
    for (let i = 0; i < this.joints.length; i++) {
      const j = this.joints[i];
      j.valueDeg = clamp(angles[i], rad2deg(j.model.lowerRad), rad2deg(j.model.upperRad));
      j.childFrame.quaternion.setFromAxisAngle(
        this._v1.set(j.model.axis[0], j.model.axis[1], j.model.axis[2]).normalize(),
        deg2rad(j.valueDeg)
      );
    }
    this.root.updateMatrixWorld(true);
  }

  getAnglesDeg(): number[] {
    return this.joints.map((j) => j.valueDeg);
  }

  /** World position of the controlled point (grasp point). */
  getTCP(out = new THREE.Vector3()): THREE.Vector3 {
    return this.tcp.getWorldPosition(out);
  }

  /** Angle (radians) between the gripper's pointing axis and straight down. */
  gripperVerticalError(): number {
    this.gripper.getWorldQuaternion(this._q);
    return this._v1.copy(GRIPPER_LOCAL_AXIS).applyQuaternion(this._q).normalize().angleTo(WORLD_DOWN);
  }

  setGripper(open: number): void {
    this.gripOpen = clamp(open, 0, 1);
    const gap = THREE.MathUtils.lerp(0.012, 0.03, this.gripOpen);
    this.leftFinger.position.x = -gap;
    this.rightFinger.position.x = gap;
  }

  getGripper(): number {
    return this.gripOpen;
  }

  // --- Inverse kinematics (CCD + vertical wrist refine) ----------------------

  /**
   * Position-only CCD that keeps the gripper vertical. J1/J2/J3/J5 do CCD
   * (J4 is reserved), then J4 is swept to best point the gripper straight down.
   * Mutates the pose; callers that only want angles should restore afterward.
   */
  solveIK(target: THREE.Vector3, opts: { tolerance?: number; maxIterations?: number } = {}): IKResult {
    const tolerance = opts.tolerance ?? 0.006;
    const maxIterations = opts.maxIterations ?? 120;
    let best = this.getAnglesDeg();
    let bestError = Infinity;
    let bestScore = Infinity;

    for (let iter = 0; iter < maxIterations; iter++) {
      for (let index = this.joints.length - 1; index >= 0; index--) {
        const joint = this.joints[index];
        if (!joint.model.ik || index === 3) continue; // reserve J4

        this.root.updateMatrixWorld(true);
        const pivot = joint.group.getWorldPosition(this._v1);
        const end = this.getTCP(this._v2);
        const axis = this.worldAxis(joint, this._v3);
        const toEnd = end.clone().sub(pivot);
        const toTarget = target.clone().sub(pivot);
        this.projectOnPlane(toEnd, axis);
        this.projectOnPlane(toTarget, axis);
        if (toEnd.lengthSq() < 1e-8 || toTarget.lengthSq() < 1e-8) continue;
        toEnd.normalize();
        toTarget.normalize();
        const cross = new THREE.Vector3().crossVectors(toEnd, toTarget);
        const signed = Math.atan2(axis.dot(cross), clamp(toEnd.dot(toTarget), -1, 1));
        const next = joint.valueDeg + rad2deg(signed);
        const angles = this.getAnglesDeg();
        angles[index] = next;
        this.setAnglesDeg(angles);
      }

      this.refineWristVertical(target);
      const error = this.getTCP(this._v2).distanceTo(target);
      const score = error + this.gripperVerticalError() * VERTICAL_WEIGHT;
      if (score < bestScore) {
        bestScore = score;
        bestError = error;
        best = this.getAnglesDeg();
      }
      if (error <= tolerance) return { angles: best, error, success: true, iterations: iter + 1 };
    }
    return { angles: best, error: bestError, success: bestError <= 0.03, iterations: maxIterations };
  }

  private refineWristVertical(target: THREE.Vector3): void {
    const wrist = this.joints[3];
    const base = this.getAnglesDeg();
    const min = rad2deg(wrist.model.lowerRad);
    const max = rad2deg(wrist.model.upperRad);
    let bestVal = base[3];
    let bestScore = Infinity;
    for (let v = min; v <= max; v += 2) {
      const cand = base.slice();
      cand[3] = v;
      this.setAnglesDeg(cand);
      const score = this.getTCP(this._v2).distanceTo(target) + this.gripperVerticalError() * VERTICAL_WEIGHT;
      if (score < bestScore) {
        bestScore = score;
        bestVal = v;
      }
    }
    const refined = base.slice();
    refined[3] = bestVal;
    this.setAnglesDeg(refined);
  }

  private worldAxis(joint: JointRuntime, out: THREE.Vector3): THREE.Vector3 {
    out.set(joint.model.axis[0], joint.model.axis[1], joint.model.axis[2]);
    joint.group.getWorldQuaternion(this._q);
    return out.applyQuaternion(this._q).normalize();
  }

  private projectOnPlane(v: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 {
    return v.sub(normal.clone().multiplyScalar(v.dot(normal)));
  }
}
