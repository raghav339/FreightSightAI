# ================================================================
# FILE: ml-service/app/port_utils.py
# ================================================================
# ml-service/app/port_utils.py
"""
Port infrastructure + vessel-feasibility helpers.

Implements the parts of the SIH26006 problem statement that a plain rate
forecast doesn't cover:
  (b) Vessel Type Optimization  -> feasible_vessels_both_ports() / recommend_vessel()
  (d) Risk Mitigation           -> congestion_warning()

(Idle-scenario advice and COA contracting-strategy text live in decision_text.py.)
"""
import json
import os
from pathlib import Path
import re
import pandas as pd
import numpy as np


from data_paths import resolve_data_dir  # noqa: E402  (ml-service/ root is on sys.path when run as `app.main`)

# Deterministic English decision wording for vessel feasibility explanations.
from app.decision_text import (
    build_vessel_explanation,
    build_draft_exceeds_max,
)

_ML_SERVICE_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR, _ = resolve_data_dir(_ML_SERVICE_ROOT)
VESSEL_FILE = DATA_DIR / "vessel_class_master.csv"
if not VESSEL_FILE.exists():
    VESSEL_FILE = DATA_DIR / "global_cargo_ships.csv"
SERVICE_ROOT = os.path.join(os.path.dirname(__file__), "..")

# port_infra.json ships at ml-service/port_infra.json (service root), not
# under data/ (data/ is reserved for the training CSV) — check both so this
# works whether someone later chooses to move it alongside freight_data.csv.
_candidates = [
    os.path.join(SERVICE_ROOT, "port_infra.json"),
    os.path.join(DATA_DIR, "port_infra.json"),
]
_port_infra_path = next((p for p in _candidates if os.path.exists(p)), _candidates[0])
with open(_port_infra_path) as f:
    _raw = json.load(f)
PORT_INFRA = {k: v for k, v in _raw.items() if not k.startswith("_")}

# The checked-in JSON is a reference/master layer. Dimension values may be
# enriched by World Port Index at load time, but berth availability and
# terminal operating limits still require operator/authority verification.
for _name, _info in PORT_INFRA.items():
    _info.setdefault("data_status", "reference_master_verify_with_port_authority")
    _info.setdefault("source_note", "Project reference master; verify operational limits with current port/terminal authority")

# Typical max dimensions / capacity bands per vessel class (illustrative).
# Capacity bands intentionally match the weight bands already used elsewhere
# in the codebase (utils.py _default_vessel_for_weight) so behaviour doesn't
# change for existing callers, we only ADD a feasibility filter on top.
VESSEL_LIMIT_SPECS = {
    "Handysize": {"min_dwt": 10000, "max_dwt": 45000, "max_loa_m": 190, "max_beam_m": 32, "max_draft_m": 11.0},
    "Supramax":  {"min_dwt": 45001, "max_dwt": 80000, "max_loa_m": 200, "max_beam_m": 32.3, "max_draft_m": 12.5},
    "Panamax":   {"min_dwt": 80001, "max_dwt": 120000, "max_loa_m": 225, "max_beam_m": 32.3, "max_draft_m": 14.5},
    "Capesize":  {"min_dwt": 120001, "max_dwt": 220000, "max_loa_m": 300, "max_beam_m": 50, "max_draft_m": 18.0},
}
VESSEL_CLASS_ORDER = [
    "Handysize",
    "Supramax",
    "Panamax",
    "Capesize",
]

# Prefer the real World Port Index and cargo-ship dataset when the training
# inputs are present. The JSON below remains a UI/demo fallback until those
# named public datasets are supplied; the ML trainer never treats it as
# training data.
def _find_col(df: pd.DataFrame, candidates, required=True):
    """
    Find a dataframe column using normalized names.
    """
    normalized = {
        re.sub(r"[^a-z0-9]+", "_", str(c).strip().lower()).strip("_"): c
        for c in df.columns
    }

    for candidate in candidates:
        key = re.sub(
            r"[^a-z0-9]+",
            "_",
            str(candidate).strip().lower()
        ).strip("_")

        if key in normalized:
            return normalized[key]

    if required:
        raise ValueError(
            f"Required column not found. Tried: {candidates}. "
            f"Available columns: {list(df.columns)}"
        )

    return None

def _normalise_vessel_class(value):
    """
    Convert different spellings/names in the raw vessel dataset
    into the four vessel classes required by the project.
    """
    if pd.isna(value):
        return None

    value = str(value).strip().lower()

    # Keep Capesize before generic 'size' matching.
    if "capesize" in value or "cape size" in value:
        return "Capesize"

    if "panamax" in value or "panamax" in value:
        return "Panamax"

    if "supramax" in value or "supermax" in value:
        return "Supramax"

    if "handysize" in value or "handy size" in value:
        return "Handysize"

    return None

def _numeric_series(series):
    """
    Convert values such as '45,000', '45000 DWT', etc. to floats.
    """
    return pd.to_numeric(
        series.astype(str)
        .str.replace(",", "", regex=False)
        .str.extract(r"([-+]?\d*\.?\d+)")[0],
        errors="coerce",
    )


def _load_world_port_index():
    p=os.path.join(DATA_DIR,'world_port_index_clean.csv')
    if not os.path.exists(p): return
    try:
        import pandas as pd
        df=pd.read_csv(p)
        n=_find_col(df,['main port name','port name','Main Port Name','port_name']); cargo=_find_col(df,['cargo pier depth (m)','cargodepth'],False); chan=_find_col(df,['channel depth (m)','chan_depth'],False); loa=_find_col(df,['maximum vessel length (m)','max_loa_m'],False); beam=_find_col(df,['maximum vessel beam (m)','max_beam_m'],False); draft=_find_col(df,['maximum vessel draft (m)','max_draft_m'],False)
        if not n: return
        for _,r in df.iterrows():
            name=str(r[n]).strip()
            if not name: continue
            def val(c):
                try: return float(r[c]) if c and pd.notna(r[c]) else None
                except: return None
            info=PORT_INFRA.get(name,{})
            if val(loa) is not None: info['max_loa_m']=val(loa)
            if val(beam) is not None: info['max_beam_m']=val(beam)
            if val(draft) is not None: info['max_draft_m']=val(draft)
            if val(cargo) is not None: info['cargo_depth_m']=val(cargo)
            if val(chan) is not None: info['channel_depth_m']=val(chan)
            PORT_INFRA[name]=info
    except Exception as exc:
        print(f'World Port Index load warning: {exc}')

_load_world_port_index()


def _load_wpi_expanded_port_infra():
    """(Task 6) Merge in scripts/build_port_infra_from_wpi.py's output —
    real max_draft_m decoded from the NGA World Port Index's letter-coded
    depth bands (the raw `_load_world_port_index()` above never actually
    worked for depth: this cleaned CSV's chan_depth/cargodepth columns are
    letter codes like "K", not meters, so `float(r[c])` there silently
    fails for every row) plus a clearly-labeled estimated
    cargo_handling_rate_tpd tier. Falls back to the legacy 18-port bank
    entry for any field the WPI extract didn't cover for that port —
    covers every port referenced anywhere in the app (train.py's
    EAST_COAST + origins), not just the original 18.

    BUGFIX (2026-09-11): this used to unconditionally overwrite any field
    the WPI extract had a value for, even when port_infra.json already
    carried an explicit, dated figure for that same field. WPI's depth
    numbers are a *conservative minimum* from a 5-foot-banded letter code
    on a navigational-chart index that isn't always current for major bulk
    terminals -- e.g. it reported 6.4 m for Gladstone (a Capesize coal
    port whose port-authority procedures manual states ~17 m sailing
    draft is generally available) and 11.0 m for Paradip (whose inner
    harbour was dredged to 18.5 m in Aug 2026). Silently overwriting the
    master figure with that shallower estimate was making real ports look
    too shallow for their typical vessel class, which is what was
    producing "no feasible vessel" for most routes.

    Fix: WPI now only ever FILLS a field the master entry doesn't already
    have a value for -- it enriches gaps, it never overrides a populated
    master-file figure (verified or not). port_infra.json is the
    reference/master layer per its own docstring; WPI is a fallback, not
    an override.
    """
    p = os.path.join(DATA_DIR, "port_infra_wpi_expanded.json")
    if not os.path.exists(p):
        return
    # Companion/provenance keys (e.g. "max_draft_m_source" describes
    # "max_draft_m") should be skipped together with their base field --
    # otherwise a kept master value could end up labelled with WPI's
    # provenance note, which would misattribute where the number came from.
    _companion_suffixes = ("_source", "_tier", "_basis", "_estimated")

    def _base_field(key):
        for suffix in _companion_suffixes:
            if key.endswith(suffix):
                return key[: -len(suffix)]
        return None

    try:
        with open(p) as f:
            expanded = json.load(f)
        for name, entry in expanded.get("ports", {}).items():
            merged = PORT_INFRA.get(name, {})
            for k, v in entry.items():
                if v is None:
                    continue
                base = _base_field(k)
                if merged.get(base if base else k) is not None:
                    # Master already has a value for this field (or the
                    # field this key describes) -- keep it, and don't
                    # attach WPI's provenance note to a kept master value.
                    continue
                merged[k] = v
            PORT_INFRA[name] = merged
    except Exception as exc:
        print(f"WPI-expanded port infra load warning: {exc}")


_load_wpi_expanded_port_infra()


def _load_vessel_dataset():
    """
    Load Global Cargo Ships Dataset and calculate typical
    DWT/draft for each supported vessel class.

    IMPORTANT:
    Vessel class selection is derived from the actual dataset,
    not from hard-coded cargo-size bands.
    """
    if not VESSEL_FILE.exists():
        raise FileNotFoundError(
            f"Global Cargo Ships Dataset not found: {VESSEL_FILE}"
        )

    df = pd.read_csv(VESSEL_FILE)

    class_col = _find_col(
        df,
        [
            "vessel_class",
            "vessel class",
            "class",
            "vessel type",
            "vessel_type",
            "ship type",
            "ship_type",
            "type",
        ],
    )

    dwt_col = _find_col(
        df,
        [
            "dwt",
            "deadweight",
            "deadweight tonnage",
            "deadweight_tonnage",
            "typical_dwt",
            "deadweight_tons",
        ],
    )

    draft_col = _find_col(
        df,
        [
            "draft",
            "draught",
            "typical_draft",
        ],
        required=False,
    )

    length_col = _find_col(
        df,
        [
            "length",
            "loa",
            "length overall",
            "loa_m",
        ],
        required=False,
    )

    beam_col = _find_col(
        df,
        [
            "beam",
            "breadth",
            "width",
            "beam_m",
        ],
        required=False,
    )

    cleaned = pd.DataFrame(
        {
            "vessel_class": df[class_col].apply(
                _normalise_vessel_class
            ),
            "dwt": _numeric_series(df[dwt_col]),
        }
    )

    if draft_col:
        cleaned["draft"] = _numeric_series(df[draft_col])
    else:
        cleaned["draft"] = np.nan

    if length_col:
        cleaned["length"] = _numeric_series(df[length_col])
    else:
        cleaned["length"] = np.nan

    if beam_col:
        cleaned["beam"] = _numeric_series(df[beam_col])
    else:
        cleaned["beam"] = np.nan

    cleaned = cleaned.dropna(
        subset=["vessel_class", "dwt"]
    )

    cleaned = cleaned[
        cleaned["vessel_class"].isin(VESSEL_CLASS_ORDER)
    ]

    if cleaned.empty:
        raise ValueError(
            "Global Cargo Ships Dataset contains no usable "
            "Handysize/Supramax/Panamax/Capesize records."
        )

    # The plan says that if DWT is missing but vessel class exists,
    # use the median DWT for that class.
    #
    # We therefore calculate class medians from all valid DWT rows.
    grouped = (
        cleaned
        .groupby("vessel_class", as_index=False)
        .agg(
            typical_dwt=("dwt", "median"),
            typical_draft=("draft", "median"),
            typical_length=("length", "median"),
            typical_beam=("beam", "median"),
            vessel_count=("dwt", "count"),
        )
    )

    # Keep the intended order from smallest to largest class.
    grouped["class_order"] = grouped["vessel_class"].map(
        {
            name: index
            for index, name in enumerate(VESSEL_CLASS_ORDER)
        }
    )

    grouped = (
        grouped
        .sort_values("class_order")
        .drop(columns=["class_order"])
        .reset_index(drop=True)
    )

    return grouped

VESSEL_SPECS = _load_vessel_dataset()


for _row in VESSEL_SPECS.itertuples():
    _spec = VESSEL_LIMIT_SPECS.get(_row.vessel_class)
    if _spec is None:
        continue
    if pd.notna(_row.typical_length):
        _spec["max_loa_m"] = float(_row.typical_length)
    if pd.notna(_row.typical_beam):
        _spec["max_beam_m"] = float(_row.typical_beam)
    if pd.notna(_row.typical_draft):
        _spec["max_draft_m"] = float(_row.typical_draft)


def get_vessel_specs():
    """
    Return vessel specifications as JSON-safe dictionaries.
    """
    result = []

    for _, row in VESSEL_SPECS.iterrows():
        result.append(
            {
                "vessel_class": row["vessel_class"],
                "typical_dwt": (
                    float(row["typical_dwt"])
                    if pd.notna(row["typical_dwt"])
                    else None
                ),
                "typical_draft": (
                    float(row["typical_draft"])
                    if pd.notna(row["typical_draft"])
                    else None
                ),
                "typical_length": (
                    float(row["typical_length"])
                    if pd.notna(row["typical_length"])
                    else None
                ),
                "typical_beam": (
                    float(row["typical_beam"])
                    if pd.notna(row["typical_beam"])
                    else None
                ),
                "vessel_count": int(row["vessel_count"]),
            }
        )

    return result

def _select_smallest_cargo_suitable_class(cargo_tonnage):
    """
    Select the smallest vessel class whose dataset-derived
    typical DWT can carry the requested cargo.
    """
    cargo_tonnage = float(cargo_tonnage)

    if not np.isfinite(cargo_tonnage) or cargo_tonnage <= 0:
        raise ValueError(
            "cargo_tonnage must be a positive finite number."
        )

    for _, row in VESSEL_SPECS.iterrows():
        typical_dwt = float(row["typical_dwt"])

        if typical_dwt >= cargo_tonnage:
            return row.to_dict()

    # Cargo is larger than the largest class represented in
    # the dataset.
    largest = VESSEL_SPECS.iloc[-1].to_dict()

    return {
        **largest,
        "_over_capacity": True,
    }


def get_port(name: str):
    """Case/alias-tolerant lookup; returns None if we have no infra data for it."""
    if name in PORT_INFRA:
        return PORT_INFRA[name]
    normalized = str(name).strip().lower()
    for key, info in PORT_INFRA.items():
        if key.strip().lower() == normalized:
            return info
        if info.get("alias", "").lower() == normalized:
            return info
    return None


def check_vessel_port_compatibility(vessel_type: str, port_info: dict | None, *, label: str = "port"):
    """(Phase 6) THE canonical vessel/port feasibility check — used for BOTH
    the origin port and the destination port, so the two ends can never
    silently apply different rules.

    Checks vessel length vs maximum LOA, vessel beam vs maximum beam, and
    vessel draft vs cargo/channel depth. Unknown constraints are not treated
    as failures (matches prior behaviour) — a port with no LOA data on file
    doesn't get an LOA rejection, it just isn't checked on that dimension.

    Returns (ok: bool, reason: str | None). `reason` is None when ok=True,
    and a specific, human-readable explanation (e.g. "Origin port draft
    limitation") when ok=False — this is what powers Phase 6's
    rejection_reason field, instead of a bare boolean.
    """
    if not port_info:
        return False, f"No infrastructure data on file for this {label}, so vessel safety there cannot be confirmed."

    spec = VESSEL_LIMIT_SPECS.get(vessel_type)
    if not spec:
        return False, f"Unrecognized vessel class '{vessel_type}'."

    max_loa = port_info.get("max_loa_m")
    max_beam = port_info.get("max_beam_m")

    # World Port Index may expose either cargo pier depth or channel depth.
    # BUGFIX: the production port data (port_infra_wpi_expanded.json, merged
    # into every port at import time) only ever populates max_draft_m — it
    # never sets cargo_depth_m/channel_depth_m. Checking only those two
    # fields meant applicable_depths was always empty for every real port in
    # the dataset, so this function's draft check silently never ran (LOA
    # and beam were still enforced, draft was not) — a Capesize vessel could
    # be shown as feasible at a port only 4-6m deep. Fall back to
    # max_draft_m so a port with only that field set still gets a real
    # draft check.
    cargo_depth = port_info.get("cargo_depth_m")
    channel_depth = port_info.get("channel_depth_m")
    max_draft_field = port_info.get("max_draft_m")
    applicable_depths = [v for v in (cargo_depth, channel_depth, max_draft_field) if v is not None]

    if max_loa is not None and spec["max_loa_m"] > max_loa:
        return False, (
            f"{label.capitalize()} LOA limitation: vessel LOA ({spec['max_loa_m']:.0f} m) "
            f"exceeds the {label}'s maximum LOA ({max_loa:.0f} m)."
        )

    if max_beam is not None and spec["max_beam_m"] > max_beam:
        return False, (
            f"{label.capitalize()} beam limitation: vessel beam ({spec['max_beam_m']:.1f} m) "
            f"exceeds the {label}'s maximum beam ({max_beam:.1f} m)."
        )

    if applicable_depths:
        limiting_depth = min(applicable_depths)
        if spec["max_draft_m"] > limiting_depth:
            return False, (
                f"{label.capitalize()} draft limitation: vessel draft ({spec['max_draft_m']:.1f} m) "
                f"exceeds the {label}'s usable depth ({limiting_depth:.1f} m)."
            )

    return True, None


def vessel_fits_port(vessel_type: str, port_info: dict | None) -> bool:
    """
    Backward-compatible boolean wrapper around check_vessel_port_compatibility().
    Kept because compare_origins()/idle_alternatives() only need a yes/no
    answer for a single-port check; use check_vessel_port_compatibility()
    directly when the rejection reason matters.
    """
    ok, _ = check_vessel_port_compatibility(vessel_type, port_info)
    return ok


def feasible_vessels_both_ports(cargo_tonnage, origin_port_info, destination_port_info):
    """(Phase 6) A vessel is feasible ONLY if:
        cargo_compatible AND origin_port_compatible AND destination_port_compatible
    Uses the SAME check_vessel_port_compatibility() for both ends — no
    duplicated origin/destination logic.

    Returns (feasible: list[dict], rejected: list[dict]). Every rejected
    entry carries a `rejection_reason` explaining exactly why (cargo
    capacity, origin port limitation, or destination port limitation) —
    never just "not feasible" with no explanation.
    """
    cargo_tonnage = float(cargo_tonnage)
    feasible, rejected = [], []

    for _, row in VESSEL_SPECS.iterrows():
        vessel_class = row["vessel_class"]
        typical_dwt = float(row["typical_dwt"])
        entry = {
            "vessel_class": vessel_class,
            "typical_dwt": typical_dwt,
            "typical_draft": float(row["typical_draft"]) if pd.notna(row["typical_draft"]) else None,
            "typical_length": float(row["typical_length"]) if pd.notna(row["typical_length"]) else None,
            "typical_beam": float(row["typical_beam"]) if pd.notna(row["typical_beam"]) else None,
        }

        if typical_dwt < cargo_tonnage:
            rejected.append({
                **entry,
                "rejection_reason": (
                    f"Cargo exceeds recommended capacity: {cargo_tonnage:,.0f} t requested vs. "
                    f"{vessel_class}'s typical DWT of {typical_dwt:,.0f} t."
                ),
            })
            continue

        origin_ok, origin_reason = check_vessel_port_compatibility(vessel_class, origin_port_info, label="origin port")
        if not origin_ok:
            rejected.append({**entry, "rejection_reason": origin_reason})
            continue

        dest_ok, dest_reason = check_vessel_port_compatibility(vessel_class, destination_port_info, label="destination port")
        if not dest_ok:
            rejected.append({**entry, "rejection_reason": dest_reason})
            continue

        feasible.append(entry)

    return feasible, rejected


def _limiting_depth(port_info):
    """Same draft-limiting-depth logic as check_vessel_port_compatibility
    (cargo pier depth, else channel depth, else max_draft_m — whichever
    figures are on file, take the shallowest). Pulled out standalone so
    recommend_vessel() can report the correct depth for whichever port
    (origin or destination) actually caused a given vessel's rejection,
    instead of always reporting the destination's.
    """
    if not port_info:
        return None
    values = [
        v
        for v in (
            port_info.get("cargo_depth_m"),
            port_info.get("channel_depth_m"),
            port_info.get("max_draft_m"),
        )
        if v is not None
    ]
    return min(values) if values else None


def recommend_vessel(
    cargo_tonnage,
    port_depth,
    *,
    port_name=None,
    origin_port_name=None,
    predicted_rate=None,
    previous_rate=None,
    max_draft=None
):
    """
    Main rule-based vessel recommendation.

    Algorithm:
      1. Find the smallest dataset-derived vessel class whose
         typical DWT >= cargo tonnage.
      2. Check its feasibility against BOTH the origin and destination
         ports (Phase 6 — previously destination-only).
      3. If it does not fit, inspect smaller/alternative feasible
         vessel classes (feasible at BOTH ends) and explain the trade-off.
      4. Combine the vessel recommendation with rate direction
         when rate information is available.
    """
    cargo_tonnage = float(cargo_tonnage)

    port_info = get_port(port_name) if port_name else None
    origin_port_info = get_port(origin_port_name) if origin_port_name else None

    selected = _select_smallest_cargo_suitable_class(
        cargo_tonnage
    )

    candidates, rejected = feasible_vessels_both_ports(
        cargo_tonnage,
        origin_port_info,
        port_info,
    )

    if max_draft is not None:
        still_feasible = []
        for c in candidates:
            if c["typical_draft"] is not None and c["typical_draft"] > float(max_draft):
                rejected.append({**c, "rejection_reason": build_draft_exceeds_max( draft=c["typical_draft"], max_draft=float(max_draft)
                )})
                continue
            still_feasible.append(c)
        candidates = still_feasible

    selected_class = selected["vessel_class"]
    selected_draft = (
        float(selected["typical_draft"])
        if pd.notna(selected["typical_draft"])
        else None
    )

    # Derive feasibility for the "selected" (smallest cargo-capable) class
    # from the same candidates list used everywhere else, so LOA/beam/draft
    # constraints at BOTH ports are respected consistently rather than
    # re-deriving a separate answer here.
    selected_port_ok = any(c["vessel_class"] == selected_class for c in candidates)

    # BUGFIX: the analyst-read explanation used to always say "exceeds the
    # destination port depth", using only the destination's depth, even
    # when the selected class actually failed at the ORIGIN port (a
    # draft/LOA/beam limitation there is checked and can fail first — see
    # feasible_vessels_both_ports). That produced explanations that were
    # not just mislabeled but arithmetically false, e.g. claiming a 10.0 m
    # draft "exceeds" a 15.0 m destination depth when the real, correct
    # constraint was an 8.0 m origin depth. Work out which port actually
    # rejected the selected class (from its own rejection_reason, already
    # computed by check_vessel_port_compatibility) and use THAT port's
    # name/depth in the explanation instead.
    failure_port_label = None
    failure_depth = None
    if not selected_port_ok:
        selected_rejection = next(
            (r for r in rejected if r["vessel_class"] == selected_class), None
        )
        reason = (selected_rejection or {}).get("rejection_reason") or ""
        if reason.startswith("Origin port"):
            failure_port_label = "origin"
            failure_depth = _limiting_depth(origin_port_info)
        elif reason.startswith("Destination port"):
            failure_port_label = "destination"
            failure_depth = _limiting_depth(port_info)
        # Any other reason (e.g. an unrecognized vessel class, or no
        # infrastructure data on file) leaves failure_port_label as None,
        # and build_vessel_explanation falls back to the destination depth
        # exactly as before.

    # Find all physically feasible cargo-capable vessels (already filtered
    # to both-port-feasible by feasible_vessels_both_ports above).
    feasible = candidates

    best_feasible = (
        feasible[0]
        if feasible
        else None
    )

    if predicted_rate is not None and previous_rate is not None:
        predicted_rate = float(predicted_rate)
        previous_rate = float(previous_rate)

    decision_text = build_vessel_explanation(
        selected_class=selected_class,
        cargo_tonnage=cargo_tonnage,
        selected_draft=selected_draft,
        port_depth=port_depth,
        selected_port_ok=selected_port_ok,
        best_feasible_class=best_feasible["vessel_class"] if best_feasible is not None else None,
        over_capacity=bool(selected.get("_over_capacity")),
        predicted_rate=predicted_rate,
        previous_rate=previous_rate,
        failure_port_label=failure_port_label,
        failure_depth=failure_depth,
    )
    recommended_class = decision_text["recommended_class"]
    warnings = decision_text["warnings"]
    timing = decision_text["timing"]

    return {
        "recommended_vessel": recommended_class,
        "selected_cargo_suitable_class": selected_class,
        "cargo_tonnage": cargo_tonnage,
        "port_depth": (
            float(port_depth)
            if port_depth is not None
            else None
        ),
        "typical_dwt": (
            float(selected["typical_dwt"])
            if pd.notna(selected["typical_dwt"])
            else None
        ),
        "typical_draft": selected_draft,
        "port_constraint_satisfied": bool(
            selected_port_ok
        ),
        "timing": timing,
        "warnings": warnings,
        "explanation": decision_text["explanation"],
        "feasible_vessels": candidates,
        "rejected_vessels": rejected,
    }



APPROX_DISTANCE_NM = {
    "Newcastle":  {"Paradip": 4550, "Visakhapatnam": 4400, "Gangavaram": 4380, "Gopalpur": 4470, "Dhamra": 4600, "Sagar Sandheads": 4750, "Haldia": 4780},
    "Gladstone":  {"Paradip": 4700, "Visakhapatnam": 4550, "Gangavaram": 4530, "Gopalpur": 4620, "Dhamra": 4750, "Sagar Sandheads": 4900, "Haldia": 4930},
    "Hay Point":  {"Paradip": 4650, "Visakhapatnam": 4500, "Gangavaram": 4480, "Gopalpur": 4570, "Dhamra": 4700, "Sagar Sandheads": 4850, "Haldia": 4880},
    "Norfolk":    {"Paradip": 10600, "Visakhapatnam": 10500, "Gangavaram": 10480, "Gopalpur": 10550, "Dhamra": 10650, "Sagar Sandheads": 10800, "Haldia": 10830},
    "Baltimore":  {"Paradip": 10700, "Visakhapatnam": 10600, "Gangavaram": 10580, "Gopalpur": 10650, "Dhamra": 10750, "Sagar Sandheads": 10900, "Haldia": 10930},
    "Nacala":     {"Paradip": 3200, "Visakhapatnam": 3050, "Gangavaram": 3030, "Gopalpur": 3120, "Dhamra": 3250, "Sagar Sandheads": 3400, "Haldia": 3430},
    "Beira":      {"Paradip": 3350, "Visakhapatnam": 3200, "Gangavaram": 3180, "Gopalpur": 3270, "Dhamra": 3400, "Sagar Sandheads": 3550, "Haldia": 3580},
    "Vostochny":  {"Paradip": 5300, "Visakhapatnam": 5150, "Gangavaram": 5130, "Gopalpur": 5220, "Dhamra": 5350, "Sagar Sandheads": 5450, "Haldia": 5480},
    "Murmansk":   {"Paradip": 10900, "Visakhapatnam": 10800, "Gangavaram": 10780, "Gopalpur": 10850, "Dhamra": 10950, "Sagar Sandheads": 11100, "Haldia": 11130},
    "Samarinda":  {"Paradip": 2350, "Visakhapatnam": 2200, "Gangavaram": 2180, "Gopalpur": 2270, "Dhamra": 2400, "Sagar Sandheads": 2500, "Haldia": 2530},
    "Taboneo":    {"Paradip": 2200, "Visakhapatnam": 2050, "Gangavaram": 2030, "Gopalpur": 2120, "Dhamra": 2250, "Sagar Sandheads": 2350, "Haldia": 2380},
}

DEFAULT_SERVICE_SPEED_KNOTS = 12.5  # typical laden bulk-carrier service speed


def get_distance_nm(origin: str, destination: str):
    """Symmetric lookup — works origin->destination or destination->origin
    (used for both the outbound voyage and idle-vessel ballast legs)."""
    if origin in APPROX_DISTANCE_NM and destination in APPROX_DISTANCE_NM[origin]:
        return APPROX_DISTANCE_NM[origin][destination]
    if destination in APPROX_DISTANCE_NM and origin in APPROX_DISTANCE_NM[destination]:
        return APPROX_DISTANCE_NM[destination][origin]
    return None


def estimate_transit_days(origin: str, destination: str, speed_knots: float = DEFAULT_SERVICE_SPEED_KNOTS,
                           distance_km_override: float | None = None):
    """Rough sea-transit time. Prefers a user-supplied distance_km (converted
    to nautical miles) when given — that's a real, request-specific input
    the static origin/destination table can't know about (actual routing,
    canal transit, weather diversions). Falls back to the indicative
    APPROX_DISTANCE_NM table when no distance was supplied."""
    if distance_km_override is not None and distance_km_override > 0:
        nm = distance_km_override / 1.852
    else:
        nm = get_distance_nm(origin, destination)
    if nm is None:
        return None
    return round(nm / (speed_knots * 24), 1)


def port_turnaround_days(port_name: str, cargo_weight_tons: float, delay_days: float = 0.0) -> float:
    """Rough discharge/load turnaround estimate used for idle-time planning.
    delay_days (weather, congestion, documentation, etc., as flagged on the
    request) is added directly — it's additional real time the vessel will
    be occupied at or waiting on this port, not a separate consideration."""
    info = get_port(port_name)
    rate = info["cargo_handling_rate_tpd"] if info and info.get("cargo_handling_rate_tpd") else 8000
    handling_days = cargo_weight_tons / rate
    total_days = handling_days + max(float(delay_days or 0), 0.0)
    return round(total_days, 2)


def stowage_factor(cargo_weight_tons: float, cargo_volume_cbm: float | None) -> float | None:
    """cbm per tonne implied by the request's cargo weight + volume. Not
    matched against any specific vessel's grain/bale cubic capacity (that
    data isn't in this project's vessel dataset) — this is a general
    dry-bulk sanity check against the well-known ~0.4-1.6 m3/t industry
    range, surfaced so the decision engine can flag when cubic capacity,
    not deadweight, is likely to be the real constraint."""
    if not cargo_volume_cbm or not cargo_weight_tons:
        return None
    return round(cargo_volume_cbm / cargo_weight_tons, 3)


def congestion_warning(origin: str, destination: str) -> str:
    """(d) Risk Mitigation — early warning built from static port-congestion
    ratings (swap for a live AIS/port-authority feed in production)."""
    notes = []
    for label, name in (("Load port", origin), ("Discharge port", destination)):
        info = get_port(name)
        if info and info.get("typical_congestion") in ("medium", "high"):
            notes.append(f"{label} {name}: {info['typical_congestion']} congestion risk — {info.get('notes', '')}")
    if not notes:
        return "No elevated port-congestion risk flagged for this route."
    return " | ".join(notes)

