"""Build compact route_monthly_features.csv from an IMF PortWatch CSV.

Usage:
python build_route_features.py --input /path/to/Daily_Port_Activity_Data_and_Trade_Estimates.csv --output /path/to/route_monthly_features.csv
"""
import argparse, math
from pathlib import Path
import numpy as np
import pandas as pd

ORIGINS={"Newcastle":["newcastle"],"Hay Point":["hay point"],"Gladstone":["gladstone"],
"Norfolk":["norfolk"],"Baltimore":["baltimore"],"Nacala":["nacala"],"Beira":["beira"],
"Vostochny":["vostochnyy","vostochny"],"Murmansk":["murmansk"],"Samarinda":["samarinda"],
"Taboneo":["taboneo"]}
DESTS={"Paradip":["paradip"],"Visakhapatnam":["visakhapatnam"],"Gangavaram":["gangavaram"],
"Gopalpur":["gopalpur"],"Dhamra":["dhamra"],"Sagar Sandheads":["sagar","sandheads"],
"Haldia":["haldia"],"Chennai":["chennai"],"Kamarajar":["kamarajar","ennore"],"Tuticorin":["tuticorin"]}
COORDS={"Newcastle":(-32.9283,151.7817),"Hay Point":(-21.2833,149.2833),"Gladstone":(-23.8489,151.25),
"Norfolk":(36.8508,-76.2859),"Baltimore":(39.2904,-76.6122),"Nacala":(-14.5628,40.6728),
"Beira":(-19.8317,34.8389),"Vostochny":(42.7333,133.0833),"Murmansk":(68.9585,33.0827),
"Samarinda":(-0.5021,117.1536),"Taboneo":(-3.6167,114.5333),"Paradip":(20.2667,86.7),
"Visakhapatnam":(17.6868,83.2185),"Gangavaram":(17.63,83.23),"Gopalpur":(19.26,84.9),
"Dhamra":(20.78,86.92),"Sagar Sandheads":(21.2,88.0),"Haldia":(22.03,88.06),
"Chennai":(13.0827,80.2707),"Kamarajar":(13.25,80.34),"Tuticorin":(8.7642,78.1348)}
def hav(a,b):
    lat1,lon1=np.radians(a); lat2,lon2=np.radians(b)
    h=np.sin((lat2-lat1)/2)**2+np.cos(lat1)*np.cos(lat2)*np.sin((lon2-lon1)/2)**2
    return 3440.065*2*np.arcsin(np.sqrt(h))
def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--input",required=True); ap.add_argument("--output",required=True); args=ap.parse_args()
    use=["date","portname","portcalls_dry_bulk","portcalls_cargo","portcalls","import_dry_bulk","export_dry_bulk","import_cargo","export_cargo"]
    df=pd.read_csv(args.input,usecols=use); df["date"]=pd.to_datetime(df.date,errors="coerce",utc=True)
    df["month"]=df.date.dt.tz_convert(None).dt.to_period("M").dt.to_timestamp()
    metrics=use[2:]
    pieces=[]
    for canon,aliases in {**ORIGINS,**DESTS}.items():
        mask=pd.Series(False,index=df.index)
        for a in aliases: mask |= df.portname.astype(str).str.contains(a,case=False,regex=False,na=False)
        x=df.loc[mask].copy()
        if x.empty: continue
        x["port"]=canon
        pieces.append(x.groupby(["month","port"],as_index=False)[metrics].sum())
    activity=pd.concat(pieces,ignore_index=True).set_index(["month","port"])
    bdry=pd.read_csv(Path(args.input).parent/"bdry_freight_proxy_cleaned.csv") if (Path(args.input).parent/"bdry_freight_proxy_cleaned.csv").exists() else None
    if bdry is None: raise SystemExit("Put bdry_freight_proxy_cleaned.csv beside the PortWatch input or adapt the script.")
    bdry["date"]=pd.to_datetime(bdry.date); bdry["month"]=bdry.date.dt.to_period("M").dt.to_timestamp()
    b=bdry.groupby("month",as_index=False).bdry_close.mean()
    rows=[]
    for _,br in b[b.month>=pd.Timestamp("2019-01-01")].iterrows():
        for o in ORIGINS:
            for d in DESTS:
                r={"month":br.month,"origin":o,"destination":d,"bdry_proxy":br.bdry_close,"distance_nm":hav(COORDS[o],COORDS[d])}
                for prefix,p in [("origin",o),("destination",d)]:
                    if (br.month,p) in activity.index:
                        z=activity.loc[(br.month,p)]; cov=1
                    else:
                        z=None; cov=0
                    for m in metrics: r[prefix+"_"+m]=float(z[m]) if z is not None else 0.0
                    r[prefix+"_ais_coverage"]=cov
                rows.append(r)
    pd.DataFrame(rows).to_csv(args.output,index=False)
if __name__=="__main__": main()
