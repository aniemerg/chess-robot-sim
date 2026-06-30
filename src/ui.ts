import * as THREE from "three";
import { JointSpec } from "./robot";

const r2d = (r: number) => (r * 180) / Math.PI;
const d2r = (d: number) => (d * Math.PI) / 180;

export type SolverKind = "idle" | "ok" | "warn" | "fail";

export interface UIHandlers {
  onJointChange: (index: number, radians: number) => void;
  onMove: (target: THREE.Vector3) => void;
  onReset: () => void;
}

/** Builds and updates the HTML control panel. */
export class UI {
  private sliders: HTMLInputElement[] = [];
  private vals: HTMLSpanElement[] = [];
  private tx = document.getElementById("tx") as HTMLInputElement;
  private ty = document.getElementById("ty") as HTMLInputElement;
  private tz = document.getElementById("tz") as HTMLInputElement;
  private ee = document.getElementById("ee") as HTMLSpanElement;
  private solver = document.getElementById("solver") as HTMLDivElement;

  build(specs: JointSpec[], pose: number[], handlers: UIHandlers): void {
    const container = document.getElementById("sliders")!;
    specs.forEach((spec, i) => {
      const row = document.createElement("div");
      row.className = "slider-row";

      const label = document.createElement("label");
      label.textContent = spec.name.split(" ")[0];
      label.title = spec.name;

      const input = document.createElement("input");
      input.type = "range";
      input.min = String(Math.round(r2d(spec.min)));
      input.max = String(Math.round(r2d(spec.max)));
      input.step = "1";
      input.value = String(Math.round(r2d(pose[i])));

      const val = document.createElement("span");
      val.className = "val";
      val.textContent = `${Math.round(r2d(pose[i]))}°`;

      input.addEventListener("input", () => {
        const deg = Number(input.value);
        val.textContent = `${deg}°`;
        handlers.onJointChange(i, d2r(deg));
      });

      row.append(label, input, val);
      container.appendChild(row);
      this.sliders.push(input);
      this.vals.push(val);
    });

    (document.getElementById("move") as HTMLButtonElement).addEventListener("click", () => {
      handlers.onMove(this.getTarget());
    });
    (document.getElementById("reset") as HTMLButtonElement).addEventListener("click", () => {
      handlers.onReset();
    });
  }

  /** Reflect joint angles (radians) into the sliders. */
  setSliderValues(angles: number[]): void {
    angles.forEach((a, i) => {
      const deg = Math.round(r2d(a));
      this.sliders[i].value = String(deg);
      this.vals[i].textContent = `${deg}°`;
    });
  }

  getTarget(): THREE.Vector3 {
    return new THREE.Vector3(
      Number(this.tx.value) || 0,
      Number(this.ty.value) || 0,
      Number(this.tz.value) || 0
    );
  }

  setTarget(v: THREE.Vector3): void {
    this.tx.value = v.x.toFixed(2);
    this.ty.value = v.y.toFixed(2);
    this.tz.value = v.z.toFixed(2);
  }

  setEndEffector(v: THREE.Vector3): void {
    this.ee.textContent = `x ${v.x.toFixed(3)}  y ${v.y.toFixed(3)}  z ${v.z.toFixed(3)}`;
  }

  setSolverStatus(text: string, kind: SolverKind): void {
    this.solver.textContent = text;
    this.solver.className = `solver ${kind === "idle" ? "" : kind}`.trim();
  }
}
