"""Task lists for the chess eval — (scenario, seed) pairs the sim resolves
deterministically into a board/piece layout + task string."""

SCENARIOS = ["queen_move", "queen_move_yaw90", "table_pickup"]


def build_tasks(scenarios=None, n_per=20, seed0=1000):
    """N tasks per scenario, distinct seeds (each seed => a distinct board/piece)."""
    scenarios = scenarios or SCENARIOS
    tasks = []
    for si, sc in enumerate(scenarios):
        for k in range(n_per):
            tasks.append((sc, seed0 + si * 10000 + k))
    return tasks
