"""HTTP client for the sim environment server (tools/sim-server.mjs)."""
import requests


class SimClient:
    def __init__(self, host="localhost", port=8010):
        self.base = f"http://{host}:{port}"

    def health(self):
        try:
            return requests.get(f"{self.base}/health", timeout=3).json().get("ok", False)
        except Exception:
            return False

    def reset(self, scenario, seed):
        return requests.post(f"{self.base}/reset", json={"scenario": scenario, "seed": seed}, timeout=120).json()

    def step(self, action):
        return requests.post(f"{self.base}/step", json={"action": [float(x) for x in action]}, timeout=60).json()

    def success(self):
        return requests.get(f"{self.base}/success", timeout=30).json()

    def info(self):
        return requests.get(f"{self.base}/info", timeout=30).json()
