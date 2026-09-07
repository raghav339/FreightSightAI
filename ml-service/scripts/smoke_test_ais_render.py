#!/usr/bin/env python3
"""
Task 8 — deployed-Render AIS smoke test.

Run this against the *deployed* ml-service URL (not localhost) to check the
exact "Done when" conditions from the fix-list prompt:

  1. GET /ais/status returns "enabled": true and "websocket_client_available": true.
  2. The feed is genuinely receiving data — message/position counts on
     /ais/status actually increase across a wait window, not just a
     trivially-true "enabled" flag.
  3. GET /ais/idle-vessels responds correctly (schema/connectivity check).

IMPORTANT HONESTY NOTE ABOUT STEP 3
------------------------------------
`idle_vessels()` only reports a vessel once it has been stationary near a
tracked port for at least MIN_IDLE_HOURS (4.0 hours by default — see
app/idle_detector.py). A "wait several minutes, then check /ais/idle-vessels"
smoke test run right after deploy will almost always show an EMPTY vessels
list even when everything is working correctly, simply because no vessel has
accumulated 4+ hours of persisted history yet. That is expected, not a
failure. This script therefore:
  - treats a non-error, well-formed /ais/idle-vessels response as a PASS for
    connectivity/schema, regardless of whether `vessels` is empty this soon
    after deploy, and
  - separately proves the feed is *live* by checking that ais_messages /
    positions on /ais/status increase during the wait window, and
  - tells you explicitly to re-run --idle-only a few hours later (this is
    exactly why the fix-list prompt says to do this 48 hours before the demo,
    not the night before).

Usage
-----
    python scripts/smoke_test_ais_render.py --url https://freightsight-ml-service.onrender.com
    python scripts/smoke_test_ais_render.py --url https://your-service.onrender.com --wait-minutes 10
    python scripts/smoke_test_ais_render.py --url https://your-service.onrender.com --idle-only

No third-party packages required (stdlib `urllib` only), so it can be run
from any machine with network access to the deployed URL — it does not need
to run inside the ml-service repo's own Python environment.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

DEFAULT_WAIT_MINUTES = 5
DEFAULT_LOOKBACK_HOURS_FOR_SCHEMA_CHECK = 48


def _get_json(url: str, timeout: int = 20):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        return resp.status, json.loads(body)


def check_status(base_url: str, label: str) -> dict:
    url = f"{base_url.rstrip('/')}/ais/status"
    print(f"\n[{label}] GET {url}")
    try:
        status_code, data = _get_json(url)
    except urllib.error.URLError as exc:
        print(f"  FAIL — could not reach /ais/status: {exc}")
        print("  -> Is the Render service actually deployed and awake? Free-tier")
        print("     services sleep after inactivity and take ~30-60s to spin up.")
        sys.exit(1)
    except Exception as exc:
        print(f"  FAIL — unexpected error calling /ais/status: {exc}")
        sys.exit(1)

    if status_code != 200:
        print(f"  FAIL — HTTP {status_code} from /ais/status: {data}")
        sys.exit(1)

    print(f"  enabled={data.get('enabled')}  "
          f"api_key_configured={data.get('api_key_configured')}  "
          f"websocket_client_available={data.get('websocket_client_available')}  "
          f"running={data.get('running')}")
    print(f"  messages={data.get('messages')}  "
          f"position_messages={data.get('position_messages')}  "
          f"static_messages={data.get('static_messages')}  "
          f"last_error={data.get('last_error')}")
    return data


def run_full_check(base_url: str, wait_minutes: float) -> None:
    baseline = check_status(base_url, "1/3 baseline status")

    if not baseline.get("websocket_client_available"):
        print("\nFAIL — websocket_client_available is False.")
        print("  -> websocket-client isn't installed in the deployed environment.")
        print("     Confirm ml-service/requirements.txt is actually being installed")
        print("     as part of the Render build step (see render.yaml buildCommand).")
        sys.exit(1)

    if not baseline.get("api_key_configured"):
        print("\nFAIL — api_key_configured is False.")
        print("  -> AISSTREAM_API_KEY is not set on the deployed service.")
        print("     Set it in the Render dashboard: service -> Environment ->")
        print("     AISSTREAM_API_KEY, then redeploy/restart the service.")
        sys.exit(1)

    if not baseline.get("enabled"):
        print("\nFAIL — enabled is False even though the key is configured and")
        print("  websocket-client is available. Check /ais/status's last_error")
        print("  field above, and Render's logs for this service.")
        sys.exit(1)

    print(f"\nBaseline looks correct. Waiting {wait_minutes:.1f} minute(s) for live")
    print("AIS traffic to accumulate before checking that counts actually moved...")
    time.sleep(max(0.0, wait_minutes * 60))

    after = check_status(base_url, "2/3 status after wait")

    msgs_before, msgs_after = baseline.get("messages") or 0, after.get("messages") or 0
    if msgs_after <= msgs_before:
        print(f"\nWARNING — message count did not increase ({msgs_before} -> {msgs_after})")
        print("  over the wait window. The socket reports 'enabled' and no error,")
        print("  but that alone doesn't prove it's receiving live traffic. Possible")
        print("  causes: outbound websockets blocked on this Render tier (the exact")
        print("  risk this task exists to catch), or the tracked bounding boxes")
        print("  (FreightSight's origin/destination ports) simply have no vessel")
        print("  traffic in this window — check last_connect_at/last_error above,")
        print("  and try a longer --wait-minutes before concluding it's blocked.")
    else:
        print(f"\nPASS — message count increased ({msgs_before} -> {msgs_after}) during "
              f"the wait window. The feed is genuinely live, not just 'enabled'.")

    idle_ok = check_idle_vessels(base_url)

    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"  /ais/status enabled + websocket_client_available : PASS")
    print(f"  live traffic increased during wait window         : "
          f"{'PASS' if msgs_after > msgs_before else 'CHECK MANUALLY (see WARNING above)'}")
    print(f"  /ais/idle-vessels responds correctly (schema)      : "
          f"{'PASS' if idle_ok else 'FAIL'}")
    print("\nRemember: this connectivity check passing is NOT the same as having")
    print("real idle-vessel results for the demo. Vessels only qualify as idle")
    print("after >= 4 hours of persisted stationary history near a tracked port.")
    print("Re-run with --idle-only a few hours later (ideally the next day) to")
    print("confirm /ais/idle-vessels actually returns non-empty, plausible results")
    print("— that's the real point of doing this 48h before the demo, not the")
    print("night before.")


def check_idle_vessels(base_url: str, lookback_hours: int = DEFAULT_LOOKBACK_HOURS_FOR_SCHEMA_CHECK) -> bool:
    url = f"{base_url.rstrip('/')}/ais/idle-vessels?lookback_hours={lookback_hours}"
    print(f"\n[3/3] GET {url}")
    try:
        status_code, data = _get_json(url, timeout=30)
    except Exception as exc:
        print(f"  FAIL — could not reach /ais/idle-vessels: {exc}")
        return False
    if status_code != 200:
        print(f"  FAIL — HTTP {status_code} from /ais/idle-vessels: {data}")
        return False
    if "vessels" not in data or "count" not in data:
        print(f"  FAIL — unexpected response shape (missing 'vessels'/'count'): {data}")
        return False

    count = data["count"]
    print(f"  OK — endpoint responded correctly. count={count}, "
          f"lookback_hours={data.get('lookback_hours')}")
    if count == 0:
        print("  (0 idle vessels is EXPECTED shortly after deploy — see note above. "
              "Re-check after several hours of persisted history.)")
    else:
        sample = data["vessels"][0]
        print(f"  Sample result: mmsi={sample.get('mmsi') or sample.get('vessel_category')}, "
              f"idle_duration_hours={sample.get('idle_duration_hours')}, "
              f"port_near={sample.get('port_near')}")
        print("  Non-empty result — looks like genuine live idle-vessel detection.")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, help="Deployed ml-service base URL, e.g. https://freightsight-ml-service.onrender.com")
    parser.add_argument("--wait-minutes", type=float, default=DEFAULT_WAIT_MINUTES,
                         help=f"Minutes to wait between the two /ais/status checks (default: {DEFAULT_WAIT_MINUTES})")
    parser.add_argument("--idle-only", action="store_true",
                         help="Skip the status/wait checks and only hit /ais/idle-vessels "
                              "(use this for a later re-check, hours after the first run)")
    args = parser.parse_args()

    if args.idle_only:
        check_status(args.url, "status (informational)")
        ok = check_idle_vessels(args.url)
        sys.exit(0 if ok else 1)

    run_full_check(args.url, args.wait_minutes)


if __name__ == "__main__":
    main()
