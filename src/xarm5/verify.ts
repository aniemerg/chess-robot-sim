import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Xarm5Robot } from "./robot";

// ROS arm-base frame: Z up, meters, base at origin, +X forward, +Y left.
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
camera.up.set(0, 0, 1); // Z-up
camera.position.set(0.95, -0.85, 0.7);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0.35, 0, 0.15);

scene.add(new THREE.HemisphereLight(0xffffff, 0x404650, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 1.3);
key.position.set(0.6, -0.4, 1.4);
key.castShadow = true;
scene.add(key);

// Desk on the XY plane at z=0 (PlaneGeometry normal is +Z — no rotation needed).
const desk = new THREE.Mesh(
  new THREE.PlaneGeometry(3, 3),
  new THREE.MeshStandardMaterial({ color: 0x1a1f27, roughness: 0.95 })
);
desk.receiveShadow = true;
scene.add(desk);
const grid = new THREE.GridHelper(2, 40, 0x2a3340, 0x1c232c);
grid.rotation.x = Math.PI / 2; // into the XY plane
scene.add(grid);
// Axes: X red, Y green, Z blue.
scene.add(new THREE.AxesHelper(0.3));

const robot = new Xarm5Robot();
scene.add(robot.root);

// TCP + target markers.
const tcpMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.012, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x57e08a })
);
scene.add(tcpMarker);
const targetMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.012, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xff4d6d })
);
targetMarker.visible = false;
scene.add(targetMarker);

const _tcp = new THREE.Vector3();
function refreshMarkers(): void {
  robot.getTCP(_tcp);
  tcpMarker.position.copy(_tcp);
}
refreshMarkers();

// --- Hooks for headless verification ---------------------------------------
(window as unknown as Record<string, unknown>).XARM5 = {
  setAnglesDeg(a: number[]) {
    robot.setAnglesDeg(a);
    refreshMarkers();
  },
  getTCP() {
    return robot.getTCP(new THREE.Vector3()).toArray();
  },
  // target in meters, arm-base frame
  solveTo(x: number, y: number, z: number) {
    const t = new THREE.Vector3(x, y, z);
    const r = robot.solveIK(t, { tolerance: 0.005, maxIterations: 160 });
    robot.setAnglesDeg(r.angles);
    refreshMarkers();
    targetMarker.position.copy(t);
    targetMarker.visible = true;
    return {
      error_mm: r.error * 1000,
      success: r.success,
      iterations: r.iterations,
      verticalError_deg: (robot.gripperVerticalError() * 180) / Math.PI,
      tcp: robot.getTCP(new THREE.Vector3()).toArray(),
      angles: r.angles.map((a) => Math.round(a * 10) / 10),
    };
  },
  homePose() {
    robot.setAnglesDeg([0, 0, 0, 0, 0]);
    refreshMarkers();
  },
  // Close-up on the end tool + gripper for diagnosis.
  closeup(dx = 0.18, dy = -0.18, dz = 0.06) {
    const ee = robot.endEffector.getWorldPosition(new THREE.Vector3());
    camera.position.set(ee.x + dx, ee.y + dy, ee.z + dz);
    controls.target.copy(ee);
    controls.update();
  },
  setAngle(i: number, deg: number) {
    const a = robot.getAnglesDeg();
    a[i] = deg;
    robot.setAnglesDeg(a);
    refreshMarkers();
  },
  // World directions of the tool/flange and gripper local axes at the current pose.
  axes() {
    const q = new THREE.Quaternion();
    const dir = (o: THREE.Object3D, ax: [number, number, number]) => {
      o.getWorldQuaternion(q);
      return new THREE.Vector3(...ax).applyQuaternion(q).toArray().map((v) => +v.toFixed(3));
    };
    const tool = robot.endEffector; // same orientation as the tool frame
    return {
      tool_X: dir(tool, [1, 0, 0]), tool_Y: dir(tool, [0, 1, 0]), tool_Z: dir(tool, [0, 0, 1]),
      grip_X: dir(robot.gripper, [1, 0, 0]), grip_Y: dir(robot.gripper, [0, 1, 0]), grip_Z: dir(robot.gripper, [0, 0, 1]),
    };
  },
};

function resize(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
window.addEventListener("resize", resize);

function tick(): void {
  resize();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
