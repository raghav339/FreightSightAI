import { useEffect, useState } from "react";
import api from "../api/client.js";
import { Button } from "../components/ui/button.jsx";

const ORIGINS=["Newcastle","Hay Point","Gladstone","Norfolk","Baltimore","Nacala","Beira","Vostochny","Murmansk","Samarinda","Taboneo"];
const DESTINATIONS=["Paradip","Visakhapatnam","Gangavaram","Gopalpur","Dhamra","Sagar Sandheads","Haldia","Chennai","Kamarajar","Tuticorin"];

export default function COAOptimizer(){
  const [form,setForm]=useState({
    commodity:"Coal",origin_port:"Newcastle",destination_port:"Paradip",
    shipment_date:new Date().toISOString().slice(0,10),cargo_weight_tons:"",
    total_program_tons:300000,contract_duration_months:6,current_spot_rate_usd_per_ton:""
  });
  const [result,setResult]=useState(null); const [loading,setLoading]=useState(false); const [error,setError]=useState("");

  const set=(k,v)=>setForm(x=>({...x,[k]:v}));
  async function run(e){
    e.preventDefault(); setLoading(true); setError(""); setResult(null);
    try{
      const payload={...form,
        total_program_tons:Number(form.total_program_tons),
        contract_duration_months:Number(form.contract_duration_months)};
      // cargo_weight_tons is optional: when left blank, the optimizer picks
      // its own per-voyage lift size per vessel class from total_program_tons.
      // When set, it's used as the fixed intended lift size that drives the
      // voyage count directly.
      if(form.cargo_weight_tons!=="" && form.cargo_weight_tons!=null) payload.cargo_weight_tons=Number(form.cargo_weight_tons);
      else delete payload.cargo_weight_tons;
      if(form.current_spot_rate_usd_per_ton) payload.current_spot_rate_usd_per_ton=Number(form.current_spot_rate_usd_per_ton);
      else delete payload.current_spot_rate_usd_per_ton;
      const {data}=await api.post("/coa-optimize",payload,{timeout:60000}); setResult(data);
    }catch(err){setError(err.response?.data?.error||err.message||"Optimization failed.");}
    finally{setLoading(false);}
  }
  return <section className="flex flex-col gap-7">
    <header>
      <span className="font-mono text-xs uppercase tracking-[0.2em] text-signal/80">COA / MULTI-VOYAGE</span>
      <h1 className="mt-1 font-display text-3xl font-semibold text-paper-50">{"COA Cost Optimizer"}</h1>
      <p className="mt-2 max-w-3xl text-sm text-slate-400">Compare a multi-voyage COA strategy against today's spot benchmark while enforcing vessel feasibility at both ends of the route.</p>
    </header>
    <form onSubmit={run} className="grid gap-4 rounded-2xl border border-hull-600 bg-hull-900/60 p-5 md:grid-cols-2 lg:grid-cols-3">
      {[
        ["Origin","origin_port",ORIGINS],["Destination","destination_port",DESTINATIONS]
      ].map(([label,key,opts])=><label key={key} className="text-sm text-slate-300">{label}<select value={form[key]} onChange={e=>set(key,e.target.value)} className="mt-1 w-full rounded-lg border border-hull-600 bg-hull-800 px-3 py-2">{opts.map(x=><option key={x}>{x}</option>)}</select></label>)}
      <label className="text-sm text-slate-300">Shipment date<input type="date" value={form.shipment_date} onChange={e=>set("shipment_date",e.target.value)} className="mt-1 w-full rounded-lg border border-hull-600 bg-hull-800 px-3 py-2"/></label>
      <label className="text-sm text-slate-300">Cargo / voyage (t)<span className="ml-1 text-slate-500">optional</span><input type="number" min="1" placeholder="Auto-sized per vessel class" value={form.cargo_weight_tons} onChange={e=>set("cargo_weight_tons",e.target.value)} className="mt-1 w-full rounded-lg border border-hull-600 bg-hull-800 px-3 py-2"/></label>
      <label className="text-sm text-slate-300">Total COA tons<input type="number" min="1" value={form.total_program_tons} onChange={e=>set("total_program_tons",e.target.value)} className="mt-1 w-full rounded-lg border border-hull-600 bg-hull-800 px-3 py-2"/></label>
      <label className="text-sm text-slate-300">Contract months<input type="number" min="1" max="36" value={form.contract_duration_months} onChange={e=>set("contract_duration_months",e.target.value)} className="mt-1 w-full rounded-lg border border-hull-600 bg-hull-800 px-3 py-2"/></label>
      <label className="text-sm text-slate-300">Current spot rate ($/t, optional)<input type="number" min="0.01" step="0.01" value={form.current_spot_rate_usd_per_ton} onChange={e=>set("current_spot_rate_usd_per_ton",e.target.value)} placeholder="Required for $ savings" className="mt-1 w-full rounded-lg border border-hull-600 bg-hull-800 px-3 py-2"/></label>
      <div className="flex items-end"><Button disabled={loading} type="submit">{loading?"Optimizing…":"Optimize COA"}</Button></div>
    </form>
    {error&&(()=>{
      const NO_VESSEL_PREFIXES=[
        "No vessel class is feasible at both origin and destination ports for the COA program.",
        "No vessel class can carry the requested cargo/voyage at both origin and destination ports.",
      ];
      const matchedPrefix=NO_VESSEL_PREFIXES.find(p=>error.startsWith(p));
      if(!matchedPrefix){
        return <div className="rounded-xl border border-port/30 bg-port/10 p-4 text-sm text-port">{error}</div>;
      }
      // Per-class reasons are appended after the summary sentence, separated
      // by " | ", each formatted as "VesselClass: reason".
      const detail=error.slice(matchedPrefix.length).trim();
      const reasons=detail?detail.split(" | ").map(part=>{
        const sep=part.indexOf(": ");
        return sep===-1?{vessel:null,reason:part}:{vessel:part.slice(0,sep),reason:part.slice(sep+2)};
      }):[];
      return (
        <div className="rounded-xl border border-port/30 bg-port/10 p-4">
          <div className="text-sm font-semibold text-port">{"No vessel is feasible for this route"}</div>
          <p className="mt-1 text-xs leading-relaxed text-port/90">
            {"Every vessel class was checked against the cargo weight and against both ports' physical limits (draft, beam, LOA), and none cleared all of them at both ends."}
          </p>
          {reasons.length>0 && (
            <ul className="mt-3 flex flex-col gap-1.5">
              {reasons.map((r,i)=>(
                <li key={i} className="text-xs leading-relaxed text-port/90">
                  {r.vessel && <span className="font-mono font-semibold text-port">{r.vessel}</span>}
                  {r.vessel && " — "}
                  {r.reason}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">{"Try a smaller cargo weight per voyage, a different origin/destination pair, or check the port infrastructure data for this route."}</p>
        </div>
      );
    })()}
    {result&&<div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-signal/20 bg-signal/5 p-5">
        <div className="text-xs uppercase tracking-widest text-slate-500">Recommended strategy</div>
        <div className="mt-1 text-2xl font-semibold text-paper-50">{result.best_strategy.vessel_type} · {result.best_strategy.voyages} voyages</div>
        <div className="mt-2 grid gap-3 text-sm text-slate-300 sm:grid-cols-2 lg:grid-cols-4">
          <span>Cargo/voyage: {result.best_strategy.average_parcel_tons.toLocaleString()} t{result.requested_cargo_weight_tons==null && " (auto-sized)"}</span>
          <span>Vessel capacity: {result.best_strategy.effective_cargo_tons_per_voyage.toLocaleString()} t</span>
          <span>Cycle: {result.best_strategy.estimated_cycle_days} days</span>
          <span>Schedule: {result.best_strategy.required_schedule_days} / {result.best_strategy.contract_duration_days} days</span>
          <span>{result.best_strategy.contract_rate_usd_per_ton!=null?`Indicative COA rate: $${result.best_strategy.contract_rate_usd_per_ton}/t`:"No spot calibration supplied"}</span>
        </div>
        <div className="mt-4 rounded-xl border border-hull-600/60 bg-hull-900/40 p-3 text-xs leading-relaxed text-slate-400">
          <div className="mb-1.5 text-slate-500">
            {result.requested_cargo_weight_tons!=null
              ? `Cargo/voyage was fixed at ${result.requested_cargo_weight_tons.toLocaleString()} t — voyage count is derived from that, and only vessel classes able to carry it are shown.`
              : "Cargo/voyage wasn't specified — each vessel class was sized to its own optimal parcel from the total program tonnage."}
          </div>          <span className={result.status === "optimized" ? "text-starboard font-semibold" : "text-amber-300 font-semibold"}>{result.status === "optimized" ? "Schedule feasible" : "Schedule infeasible"}</span> · {result.recommendation_note}
        </div>
        {result.current_spot_rate_usd_per_ton == null && (
          <div className="mt-3 text-xs text-slate-500">No current spot benchmark was supplied, so no dollar savings are claimed. Enter a broker/market benchmark to compare program cost against spot.</div>
        )}
        {result.estimated_savings_vs_spot_usd != null && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-starboard/20 bg-starboard/5 p-3"><div className="text-xs uppercase tracking-widest text-slate-500">Indicative savings vs spot</div><div className="mt-1 text-xl font-semibold text-paper-50">${result.estimated_savings_vs_spot_usd.toLocaleString()}</div></div>
            <div className="rounded-lg border border-hull-600/60 bg-hull-900/40 p-3"><div className="text-xs uppercase tracking-widest text-slate-500">Savings %</div><div className="mt-1 text-xl font-semibold text-paper-50">{result.estimated_savings_vs_spot_pct}%</div></div>
          </div>
        )}
      </div>
      <div className="overflow-x-auto rounded-2xl border border-hull-600"><table className="w-full text-sm"><thead><tr className="border-b border-hull-600 text-left text-slate-500"><th className="p-3">Vessel</th><th className="p-3">Voyages</th><th className="p-3">Parcel (t)</th><th className="p-3">Cycle days</th><th className="p-3">Indicative $/t</th><th className="p-3">Schedule</th><th className="p-3">Expected cost</th></tr></thead><tbody>{result.alternatives.map(x=><tr key={x.vessel_type} className="border-b border-hull-700/70 text-slate-300"><td className="p-3">{x.vessel_type}</td><td className="p-3">{x.voyages}</td><td className="p-3">{x.average_parcel_tons.toLocaleString()}</td><td className="p-3">{x.estimated_cycle_days}</td><td className="p-3">{x.contract_rate_usd_per_ton!=null?`$${x.contract_rate_usd_per_ton}`:"—"}</td><td className={`p-3 text-xs ${x.schedule_feasible?"text-starboard":"text-amber-300"}`}>{x.schedule_feasible?`${x.schedule_slack_days}d slack`:`+${Math.abs(x.schedule_slack_days)}d needed`}</td><td className="p-3">{x.expected_freight_cost_usd!=null?`$${x.expected_freight_cost_usd.toLocaleString()}`:"—"}</td></tr>)}</tbody></table></div>
      <p className="text-xs leading-5 text-slate-500">{result.methodology} {result.market_forecast.disclaimer}</p>
    </div>}
  </section>
}