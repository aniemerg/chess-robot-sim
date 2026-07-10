"""
Policies for the closed-loop chess eval. All expose:
    reset(info)          # info = sim.info(): {task, goalKind, graspXY, placeXY}
    infer(obs) -> (H, 5) # obs = {base, wrist (b64 jpeg), state[5]}; action = [x,y,z,yaw,grip]

- OraclePolicy  : scripted state machine — upper bound; validates env + success.
- RandomPolicy  : random jitter — lower bound.
- OpenpiPolicy  : wraps openpi_client.WebsocketClientPolicy -> a real π0.5 server.
                  (Only imports openpi_client when used, so the others run anywhere.)
"""
import numpy as np

TRAVEL_Z = 318.0
HOME = np.array([257.0, -33.0, 313.0, 0.0, 1.0])
OPEN, CLOSED = 1.0, 0.24


class RandomPolicy:
    def __init__(self, horizon=5, seed=0):
        self.h = horizon
        self.rng = np.random.default_rng(seed)

    def reset(self, info):
        pass

    def infer(self, obs):
        s = np.array(obs["state"], float)
        out = []
        for _ in range(self.h):
            s = s + np.array([
                self.rng.uniform(-45, 45), self.rng.uniform(-45, 45), self.rng.uniform(-45, 45),
                0.0, 0.0])
            s[4] = self.rng.choice([OPEN, CLOSED])
            out.append(s.copy())
        return np.array(out)


class OraclePolicy:
    """Reactive state machine that completes the task — the eval's upper bound."""
    def __init__(self, chunk=6, grasp_z_move=46.0, grasp_z_pick=42.0, lift_z=364.0):
        self.chunk, self.gzm, self.gzp, self.lz = chunk, grasp_z_move, grasp_z_pick, lift_z

    def reset(self, info):
        self.kind = info["goalKind"]
        gx, gy = info["graspXY"]
        if self.kind == "move":
            px, py = info["placeXY"]
            self.phases = [
                (gx, gy, TRAVEL_Z, OPEN),    # above grasp
                (gx, gy, self.gzm, OPEN),     # descend
                (gx, gy, self.gzm, CLOSED),   # close
                (gx, gy, TRAVEL_Z, CLOSED),   # lift
                (px, py, TRAVEL_Z, CLOSED),   # traverse
                (px, py, self.gzm, CLOSED),   # descend to place
                (px, py, self.gzm, OPEN),     # release
                (px, py, TRAVEL_Z, OPEN),     # retract
            ]
        else:  # pickup
            self.phases = [
                (gx, gy, TRAVEL_Z, OPEN),
                (gx, gy, self.gzp, OPEN),
                (gx, gy, self.gzp, CLOSED),
                (gx, gy, self.lz, CLOSED),
            ]
        self.phase = 0

    def infer(self, obs):
        s = np.array(obs["state"], float)
        tx, ty, tz, tg = self.phases[min(self.phase, len(self.phases) - 1)]
        reached = np.hypot(s[0] - tx, s[1] - ty) < 12 and abs(s[2] - tz) < 12 and abs(s[4] - tg) < 0.1
        if reached and self.phase < len(self.phases) - 1:
            self.phase += 1
            tx, ty, tz, tg = self.phases[self.phase]
        out = []
        for i in range(1, self.chunk + 1):
            u = i / self.chunk
            out.append([s[0] + (tx - s[0]) * u, s[1] + (ty - s[1]) * u, s[2] + (tz - s[2]) * u, 0.0, tg])
        return np.array(out)


class OpenpiPolicy:
    """Wraps a remote π0.5 policy server via the openpi websocket client."""
    def __init__(self, host, port=8000, resize=224):
        from openpi_client import websocket_client_policy, image_tools  # noqa: F401
        self._it = image_tools
        self.client = websocket_client_policy.WebsocketClientPolicy(host=host, port=port)
        self.resize = resize
        self.prompt = None

    def reset(self, info):
        self.prompt = info["task"]

    def _decode(self, b64):
        import base64, io
        from PIL import Image
        return np.array(Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"))

    def infer(self, obs):
        base = self._it.convert_to_uint8(self._it.resize_with_pad(self._decode(obs["base"]), self.resize, self.resize))
        wrist = self._it.convert_to_uint8(self._it.resize_with_pad(self._decode(obs["wrist"]), self.resize, self.resize))
        payload = {
            "observation/image": base,
            "observation/wrist_image": wrist,
            "observation/state": np.array(obs["state"], float),
            "prompt": self.prompt,
        }
        return np.array(self.client.infer(payload)["actions"])


def make_policy(name, host=None, port=8000, seed=0):
    if name == "oracle":
        return OraclePolicy()
    if name == "random":
        return RandomPolicy(seed=seed)
    if name == "openpi":
        return OpenpiPolicy(host=host or "localhost", port=port)
    raise ValueError(f"unknown policy: {name}")
