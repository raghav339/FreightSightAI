import os

# Keep the suite deterministic and offline: no Brent fetching, and the risk
# score uses its original five factors unless a test opts in (see test_brent.py).
os.environ.setdefault("BRENT_ENABLED", "false")
