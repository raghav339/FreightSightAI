#!/usr/bin/env python3
"""Build an expanded, WPI-derived port-infrastructure reference for every
port FreightSight actually uses, replacing the old 18-port illustrative
`port_infra.json` bank/handling-rate numbers with values traceable to the
free, public-domain NGA World Port Index (WPI / Pub. 150).

USAGE
-----
    python scripts/build_port_infra_from_wpi.py

Writes: data/production/port_infra_wpi_expanded.json
(app/port_utils.py:get_port() merges this on top of the legacy
port_infra.json — WPI-derived draft/handling-rate values take precedence,
everything else falls back to the legacy file.)
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]  # ml-service/
DATA_DIR = ROOT / "data" / "production"
WPI_FILE = DATA_DIR / "world_port_index_clean.csv"
LEGACY_INFRA_FILE = ROOT / "port_infra.json"
TRAIN_FILE = ROOT / "train.py"
OUT_FILE = DATA_DIR / "port_infra_wpi_expanded.json"

# ---------------------------------------------------------------------
# NGA World Port Index (Pub. 150) depth code table.
#
# Source: NGA Pub. 150, "World Port Index Code Key" (public domain, US
# government publication). Verified 2026-09-06 against the 19th Edition
# (2009) full text, archived at:
#   https://apps.dtic.mil/sti/pdfs/ADA510220.pdf  (page "WORLD PORT INDEX
#   CODE KEY", METERS row)
#
# Depths are reported in 5-foot bands. Per NGA's own definition: "A depth
# of 31 feet would use letter 'K' ... 'K' means a least depth of 31 feet
# or greater, but not as great as 36 feet." i.e. each letter is a GUARANTEED
# MINIMUM, not a midpoint. We decode to that guaranteed minimum in meters,
# which is the conservative (safe) choice for a vessel-feasibility check —
# using the band midpoint or top would silently overstate available depth.
#
# There is no letter "I" in this scheme (NGA skips it, as do most such
# tables, to avoid confusion with "1"/"L").
# ---------------------------------------------------------------------
DEPTH_CODE_METERS_MIN = {
    "A": 23.2, "B": 21.6, "C": 20.1, "D": 18.6, "E": 17.1, "F": 15.5,
    "G": 14.0, "H": 12.5, "J": 11.0, "K": 9.4, "L": 7.9, "M": 6.4,
    "N": 4.9, "O": 3.4, "P": 1.8, "Q": 0.0,
}

# WPI's `max_vessel` field is only ever "L" (over 500 ft LOA can be
# accommodated) or "M" (ships under 500 ft) — coarse, but it is the only
# free length-related signal WPI provides. We turn it into a labeled
# *estimate*, never presented as a measured LOA limit.
MAX_VESSEL_LOA_ESTIMATE_M = {"L": 300.0, "M": 150.0}

# FreightSight port name -> (WPI port_name, expected WPI country code).
# The country code disambiguates WPI's duplicate names (e.g. there is a
# "GLADSTONE" in both Australia and Michigan, US).
PORT_NAME_ALIASES = {
    "Newcastle": ("NEWCASTLE", "AS"),
    "Gladstone": ("GLADSTONE", "AS"),
    "Hay Point": ("HAY POINT", "AS"),
    "Norfolk": ("NORFOLK", "US"),
    "Baltimore": ("BALTIMORE", "US"),
    "Nacala": ("NACALA", "MZ"),
    "Beira": ("BEIRA", "MZ"),
    "Vostochny": ("VOSTOCHNYY", "RS"),
    "Murmansk": ("MURMANSK", "RS"),
    "Samarinda": ("SAMARINDA", "ID"),
    "Taboneo": (None, None),  # not present in this WPI extract (see notes)
    "Paradip": ("PARADIP", "IN"),
    "Visakhapatnam": ("VISHAKHAPATNAM", "IN"),
    "Gangavaram": (None, None),  # not present in this WPI extract
    "Gopalpur": ("GOPALPUR", "IN"),
    "Dhamra": (None, None),  # not present in this WPI extract
    "Sagar Sandheads": (None, None),  # pilot/anchorage point, not a WPI port entry
    "Haldia": ("HALDIA PORT", "IN"),
    "Chennai": ("CHENNAI (MADRAS)", "IN"),
    "Kamarajar": ("KAMARAJAR PORT", "IN"),
    "Tuticorin": ("TUTICORIN", "IN"),
}


def referenced_ports() -> dict[str, str]:
    """Every port name FreightSight actually references, with its role.
    Parsed directly from train.py so this stays in sync automatically —
    no hardcoded duplicate list to drift out of date."""
    src = TRAIN_FILE.read_text()
    east_coast_match = re.search(r'EAST_COAST\s*=\s*(\[[^\]]*\])', src)
    origins_match = re.search(r'"origins":\s*\[p for p in (\[[^\]]*\])\]', src)
    if not east_coast_match or not origins_match:
        raise SystemExit("Could not locate EAST_COAST / origins lists in train.py — "
                          "port list extraction is out of sync with the source.")
    east_coast = json.loads(east_coast_match.group(1))
    origins = json.loads(origins_match.group(1))
    roles = {p: "discharge" for p in east_coast}
    roles.update({p: "loading" for p in origins})  # origins win if a name is somehow in both
    return roles


def decode_depth(code) -> float | None:
    if code is None or (isinstance(code, float) and pd.isna(code)):
        return None
    code = str(code).strip().upper()
    return DEPTH_CODE_METERS_MIN.get(code)


def handling_rate_tier(row: pd.Series) -> tuple[str, int]:
    """WPI has no cargo-handling-rate field at all (it's a navigational
    chart index, not an operations index). Derive a coarse tier from the
    only relevant signal WPI does provide: presence of fixed/mobile/
    floating cranes. Tons-per-day figures are rough, labeled estimates —
    never confused with a measured rate."""
    fixed = str(row.get("cranefixed", "")).strip().upper() == "Y"
    floating = str(row.get("cranefloat", "")).strip().upper() == "Y"
    mobile = str(row.get("cranemobil", "")).strip().upper() == "Y"
    if fixed or floating:
        return "high", 15000
    if mobile:
        return "medium", 9000
    return "low", 5000


def build():
    wpi = pd.read_csv(WPI_FILE)
    wpi["port_name"] = wpi["port_name"].astype(str)
    legacy = {}
    if LEGACY_INFRA_FILE.exists():
        with open(LEGACY_INFRA_FILE) as f:
            legacy = {k: v for k, v in json.load(f).items() if not k.startswith("_")}

    roles = referenced_ports()
    result = {}
    unmatched = []

    for name, role in roles.items():
        wpi_name, expected_country = PORT_NAME_ALIASES.get(name, (name.upper(), None))
        row = None
        if wpi_name:
            matches = wpi[wpi["port_name"].str.upper() == wpi_name]
            if len(matches) > 1 and expected_country:
                narrowed = matches[matches["country"] == expected_country]
                if len(narrowed):
                    matches = narrowed
            if len(matches):
                row = matches.iloc[0]

        legacy_entry = legacy.get(name, {})
        entry = {
            "role": role,
            "country": legacy_entry.get("country"),
        }

        if row is not None:
            chan_m = decode_depth(row.get("chan_depth"))
            cargo_m = decode_depth(row.get("cargodepth"))
            # Conservative: a vessel needs BOTH the approach channel and the
            # cargo pier/berth to be deep enough, so usable draft is bounded
            # by whichever of the two is shallower (when both are known).
            candidates = [d for d in (chan_m, cargo_m) if d is not None]
            if candidates:
                entry["max_draft_m"] = round(min(candidates), 1)
                entry["max_draft_m_source"] = (
                    "NGA World Port Index (chan_depth/cargodepth, decoded to guaranteed-minimum meters); "
                    "conservative min of channel depth and cargo pier depth"
                )
            tier, rate = handling_rate_tier(row)
            entry["cargo_handling_rate_tpd"] = rate
            entry["cargo_handling_rate_tier"] = tier
            entry["cargo_handling_rate_tpd_estimated"] = True
            entry["cargo_handling_rate_basis"] = (
                "WPI has no handling-rate field; tier estimated from WPI crane-presence flags "
                "(cranefixed/cranemobil/cranefloat), not a measured throughput figure"
            )
            max_vessel = str(row.get("max_vessel", "")).strip().upper()
            if max_vessel in MAX_VESSEL_LOA_ESTIMATE_M and "max_loa_m" not in legacy_entry:
                entry["max_loa_m"] = MAX_VESSEL_LOA_ESTIMATE_M[max_vessel]
                entry["max_loa_m_estimated"] = True
                entry["max_loa_m_basis"] = (
                    f"Estimated from WPI max_vessel code '{max_vessel}' "
                    f"({'over 500 ft' if max_vessel == 'L' else 'under 500 ft'} accommodated); "
                    "not a designed berth/channel LOA limit"
                )
            entry["wpi_port_name"] = str(row["port_name"])
            entry["wpi_harborsize"] = row.get("harborsize")
            entry["wpi_harbortype"] = row.get("harbortype")
        else:
            unmatched.append(name)
            # No free numeric depth source for this port. Fall back to the
            # legacy illustrative draft rather than inventing one, and say so.
            if "max_draft_m" in legacy_entry:
                entry["max_draft_m"] = legacy_entry["max_draft_m"]
                entry["max_draft_m_source"] = (
                    "Not present in this WPI extract — carried over from the illustrative "
                    "reference bank; still needs port-authority verification"
                )
            entry["cargo_handling_rate_tpd"] = legacy_entry.get("cargo_handling_rate_tpd", 8000)
            entry["cargo_handling_rate_tpd_estimated"] = True
            entry["cargo_handling_rate_basis"] = (
                "Not present in this WPI extract; carried over from the illustrative reference bank"
            )

        # Carry forward LOA/beam from the legacy bank where WPI gave us
        # nothing better (WPI has no numeric LOA/beam column in this
        # extract at all) — still illustrative, still labeled as such.
        for k in ("max_loa_m", "max_beam_m"):
            if k not in entry and k in legacy_entry:
                entry[k] = legacy_entry[k]
                entry[f"{k}_source"] = "illustrative_reference_bank_not_wpi"

        # typical_congestion is deliberately NEVER sourced from WPI (WPI has
        # no congestion field). Keep any existing curated assessment; for a
        # newly-covered port with none on file, mark it as an explicit,
        # unassessed assumption rather than inventing a specific rating.
        if "typical_congestion" in legacy_entry:
            entry["typical_congestion"] = legacy_entry["typical_congestion"]
            entry["typical_congestion_source"] = "illustrative_reference_bank_not_wpi"
        else:
            entry["typical_congestion"] = "unknown"
            entry["typical_congestion_source"] = (
                "No port-specific congestion assessment available yet; this is an explicit "
                "'unknown', not a measured or estimated rating — swap for a live AIS/port-authority "
                "feed (Task 7) rather than guessing a level here"
            )

        entry["notes"] = legacy_entry.get("notes", "")
        entry["data_status"] = "wpi_derived_verify_operational_limits_with_port_authority"
        result[name] = entry

    return result, unmatched


def main():
    result, unmatched = build()
    payload = {
        "_note": (
            "Port infrastructure derived from the free, public-domain NGA World Port Index "
            "(data/production/world_port_index_clean.csv) by scripts/build_port_infra_from_wpi.py. "
            "max_draft_m is decoded from WPI's letter-coded channel/cargo-pier depth bands to the "
            "guaranteed-minimum meters for that band (conservative). cargo_handling_rate_tpd is an "
            "ESTIMATE tiered from WPI crane-presence flags, not a measured throughput figure — WPI is "
            "a navigational-chart index and has no operations data. typical_congestion is never sourced "
            "from WPI. Ports not present in this WPI extract fall back to the illustrative reference "
            "bank and are flagged accordingly. Berth availability and terminal operating limits still "
            "require operator/port-authority verification before production use."
        ),
        "_unmatched_in_wpi": unmatched,
        "_generated_by": "scripts/build_port_infra_from_wpi.py",
        "ports": result,
    }
    OUT_FILE.write_text(json.dumps(payload, indent=2))
    print(f"Wrote {len(result)} ports to {OUT_FILE}")
    if unmatched:
        print(f"Not found in this WPI extract (fell back to illustrative bank): {unmatched}")


if __name__ == "__main__":
    main()
