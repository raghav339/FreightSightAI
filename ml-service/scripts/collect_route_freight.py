#!/usr/bin/env python3
"""Collect and validate public route-level freight observations for FreightSight.

This tool deliberately does NOT invent freight rates. It supports:
  1) normalization of manually verified CSV rows;
  2) candidate extraction from downloaded public PDF/HTML reports;
  3) merge of approved observations into the canonical production CSV;
  4) validation/provenance checks.

Recommended workflow:
  python collect_route_freight.py init
  python collect_route_freight.py extract --input sources/raw/report.pdf --source-id dry_freight_wire_2026_03_06
  # review sources/review_candidates.csv and set verification_status=verified
  python collect_route_freight.py merge --input sources/review_candidates.csv
  python collect_route_freight.py validate

For PDF extraction, install optional dependency: pypdf.
"""
from __future__ import annotations
import argparse, csv, hashlib, html as html_lib, json, re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]  # ml-service
DATA_DIR = ROOT / "data" / "production"
DEFAULT_OUT = DATA_DIR / "route_freight_observations.csv"
SOURCE_MANIFEST = DATA_DIR / "route_freight_sources.json"
REVIEW_DIR = ROOT / "sources"
REVIEW_FILE = REVIEW_DIR / "review_candidates.csv"
SCHEMA_VERSION = "1.0"

COLUMNS = [
    "observation_id","observation_date","origin","destination","route_id",
    "commodity","vessel_class","cargo_size_t","freight_usd_per_t",
    "rate_type","observation_type","source_name","source_url","source_reference",
    "publication_date","retrieval_date","coverage_start","coverage_end",
    "source_file","verification_status","verification_notes","confidence","schema_version"
]

ROUTES = [
    ("South Kalimantan","Paradip","ID_SK_PARADIP_PMAX_75","thermal_coal","Panamax",75000),
    ("South Kalimantan","Paradip","ID_SK_PARADIP_SUPRA_55","thermal_coal","Ultramax",55000),
    ("South Kalimantan","Krishnapatnam","ID_SK_KRISHNA_PMAX_75","thermal_coal","Panamax",75000),
    ("Richards Bay","Paradip","ZA_RB_PARADIP_PMAX_75","thermal_coal","Panamax",75000),
    ("Richards Bay","Paradip","ZA_RB_PARADIP_SUPRA_55","thermal_coal","Ultramax",55000),
    ("Richards Bay","Krishnapatnam","ZA_RB_KRISHNA_PMAX_75","thermal_coal","Panamax",75000),
    ("Gladstone","Dhamra","AU_GLADSTONE_DHAMRA_CAPE_150","thermal_coal","Capesize",150000),
    ("Gladstone","Dhamra","AU_GLADSTONE_DHAMRA_PMAX_80","thermal_coal","Panamax",80000),
    ("Hampton Roads","Paradip","US_HR_PARADIP_PMAX_70","coal","Panamax",70000),
    ("Taman","Paradip","RU_TAMAN_PARADIP_SUPRA_50","coal","Supramax",50000),
    ("Vostochny","Paradip","RU_VOSTOCHNY_PARADIP_PMAX_75","coal","Panamax",75000),
]
ROUTE_MAP = {}
for _o,_d,_rid,_comm,_vt,_cap in ROUTES:
    ROUTE_MAP.setdefault((_o.lower(),_d.lower()), []).append((_rid,_comm,_vt,_cap))

ALIASES = {
    "South Kalimantan":["south kalimantan","s kalimantan","kalimantan"],
    "Richards Bay":["richards bay","rbct"],
    "Gladstone":["gladstone"],
    "Hampton Roads":["hampton roads","usec","u.s. east coast"],
    "Taman":["taman coal terminal","taman"],
    "Vostochny":["vostochny","vostochnyy"],
    "Paradip":["paradip"],
    "Krishnapatnam":["krishnapatnam"],
    "Dhamra":["dhamra"],
}

RATE_RE = re.compile(r"(?P<currency>\$|USD)\s*(?P<value>\d+(?:\.\d+)?)\s*/?\s*(?P<unit>mt|t|day)\b", re.I)
DATE_RE = re.compile(r"\b(20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]20\d{2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b", re.I)
CARGO_RE = re.compile(r"(?P<value>\d{2,6}(?:,\d{3})?)\s*(?:mt|t|tonnes|tons)\b", re.I)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def iso_date(value: str|None) -> str:
    if not value: return ""
    import datetime as dt
    value=value.strip()
    for fmt in ("%Y-%m-%d","%Y/%m/%d","%d/%m/%Y","%m/%d/%Y","%d-%m-%Y","%b %d %Y","%B %d %Y","%b %d, %Y","%B %d, %Y"):
        try: return dt.datetime.strptime(value, fmt).date().isoformat()
        except ValueError: pass
    return ""


def canon_endpoint(text: str, choices: Iterable[str]) -> str:
    s=text.lower().strip()
    for name in choices:
        if any(a in s for a in ALIASES.get(name,[name.lower()])):
            return name
    return ""


def route_from_text(text: str):
    low=html_lib.unescape(re.sub(r"\s+"," ",text.lower()))
    matches=[]
    for (o_key,d_key),variants in ROUTE_MAP.items():
        o_name = next((n for n in ALIASES if n.lower() == o_key), o_key.title())
        d_name = next((n for n in ALIASES if n.lower() == d_key), d_key.title())
        if any(a in low for a in ALIASES.get(o_name, [o_key])) and any(a in low for a in ALIASES.get(d_name, [d_key])):
            for v in variants:
                matches.append((o_name,d_name,*v))
    # Same port pair may legitimately have multiple vessel/cargo assessments.
    # Do not guess between them from the text alone.
    if len(matches) == 1:
        return matches[0]
    if matches:
        return (matches[0][0], matches[0][1], "", "", "", "")
    return None


def extract_text(path: Path) -> str:
    suffix=path.suffix.lower()
    if suffix==".pdf":
        try:
            from pypdf import PdfReader
        except Exception as exc:
            raise SystemExit("PDF extraction requires pypdf. Install with: pip install pypdf") from exc
        reader=PdfReader(str(path))
        return "\n".join((p.extract_text() or "") for p in reader.pages)
    if suffix in {".html",".htm",".txt",".csv"}:
        return path.read_text(encoding="utf-8", errors="ignore")
    raise SystemExit(f"Unsupported source format: {suffix}")


def candidate_rows(text: str, source_id: str, source_file: str) -> list[dict]:
    lines=[re.sub(r"\s+"," ",html_lib.unescape(x)).strip() for x in text.splitlines()]
    out=[]
    for i,line in enumerate(lines):
        rate=RATE_RE.search(line)
        if not rate: continue
        window=" ".join(lines[max(0,i-2):min(len(lines),i+3)])
        route=route_from_text(window)
        if not route: continue
        o,d,rid,comm,vt,cap=route
        cargo=CARGO_RE.search(window)
        dtm=DATE_RE.search(window)
        unit=(rate.group("unit") or "").lower()
        rate_type="freight_usd_per_t" if unit in {"mt","t"} else "tce_usd_per_day"
        freight=float(rate.group("value")) if rate_type=="freight_usd_per_t" else ""
        ref=source_id+f":line-{i+1}"
        out.append({
            "observation_id":"",
            "observation_date":iso_date(dtm.group(1)) if dtm else "",
            "origin":o,"destination":d,"route_id":rid,
            "commodity":comm,"vessel_class":vt,
            "cargo_size_t":float(cargo.group("value").replace(",","")) if cargo else cap,
            "freight_usd_per_t":freight,
            "rate_type":rate_type,
            "observation_type":"assessment_candidate",
            "source_name":source_id,
            "source_url":"",
            "source_reference":ref,
            "publication_date":"",
            "retrieval_date":date.today().isoformat(),
            "coverage_start":"","coverage_end":"",
            "source_file":source_file,
            "verification_status":"candidate",
            "verification_notes":window,
            "confidence":"low",
            "schema_version":SCHEMA_VERSION,
        })
    return out


def deterministic_id(row: dict) -> str:
    raw="|".join(str(row.get(c,"")) for c in ["observation_date","route_id","cargo_size_t","freight_usd_per_t","rate_type","observation_type","source_reference"])
    return "rfo_"+hashlib.sha1(raw.encode()).hexdigest()[:12]


def write_csv(path: Path, rows: list[dict], append: bool=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode="a" if append and path.exists() else "w"
    with path.open(mode, newline="", encoding="utf-8") as f:
        w=csv.DictWriter(f, fieldnames=COLUMNS)
        if mode=="w": w.writeheader()
        for row in rows:
            row={k:row.get(k,"") for k in COLUMNS}
            row["observation_id"]=row["observation_id"] or deterministic_id(row)
            w.writerow(row)


def normalize_row(r: dict) -> dict:
    x={k:(r.get(k) or "").strip() if isinstance(r.get(k),str) else r.get(k,"" ) for k in COLUMNS}
    x["observation_date"]=iso_date(str(x["observation_date"]))
    x["publication_date"]=iso_date(str(x["publication_date"]))
    x["retrieval_date"]=iso_date(str(x["retrieval_date"])) or date.today().isoformat()
    for k in ("cargo_size_t","freight_usd_per_t"):
        if x[k] != "":
            x[k]=float(str(x[k]).replace(",",""))
    if x["origin"] and x["destination"]:
        key=(str(x["origin"]).lower(),str(x["destination"]).lower())
        variants=ROUTE_MAP.get(key,[])
        if len(variants)==1 and not x["route_id"]:
            rid,comm,vt,cap=variants[0]; x["route_id"]=rid
            if not x["commodity"]: x["commodity"]=comm
            if not x["vessel_class"]: x["vessel_class"]=vt
            if not x["cargo_size_t"]: x["cargo_size_t"]=cap
    x["schema_version"]=SCHEMA_VERSION
    return x


def validate_rows(path: Path) -> tuple[int,int,list[str]]:
    errors=[]; total=0; valid=0
    if not path.exists(): return 0,0,[f"Missing {path}"]
    with path.open(newline="",encoding="utf-8") as f:
        reader=csv.DictReader(f)
        missing=[c for c in COLUMNS if c not in (reader.fieldnames or [])]
        if missing: return 0,0,["Missing columns: "+", ".join(missing)]
        seen=set()
        for n,r in enumerate(reader,2):
            total+=1
            errs=[]
            if not r["route_id"]: errs.append("route_id missing")
            if not r["source_url"]: errs.append("source_url missing")
            if not r["source_reference"]: errs.append("source_reference missing")
            if r["verification_status"]=="verified" and not r["observation_date"]: errs.append("verified row requires observation_date")
            if r["rate_type"]=="freight_usd_per_t" and r["freight_usd_per_t"]=="": errs.append("freight rate missing")
            if r["rate_type"]=="tce_usd_per_day" and r["freight_usd_per_t"] not in {"","None"}: errs.append("TCE row must not fill freight_usd_per_t")
            try:
                if r["freight_usd_per_t"] != "" and float(r["freight_usd_per_t"]) <= 0: errs.append("freight must be > 0")
            except ValueError: errs.append("freight_usd_per_t not numeric")
            if r["verification_status"] not in {"candidate","verified","rejected"}: errs.append("invalid verification_status")
            if r["confidence"] not in {"low","medium","high",""}: errs.append("invalid confidence")
            key=r["observation_id"]
            if key in seen: errs.append("duplicate observation_id")
            if key: seen.add(key)
            if errs: errors.append(f"row {n}: "+"; ".join(errs))
            else: valid+=1
    return total,valid,errors


def cmd_init(args):
    if not DEFAULT_OUT.exists(): write_csv(DEFAULT_OUT,[])
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    if not REVIEW_FILE.exists(): write_csv(REVIEW_FILE,[])
    print(f"Initialized: {DEFAULT_OUT}")
    print(f"Review file: {REVIEW_FILE}")


def cmd_extract(args):
    p=Path(args.input)
    text=extract_text(p)
    rows=candidate_rows(text,args.source_id,p.name)
    for r in rows:
        r["source_name"]=args.source_name or args.source_id
        r["source_url"]=args.source_url or ""
        r["publication_date"]=iso_date(args.publication_date) if args.publication_date else ""
        r=normalize_row(r)
    write_csv(REVIEW_FILE, rows, append=True)
    print(f"Extracted {len(rows)} candidates into {REVIEW_FILE}")


def cmd_merge(args):
    inp=Path(args.input); out=Path(args.output) if args.output else DEFAULT_OUT
    if not inp.exists(): raise SystemExit(f"Missing {inp}")
    rows=[]
    with inp.open(newline="",encoding="utf-8") as f:
        for r in csv.DictReader(f):
            r=normalize_row(r)
            if args.approved_only and r.get("verification_status")!="verified": continue
            rows.append(r)
    existing=[]
    if out.exists():
        with out.open(newline="",encoding="utf-8") as f: existing=list(csv.DictReader(f))
    ids={r.get("observation_id") for r in existing}
    new=[r for r in rows if r.get("observation_id") not in ids]
    write_csv(out,new,append=True)
    print(f"Added {len(new)} rows to {out}; skipped {len(rows)-len(new)} duplicates")


def cmd_validate(args):
    total,valid,errors=validate_rows(Path(args.input) if args.input else DEFAULT_OUT)
    print(json.dumps({"rows":total,"valid_rows":valid,"invalid_rows":len(errors),"status":"PASS" if not errors else "FAIL","errors":errors[:50]},indent=2))
    raise SystemExit(0 if not errors else 2)


def main():
    ap=argparse.ArgumentParser()
    sp=ap.add_subparsers(dest="cmd",required=True)
    p=sp.add_parser("init"); p.set_defaults(func=cmd_init)
    p=sp.add_parser("extract"); p.add_argument("--input",required=True); p.add_argument("--source-id",required=True); p.add_argument("--source-name"); p.add_argument("--source-url"); p.add_argument("--publication-date"); p.set_defaults(func=cmd_extract)
    p=sp.add_parser("merge"); p.add_argument("--input",required=True); p.add_argument("--output"); p.add_argument("--approved-only",action="store_true"); p.set_defaults(func=cmd_merge)
    p=sp.add_parser("validate"); p.add_argument("--input"); p.set_defaults(func=cmd_validate)
    args=ap.parse_args(); args.func(args)

if __name__=="__main__": main()
