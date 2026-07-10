"""
SKELETON: serve a π0.5 openpi policy on Modal (GPU), exposed to the Mac eval.

This is the path the reference post used (Jetson + Modal). It is a starting point
— it needs (a) a Modal account (`pip install modal && modal setup`) and (b) a
π0.5 checkpoint whose action space matches our xArm chess robot (see
docs/pi05_integration.md — the public pi05_droid/pi05_libero checkpoints do NOT).

Two ways to expose the server to the local eval:
  A) TCP tunnel: run openpi's websocket server inside the Modal container and use
     a Modal Tunnel (modal.forward) to get a public host:port; point the eval at it:
       python eval/eval_chess.py --policy openpi --policy-host <tunnel-host> --policy-port <port>
  B) Run the whole eval on a cloud Linux+GPU box instead (no Mac in the loop).

Fill in CHECKPOINT_CONFIG / CHECKPOINT_DIR once a checkpoint is available.
"""
import modal

CHECKPOINT_CONFIG = "pi05_droid"          # TODO: our xArm-chess config once we have one
CHECKPOINT_DIR = "gs://openpi-assets/checkpoints/pi05_droid"  # TODO: our fine-tuned dir
GPU = "L4"                                  # inference needs >=8GB (RTX4090/L4/A10); training needs more

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    # openpi is installed with uv from source; pin a commit for reproducibility.
    .run_commands(
        "git clone https://github.com/Physical-Intelligence/openpi.git /opt/openpi",
        "pip install uv",
        "cd /opt/openpi && GIT_LFS_SKIP_SMUDGE=1 uv pip install --system -e .",
    )
)
app = modal.App("pi05-chess-server", image=image)


@app.function(gpu=GPU, timeout=60 * 60, min_containers=1)
def serve(port: int = 8000):
    import subprocess
    with modal.forward(port, unencrypted=True) as tunnel:
        print("π0.5 server reachable at:", tunnel.tcp_socket)  # -> use as --policy-host/--policy-port
        subprocess.run(
            ["uv", "run", "scripts/serve_policy.py", "policy:checkpoint",
             f"--policy.config={CHECKPOINT_CONFIG}", f"--policy.dir={CHECKPOINT_DIR}",
             "--port", str(port)],
            cwd="/opt/openpi", check=True,
        )


# `modal run eval/serve_pi05_modal.py` then read the printed tcp_socket host:port.
@app.local_entrypoint()
def main():
    serve.remote()
