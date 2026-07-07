import * as THREE from "three";

/**
 * Simplified UFACTORY xArm 5 model with a parallel-jaw gripper.
 *
 * DEGREES OF FREEDOM — 5 revolute joints. Limits below are the published
 * xArm 5 ranges:
 *
 *   J1 base yaw       ±360°        (local Y)
 *   J2 shoulder pitch -118°…120°   (local X)
 *   J3 elbow pitch    -225°…11°    (local X, mounted reversed)
 *   J4 wrist pitch    -97°…180°    (local X)
 *   J5 wrist roll     ±360°        (local Y, the tool axis)
 *
 * APPROXIMATIONS (see README): link lengths are rounded proportions chosen so
 * the whole chessboard is reachable with the gripper held vertical. Geometry is
 * primitive. The joint *axis signs* (see JointSpec.sign) are chosen so that a
 * natural reach over the board lands every joint inside the real limit ranges;
 * the model's zero pose (arm straight up) is our own convention, not the
 * factory home.
 *
 * At the zero pose the arm points straight up (+Y) and the gripper points up.
 */

const d2r = (d: number) => (d * Math.PI) / 180;

export interface JointSpec {
  name: string;
  axis: "x" | "y" | "z";
  /** Applied rotation = sign * jointValue. Lets joint limits match the arm. */
  sign: number;
  min: number; // radians (joint value, before sign)
  max: number; // radians
}

export interface Joint extends JointSpec {
  group: THREE.Group;
  angle: number; // current joint value (radians)
}

// Link lengths in meters.
const BASE_OFFSET = 0.05; // base plate top, where J1 is mounted
const L_COLUMN = 0.26; // J1 to shoulder (J2)
const L_UPPER = 0.31; // J2 to J3 (upper arm)
const L_FORE = 0.29; // J3 to J4 (forearm)
const L_WRIST = 0.05; // J4 to J5 (wrist)
const GRASP_Y = 0.065; // J5 frame: distance to the grasp point (between fingers)

export const JOINT_SPECS: JointSpec[] = [
  { name: "J1 base", axis: "y", sign: 1, min: d2r(-360), max: d2r(360) },
  { name: "J2 shoulder", axis: "x", sign: 1, min: d2r(-118), max: d2r(120) },
  { name: "J3 elbow", axis: "x", sign: -1, min: d2r(-225), max: d2r(11) },
  { name: "J4 wrist", axis: "x", sign: 1, min: d2r(-97), max: d2r(180) },
  { name: "J5 roll", axis: "y", sign: 1, min: d2r(-360), max: d2r(360) },
];

// Home pose: arm curled forward with the gripper hanging vertically down over
// the board. Cumulative pitch (J2 - J3 + J4) = 180°, so the tool points down.
export const REST_POSE: number[] = [0, d2r(42), d2r(-104), d2r(34), 0];

// Default mounting tilt of the wrist camera relative to the arm axis (radians).
// This is a calibration value, not a robot joint: it models how the physical
// camera is angled off the tool axis toward the gripper.
export const DEFAULT_WRIST_CAM_ANGLE = d2r(17);

export class Robot {
  readonly root: THREE.Group;
  readonly joints: Joint[] = [];
  readonly endEffector: THREE.Object3D; // grasp point between the fingers
  readonly gripper: THREE.Group;
  readonly wristCamera: THREE.PerspectiveCamera; // mounted below J4

  // Geometry exposed for the analytical IK solver.
  readonly shoulderHeight = BASE_OFFSET + L_COLUMN; // world height of J2
  readonly upperLength = L_UPPER;
  readonly foreLength = L_FORE;
  readonly toolLength = L_WRIST + GRASP_Y; // J4 -> grasp point along the tool

  private leftFinger!: THREE.Mesh;
  private rightFinger!: THREE.Mesh;
  private gripOpen = 1; // 0 = closed, 1 = open

  constructor() {
    this.root = new THREE.Group();
    this.root.name = "robotBase";

    const metal = (color: number) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.6 });
    const jointMat = new THREE.MeshStandardMaterial({
      color: 0x4a5564,
      roughness: 0.35,
      metalness: 0.7,
    });

    // Base plate.
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.05, 32), metal(0x2f3640));
    base.position.y = 0.025;
    base.castShadow = true;
    base.receiveShadow = true;
    this.root.add(base);

    const addJointVisual = (parent: THREE.Object3D, radius: number, alongX = false) => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, radius * 2.0, 24),
        jointMat
      );
      if (alongX) m.rotation.z = Math.PI / 2;
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    const addLink = (parent: THREE.Object3D, length: number, width: number, color: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(width, length, width), metal(color));
      m.position.y = length / 2;
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
    };

    // J1 — base yaw.
    const j1 = new THREE.Group();
    j1.position.y = 0.05;
    this.root.add(j1);
    addJointVisual(j1, 0.06);
    addLink(j1, L_COLUMN, 0.07, 0x3a6ea5);

    const shoulder = new THREE.Group();
    shoulder.position.y = L_COLUMN;
    j1.add(shoulder);

    // J2 — shoulder pitch.
    const j2 = new THREE.Group();
    shoulder.add(j2);
    addJointVisual(j2, 0.055, true);
    addLink(j2, L_UPPER, 0.06, 0x4f7fb5);

    const elbow = new THREE.Group();
    elbow.position.y = L_UPPER;
    j2.add(elbow);

    // J3 — elbow pitch.
    const j3 = new THREE.Group();
    elbow.add(j3);
    addJointVisual(j3, 0.048, true);
    addLink(j3, L_FORE, 0.05, 0x5f93c9);

    const wrist = new THREE.Group();
    wrist.position.y = L_FORE;
    j3.add(wrist);

    // J4 — wrist pitch.
    const j4 = new THREE.Group();
    wrist.add(j4);
    addJointVisual(j4, 0.04, true);
    addLink(j4, L_WRIST, 0.045, 0x76a6d8);

    // Wrist camera: mounted just below J4, looking along the remaining arm
    // (+Y tool axis, toward the gripper). Rides the J4 frame, so it pitches
    // with the wrist but does not spin with the J5 roll.
    this.wristCamera = new THREE.PerspectiveCamera(66, 1, 0.004, 6);
    this.wristCamera.position.set(0, 0.0, -0.058); // beside the wrist, set back
    j4.add(this.wristCamera);
    this.setWristCameraAngle(DEFAULT_WRIST_CAM_ANGLE);

    // J5 — wrist roll about the tool axis.
    const j5 = new THREE.Group();
    j5.position.y = L_WRIST;
    j4.add(j5);
    addJointVisual(j5, 0.03);

    // --- Gripper (extends +Y in the tool frame; points down when vertical) ---
    this.gripper = new THREE.Group();
    j5.add(this.gripper);
    this.buildGripper(this.gripper);

    // Grasp point (between the fingertips).
    const ee = new THREE.Group();
    ee.position.y = GRASP_Y;
    this.gripper.add(ee);
    this.endEffector = ee;

    const groups = [j1, j2, j3, j4, j5];
    JOINT_SPECS.forEach((spec, i) => {
      this.joints.push({ ...spec, group: groups[i], angle: 0 });
    });

    this.setAngles(REST_POSE);
  }

  private buildGripper(parent: THREE.Group): void {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x2b2f36,
      roughness: 0.4,
      metalness: 0.75,
    });
    const fingerMat = new THREE.MeshStandardMaterial({
      color: 0x9aa3b0,
      roughness: 0.35,
      metalness: 0.8,
    });

    // Palm / body block.
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.04), bodyMat);
    palm.position.y = 0.02;
    palm.castShadow = true;
    parent.add(palm);

    // Two fingers extending downward (+Y in tool frame). Jaws open along X.
    const fingerGeo = new THREE.BoxGeometry(0.01, 0.05, 0.03);
    this.leftFinger = new THREE.Mesh(fingerGeo, fingerMat);
    this.rightFinger = new THREE.Mesh(fingerGeo, fingerMat);
    this.leftFinger.position.set(-0.022, 0.06, 0);
    this.rightFinger.position.set(0.022, 0.06, 0);
    this.leftFinger.castShadow = true;
    this.rightFinger.castShadow = true;
    parent.add(this.leftFinger, this.rightFinger);
  }

  /**
   * Set the wrist camera's tilt relative to the arm axis (radians). 0 looks
   * straight along the remaining arm; positive tilts toward the gripper. The
   * 180° roll keeps the view egocentric. This is a calibration control, not a
   * robot joint.
   */
  setWristCameraAngle(angle: number, roll = Math.PI): void {
    this.wristCamera.rotation.set(Math.PI / 2 + angle, 0, 0);
    this.wristCamera.rotateZ(roll);
  }

  /** open = 1 fully open, 0 fully closed. */
  setGripper(open: number): void {
    this.gripOpen = THREE.MathUtils.clamp(open, 0, 1);
    const gap = THREE.MathUtils.lerp(0.01, 0.024, this.gripOpen);
    this.leftFinger.position.x = -gap;
    this.rightFinger.position.x = gap;
  }

  getGripper(): number {
    return this.gripOpen;
  }

  /** Clamp and apply a single joint angle, then refresh world matrices. */
  setAngle(index: number, angle: number, refresh = true): void {
    const j = this.joints[index];
    const clamped = Math.min(j.max, Math.max(j.min, angle));
    j.angle = clamped;
    j.group.rotation[j.axis] = j.sign * clamped;
    if (refresh) this.root.updateMatrixWorld(true);
  }

  setAngles(angles: number[]): void {
    angles.forEach((a, i) => this.setAngle(i, a, false));
    this.root.updateMatrixWorld(true);
  }

  getAngles(): number[] {
    return this.joints.map((j) => j.angle);
  }

  getEndEffectorPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return this.endEffector.getWorldPosition(target);
  }
}
