// backend/src/utils/decisionBrief.js
//
// Pure logic for the Decision Brief: takes a saved forecast, an optional
// what-if scenario, and the decision-simulator comparisons (multi-voyage COA
// and loading-port comparison) and turns them into ONE structured
// recommendation — which option to take, what it saves, and why.
//
// No I/O, no PDF, no clock: routes/decisionBrief.js does the fetching and
// utils/decisionBriefPdf.js does the rendering, so this file can be tested
// directly with plain objects.
//
// Nothing in here is generated text from a language model. Every sentence in
// `reasons` / `caveats` is assembled from numbers the ML service returned, so
// the PDF can never say something the model output does not support.
"use strict";

const L = require("./pdfCopy");

// An alternative must beat the current lane by at least this much before the
// brief recommends changing anything. Below it, the saving is inside the
// noise of a synthetic-rate forecast and not worth the switching effort.
const MIN_MATERIAL_SAVING_PCT = 2;

// A saving bigger than this between comparable lanes deserves a "verify with
// broker quotes" warning rather than a confident headline.
const LARGE_SAVING_PCT = 25;

// ---------------------------------------------------------------- helpers ---

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sameName(a, b) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

// Mirrors ml-service's commodity normalisation ("Bulk Minerals & Ores" and
// "Bulk Minerals And Ores" are the same commodity there).
function normCommodity(s) {
  return String(s ?? "").trim().toLowerCase().replace(/ /g, "_").replace(/&/g, "and");
}

function fmtTons(n) {
  return Math.round(Number(n)).toLocaleString("en-US");
}

// $1,234,568 — whole dollars, for tables.
function formatUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "-";
  const v = Math.round(Number(n));
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US")}`;
}

// $1.04M / $207K / $850 — for headlines and prose.
function formatUsdCompact(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "-";
  const v = Number(n);
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3).toLocaleString("en-US")}K`;
  return `${sign}$${Math.round(a)}`;
}

function usdPerTon(n) {
  return n === null || n === undefined ? "-" : `$${Number(n).toFixed(2)}/t`;
}

function pct(n, digits = 1) {
  return `${Number(n).toFixed(digits)}%`;
}

// `feasible` (from compare-origins) now reflects full both-port vessel
// feasibility, matching `vessel_status !== "NO_FEASIBLE_VESSEL"`. The
// vessel_status check is kept as well because it also guards against an
// older ml-service response that omits vessel_status entirely — such a
// row can't be confirmed, so it is not recommendable either.
function isBothPortFeasible(row) {
  return (
    row.feasible === true &&
    typeof row.vessel_status === "string" &&
    row.vessel_status !== "NO_FEASIBLE_VESSEL"
  );
}

// ---------------------------------------------------------------- options ---

function buildStayOption({ forecast, scenario, whatif, compareRows, basisTons }) {
  const status = scenario.changed && whatif ? whatif.vessel_status : forecast.vessel_status;
  const infeasible = status === "NO_FEASIBLE_VESSEL";
  const rate = num(forecast.rate_usd_per_ton);
  const baseRow = compareRows.find((r) => sameName(r.origin_port, forecast.origin_port));

  return {
    key: "stay",
    title: "Stay on the current lane",
    subtitle: `${forecast.origin_port} to ${forecast.destination_port}`,
    available: rate !== null,
    eligible: rate !== null && !infeasible,
    reason: infeasible
      ? (scenario.changed && whatif?.vessel_rejection_reason) ||
        forecast.vessel_rejection_reason ||
        "No vessel class fits both ports for this cargo."
      : rate === null
        ? "No rate forecast available."
        : null,
    rate_usd_per_ton: rate,
    cost_usd: rate !== null ? rate * basisTons : null,
    delta_usd: 0,
    delta_pct: 0,
    voyage_days: num(baseRow?.total_voyage_days),
    risk_label: forecast.risk_label || null,
    risk_note: null,
    vessel: (scenario.changed && whatif?.recommended_vessel_type) || forecast.recommended_vessel_type || null,
    notes: [],
    recommended: false,
  };
}

function buildSwitchOption({ forecast, compare, basisTons }) {
  const base = {
    key: "switch",
    title: "Switch loading port",
    subtitle: null,
    available: false,
    eligible: false,
    reason: null,
    rate_usd_per_ton: null,
    cost_usd: null,
    delta_usd: null,
    delta_pct: null,
    voyage_days: null,
    risk_label: null,
    risk_note: null,
    vessel: null,
    notes: [],
    recommended: false,
    // Not shown in the table; used to write the "why" section.
    runner_up: null,
    excluded_cheaper: [],
  };

  if (compare.status !== "ok") {
    return { ...base, reason: `Origin comparison unavailable: ${compare.reason}` };
  }

  const rows = (compare.data?.results || []).filter((r) => !sameName(r.origin_port, forecast.origin_port));
  const priced = rows
    .map((r) => ({ row: r, rate: num(r.predicted_freight_rate_usd_per_ton) }))
    .filter((x) => x.rate !== null)
    .map((x) => ({ ...x, cost: x.rate * basisTons }));

  const ok = priced.filter((x) => isBothPortFeasible(x.row));
  const byCost = (a, b) =>
    a.cost - b.cost ||
    (num(a.row.total_voyage_days) ?? Infinity) - (num(b.row.total_voyage_days) ?? Infinity) ||
    (num(a.row.rank) ?? Infinity) - (num(b.row.rank) ?? Infinity);
  ok.sort(byCost);

  const stayCost = num(forecast.rate_usd_per_ton) !== null ? num(forecast.rate_usd_per_ton) * basisTons : null;
  const excludedCheaper = priced
    .filter((x) => !isBothPortFeasible(x.row) && stayCost !== null && x.cost < stayCost)
    .map((x) => x.row.origin_port);

  if (!ok.length) {
    return {
      ...base,
      available: true,
      excluded_cheaper: excludedCheaper,
      reason:
        "No alternative loading port has a vessel that fits at both the load and discharge port." +
        (excludedCheaper.length
          ? ` Cheaper origins excluded for vessel fit: ${excludedCheaper.join(", ")}.`
          : ""),
    };
  }

  const best = ok[0].row;
  const notes = [];
  if (best.origin_port_congestion) notes.push(`Typical load-port congestion: ${best.origin_port_congestion}.`);
  const ais = best.ais_congestion;
  if (ais && ais.available && ais.unique_vessels != null) {
    notes.push(`Live AIS (24h): ${ais.unique_vessels} vessels near the port.`);
  }

  return {
    ...base,
    subtitle: `${best.origin_port}${best.origin_country ? `, ${best.origin_country}` : ""}`,
    origin_port: best.origin_port,
    available: true,
    eligible: true,
    rate_usd_per_ton: ok[0].rate,
    cost_usd: ok[0].cost,
    voyage_days: num(best.total_voyage_days),
    risk_label: best.risk_label || null,
    vessel: best.recommended_vessel_type || null,
    notes,
    runner_up: ok[1]
      ? { origin_port: ok[1].row.origin_port, rate_usd_per_ton: ok[1].rate, cost_usd: ok[1].cost }
      : null,
    excluded_cheaper: excludedCheaper,
  };
}

function buildCoaOption({ forecast, coa, basisTons, duration }) {
  const base = {
    key: "coa",
    title: "Multi-voyage contract (COA)",
    subtitle: null,
    available: false,
    eligible: false,
    reason: null,
    rate_usd_per_ton: null,
    cost_usd: null,
    delta_usd: null,
    delta_pct: null,
    voyage_days: null,
    risk_label: null,
    risk_note: null,
    vessel: null,
    notes: [],
    recommended: false,
    plan: null,
  };

  if (coa.status !== "ok") {
    return { ...base, reason: coa.reason };
  }

  const data = coa.data || {};
  const best = data.best_strategy || {};
  const priced = data.market_forecast?.commodity;

  // Defence against a mismatched comparison: if the optimizer priced a
  // different commodity than the one being forecast, its cost is not
  // comparable with the other options and must not drive a recommendation.
  if (priced && normCommodity(priced) !== normCommodity(forecast.commodity)) {
    return {
      ...base,
      reason: `Excluded: the COA optimizer priced ${priced} rates, not ${forecast.commodity}.`,
    };
  }

  const cost = num(best.expected_freight_cost_usd);
  const scheduleOk = data.status === "optimized" && best.schedule_feasible !== false;
  const months = num(data.contract_duration_months) ?? duration;
  const risk = num(best.risk_buffer_pct);

  const notes = [];
  const total = num(data.total_program_tons);
  if (total !== null && Math.abs(total - basisTons) > 1) {
    notes.push(`Priced on ${fmtTons(total)} t, not ${fmtTons(basisTons)} t.`);
  }

  let reason = null;
  if (!scheduleOk) {
    reason = best.schedule_note || data.recommendation_note || "The program does not fit the contract window.";
  } else if (cost === null) {
    reason = "No cost estimate available for this program.";
  }

  return {
    ...base,
    subtitle: best.vessel_type
      ? `${best.vessel_type}, ${best.voyages} voyage${best.voyages === 1 ? "" : "s"} over ${months} mo`
      : null,
    available: true,
    eligible: reason === null,
    reason,
    rate_usd_per_ton: num(best.contract_rate_usd_per_ton),
    cost_usd: cost,
    voyage_days: num(best.estimated_cycle_days),
    risk_note: risk !== null && risk > 0 ? `+${risk}% allowance` : risk === 0 ? "no allowance" : null,
    vessel: best.vessel_type || null,
    notes,
    plan: {
      voyages: num(best.voyages),
      average_parcel_tons: num(best.average_parcel_tons),
      cycle_days: num(best.estimated_cycle_days),
      slack_days: num(best.schedule_slack_days),
      window_months: months,
      risk_buffer_pct: risk,
    },
  };
}

// ---------------------------------------------------------- recommendation ---

function chooseRecommendation(stay, sw, coa) {
  const eligible = [stay, sw, coa].filter((o) => o.eligible && o.cost_usd !== null);
  if (!eligible.length) return { kind: "none", option: null };

  // Least-change wins ties: stay, then switch, then COA.
  const order = { stay: 0, switch: 1, coa: 2 };
  eligible.sort((a, b) => a.cost_usd - b.cost_usd || order[a.key] - order[b.key]);
  const cheapest = eligible[0];

  if (stay.eligible && cheapest.key !== "stay") {
    const savingPct = ((stay.cost_usd - cheapest.cost_usd) / stay.cost_usd) * 100;
    if (savingPct < MIN_MATERIAL_SAVING_PCT) return { kind: "stay", option: stay, belowThreshold: cheapest };
  }
  const kind = { stay: "stay", switch: "switch_origin", coa: "coa" }[cheapest.key];
  return { kind, option: cheapest };
}

// ---------------------------------------------------------------- narrative ---

function describeReasons({ kind, stay, sw, coa, forecast, basisTons }) {
  const reasons = [];
  const dest = forecast.destination_port;
  const tons = fmtTons(basisTons);
  const others = (opt) => [stay, sw, coa].filter((o) => o.key !== opt.key);

  if (kind === "switch_origin") {
    const alt = sw.origin_port;
    if (stay.eligible) {
      reasons.push(
        `Loading at ${alt} is forecast at ${usdPerTon(sw.rate_usd_per_ton)} against ${usdPerTon(stay.rate_usd_per_ton)} ` +
          `at ${forecast.origin_port}: ${usdPerTon(stay.rate_usd_per_ton - sw.rate_usd_per_ton)} lower across ${tons} t.`
      );
    } else {
      reasons.push(
        `No vessel fits both ports on the current lane, so it cannot be chartered as planned. ` +
          `${alt} is the cheapest origin that can be, at ${usdPerTon(sw.rate_usd_per_ton)}.`
      );
    }
    if (sw.vessel) reasons.push(`A ${sw.vessel} fits at both ${alt} and ${dest}.`);
    if (sw.voyage_days !== null && stay.voyage_days !== null) {
      const diff = Math.round((sw.voyage_days - stay.voyage_days) * 10) / 10;
      reasons.push(
        diff === 0
          ? `Voyage time is the same as the current lane (${sw.voyage_days} days).`
          : `Voyage time is ${sw.voyage_days} days, ${Math.abs(diff)} days ${diff > 0 ? "longer" : "shorter"} than the current lane (${stay.voyage_days}).`
      );
    }
    if (sw.runner_up) {
      reasons.push(
        `It is the cheapest of the vessel-feasible origins; the next best is ${sw.runner_up.origin_port} at ` +
          `${usdPerTon(sw.runner_up.rate_usd_per_ton)} (${formatUsdCompact(sw.runner_up.cost_usd - sw.cost_usd)} more).`
      );
    }
    if (coa.eligible) {
      reasons.push(
        `A multi-voyage contract on the current lane would cost ${formatUsdCompact(coa.cost_usd)}, ` +
          `${formatUsdCompact(coa.cost_usd - sw.cost_usd)} more than this option.`
      );
    }
  } else if (kind === "coa") {
    const p = coa.plan || {};
    if (stay.eligible) {
      reasons.push(
        `A ${coa.vessel} contract at ${usdPerTon(coa.rate_usd_per_ton)} comes to ${formatUsdCompact(coa.cost_usd)} for ${tons} t, ` +
          `against ${formatUsdCompact(stay.cost_usd)} to fix the same tonnage at the forecast spot rate.`
      );
    } else {
      reasons.push("No vessel fits both ports for a single spot cargo on the current lane, but this contract plan uses a vessel class that does.");
    }
    if (p.voyages) {
      reasons.push(
        `The plan is ${p.voyages} voyage${p.voyages === 1 ? "" : "s"} of about ${fmtTons(p.average_parcel_tons)} t; each round trip takes about ` +
          `${p.cycle_days} days, so the program finishes ${Math.round(p.slack_days)} days inside the ${p.window_months}-month window.`
      );
    }
    if (p.risk_buffer_pct > 0) {
      reasons.push(`The optimizer's rate already includes a ${p.risk_buffer_pct}% allowance for rate movement.`);
    }
    if (sw.eligible) {
      reasons.push(
        sw.cost_usd < stay.cost_usd
          ? `Switching loading port would save less: ${formatUsdCompact(coa.cost_usd - sw.cost_usd)} more than this contract.`
          : `Switching loading port is not cheaper on this lane.`
      );
    }
  } else if (kind === "stay") {
    if (stay.eligible) {
      const cheaper = others(stay)
        .filter((o) => o.eligible && o.cost_usd < stay.cost_usd)
        .sort((a, b) => a.cost_usd - b.cost_usd)[0];
      if (cheaper) {
        const p = ((stay.cost_usd - cheaper.cost_usd) / stay.cost_usd) * 100;
        reasons.push(
          `The best alternative (${cheaper.key === "switch" ? `loading at ${sw.origin_port}` : "a multi-voyage contract"}) is only ` +
            `${pct(p)} cheaper, under the ${MIN_MATERIAL_SAVING_PCT}% margin needed to justify changing plans.`
        );
      } else {
        reasons.push(`No alternative is cheaper than the current lane at ${usdPerTon(stay.rate_usd_per_ton)}.`);
      }
      reasons.push(`Estimated cost is ${formatUsd(stay.cost_usd)} for ${tons} t${stay.vessel ? ` using a ${stay.vessel}` : ""}.`);
      if (sw.available && !sw.eligible && sw.reason) reasons.push(sw.reason);
    }
  } else {
    // kind === "none"
    for (const o of [stay, sw, coa]) {
      if (o.reason) reasons.push(`${o.title}: ${o.reason}`);
    }
  }
  return reasons.slice(0, 6);
}

// Shown on page 1, next to the recommendation: things a reader must not miss.
function describeWarnings({ savingPct, options }) {
  const w = [];
  if (savingPct !== null && savingPct >= LARGE_SAVING_PCT) {
    w.push(
      `A saving of ${pct(savingPct, 0)} between comparable lanes is unusually large. Treat it as a prompt to obtain broker quotes, not as a fixture price.`
    );
  }
  // An option that could not be evaluated means the recommendation only
  // weighs what is shown; say so instead of implying a full comparison.
  for (const o of options) {
    if (!o.available && o.reason) w.push(`${o.reason} This recommendation weighs only the options shown.`);
  }
  return w;
}

// Shown on page 2: method notes and limits of the analysis.
function describeCaveats({ kind, sw, coa }) {
  const cav = [];
  if (kind === "switch_origin") {
    cav.push("Cargo availability, supplier terms and inland logistics to the alternative loading port are not modelled.");
  }
  if (coa.available) {
    cav.push(
      "The contract cost uses the average of the next three monthly forecasts plus the optimizer's allowance; the other options use the single forecast for the shipment month."
    );
  }
  cav.push("Market-risk labels are shown for context. Options are ranked on estimated cost only.");
  if (sw.excluded_cheaper?.length && sw.eligible) {
    cav.push(`Cheaper origins excluded because no vessel fits at both ports: ${sw.excluded_cheaper.join(", ")}.`);
  }
  cav.push("Figures are indicative planning estimates from the route model and optimizer, not broker or charter quotes.");
  return cav;
}

// ---------------------------------------------------------- port conditions ---

const RADAR_ALERT = new Set(["ELEVATED", "CRITICAL"]);

// Live AIS port conditions (ml-service Port Disruption Radar) for the ports
// this decision touches. Purely additive: the recommendation is still ranked
// on cost, but a congested port is called out because the cost estimates do
// not include port delays.
function describePortConditions({ radar, forecast, kind, sw }) {
  if (!radar || radar.status !== "ok") return { available: false, rows: [], warnings: [] };

  const byPort = new Map((radar.data?.ports || []).map((p) => [p.port, p]));
  const loadingPort = kind === "switch_origin" && sw.origin_port ? sw.origin_port : forecast.origin_port;
  const entries = [["Current loading port", forecast.origin_port, false]];
  if (kind === "switch_origin" && sw.origin_port) entries.push(["Recommended loading port", sw.origin_port, true]);
  entries.push(["Discharge port", forecast.destination_port, true]);

  const rows = entries.map(([role, port, decisive]) => {
    const r = byPort.get(port);
    return {
      role,
      port,
      decisive: decisive || port === loadingPort,
      status: r ? r.status : "UNKNOWN",
      waiting_now: r ? num(r.now?.waiting) : null,
      waiting_baseline: r ? num(r.baseline?.waiting) : null,
      waiting_change_pct: r ? num(r.changes?.waiting_pct) : null,
      speed_change_pct: r ? num(r.changes?.speed_pct) : null,
      confidence_label: r ? r.confidence?.label || null : null,
      planning_assumption_days: r ? num(r.impact?.planning_assumption_days) : null,
      reason: r ? r.insufficient_reason || null : "Port not tracked by live AIS.",
    };
  });

  const warnings = rows
    .filter((r) => r.decisive && RADAR_ALERT.has(r.status))
    .map((r) => {
      const days = r.planning_assumption_days;
      return (
        `${r.port} (${r.role.toLowerCase()}) shows ${r.status} congestion on live AIS: ` +
        `${r.waiting_now} vessels waiting against about ${r.waiting_baseline} normally. ` +
        `The costs above exclude port delays` +
        (days ? `; a planning allowance of ${days} extra day${days === 1 ? "" : "s"} is suggested, not measured.` : ".")
      );
    });
  // Dedupe when the same port is decisive twice (loading == recommended).
  return { available: true, rows, warnings: [...new Set(warnings)] };
}

// ------------------------------------------------------------------ builder ---

/**
 * @param {object} input
 * @param {object} input.forecast   normalised saved forecast (see routes/decisionBrief.js)
 * @param {object} input.scenario   { cargo_tons, duration_months, base_cargo_tons, base_duration_months, changed }
 * @param {object|null} input.whatif  ml-service /recommend result for the scenario (null when unchanged)
 * @param {{status:"ok",data:object}|{status:"unavailable",reason:string}} input.coa
 * @param {{status:"ok",data:object}|{status:"unavailable",reason:string}} input.compare
 * @param {Date} [input.generatedAt]
 */
function buildDecisionBrief({ forecast, scenario, whatif = null, coa, compare, radar = null, generatedAt = new Date() }) {
  const program = num(forecast.total_program_tons);
  const basisTons = program || scenario.cargo_tons;
  const basisLabel = program ? `${fmtTons(program)} t program` : `${fmtTons(scenario.cargo_tons)} t cargo`;

  const compareRows = compare.status === "ok" ? compare.data?.results || [] : [];
  const stay = buildStayOption({ forecast, scenario, whatif, compareRows, basisTons });
  const sw = buildSwitchOption({ forecast, compare, basisTons });
  const coaOpt = buildCoaOption({ forecast, coa, basisTons, duration: scenario.duration_months || 1 });
  const options = [stay, sw, coaOpt];

  // Deltas are only meaningful against a current lane that can actually be
  // chartered; against an infeasible baseline they would be misleading.
  for (const o of options) {
    if (o.key === "stay") continue;
    if (stay.eligible && o.cost_usd !== null && stay.cost_usd !== null) {
      o.delta_usd = o.cost_usd - stay.cost_usd;
      o.delta_pct = (o.delta_usd / stay.cost_usd) * 100;
    } else {
      o.delta_usd = null;
      o.delta_pct = null;
    }
  }
  if (!stay.eligible) {
    stay.delta_usd = null;
    stay.delta_pct = null;
  }

  const { kind, option: rec, belowThreshold } = chooseRecommendation(stay, sw, coaOpt);
  if (rec) rec.recommended = true;

  let savingsUsd = null;
  let savingsPct = null;
  if (rec && rec.key !== "stay" && stay.eligible) {
    savingsUsd = stay.cost_usd - rec.cost_usd;
    savingsPct = (savingsUsd / stay.cost_usd) * 100;
  }

  let headline;
  let subline;
  if (kind === "switch_origin") {
    headline = `Switch loading port to ${sw.origin_port}`;
  } else if (kind === "coa") {
    const n = coaOpt.plan?.voyages;
    headline = `Commit to a ${n ? `${n}-voyage` : "multi-voyage"} contract on a ${coaOpt.vessel}`;
  } else if (kind === "stay") {
    headline = `Stay on ${forecast.origin_port} to ${forecast.destination_port}`;
  } else {
    headline = "No option is executable under the current constraints";
  }

  if (savingsUsd !== null) {
    subline = `Compared with staying on the current lane, priced on the ${basisLabel} at forecast rates.`;
  } else if (kind === "stay") {
    subline = belowThreshold
      ? `The best alternative saves less than ${MIN_MATERIAL_SAVING_PCT}%, so there is no case for changing plans. Estimated cost ${formatUsdCompact(stay.cost_usd)} on the ${basisLabel}.`
      : `No alternative is cheaper. Estimated cost ${formatUsdCompact(stay.cost_usd)} on the ${basisLabel}.`;
  } else if (rec) {
    subline = `The current lane cannot be chartered as planned. Estimated cost of this option: ${formatUsdCompact(rec.cost_usd)} on the ${basisLabel}.`;
  } else {
    subline = "Review cargo size, ports or contract length and run the brief again.";
  }

  const reasons = describeReasons({ kind, stay, sw, coa: coaOpt, forecast, basisTons });
  const ports = describePortConditions({ radar, forecast, kind, sw });
  const warnings = [...describeWarnings({ savingPct: savingsPct, options }), ...ports.warnings];
  const caveats = describeCaveats({ kind, sw, coa: coaOpt });

  return {
    generated_at: generatedAt.toISOString(),
    forecast_record_id: forecast.record_id,
    lane: {
      commodity: forecast.commodity,
      origin_port: forecast.origin_port,
      destination_port: forecast.destination_port,
      shipment_date: forecast.shipment_date,
    },
    basis: { tons: basisTons, label: basisLabel, is_program: Boolean(program) },
    recommendation: {
      kind,
      option_key: rec ? rec.key : null,
      headline,
      subline,
      savings_usd: savingsUsd,
      savings_pct: savingsPct,
      min_material_saving_pct: MIN_MATERIAL_SAVING_PCT,
    },
    options: options.map(({ runner_up, excluded_cheaper, plan, origin_port, ...o }) => o),
    reasons,
    disclaimer: forecast.forecast_type === "synthetic_route" ? L.proxyDisclaimer : null,
    warnings,
    caveats,
    port_conditions: { available: ports.available, rows: ports.rows },
    scenario: {
      ...scenario,
      whatif: whatif
        ? {
            vessel_status: whatif.vessel_status,
            recommended_vessel_type: whatif.recommended_vessel_type,
            feasible_vessel_types: whatif.feasible_vessel_types || [],
            port_turnaround_days: num(whatif.port_turnaround_days),
            recommended_charter_window: whatif.recommended_charter_window,
            idle_management_advice: whatif.idle_management_advice,
            contracting_strategy: whatif.contracting_strategy,
            congestion_warning: whatif.congestion_warning,
            vessel_rejection_reason: whatif.vessel_rejection_reason || null,
          }
        : null,
    },
    context: {
      rate_usd_per_ton: num(forecast.rate_usd_per_ton),
      risk_label: forecast.risk_label,
      risk_confidence: num(forecast.risk_confidence),
      charter_window: forecast.charter_window,
      recommended_vessel_type: forecast.recommended_vessel_type,
      vessel_status: forecast.vessel_status,
      vessel_rejection_reason: forecast.vessel_rejection_reason,
      forecast_type: forecast.forecast_type,
      data_confidence: forecast.data_confidence,
      data_source_level: forecast.data_source_level,
      forecast_curve: forecast.forecast_curve || [],
      port_turnaround_days: num(forecast.port_turnaround_days),
      congestion_warning: forecast.congestion_warning,
      summary: forecast.summary,
    },
  };
}

module.exports = {
  buildDecisionBrief,
  formatUsd,
  formatUsdCompact,
  fmtTons,
  usdPerTon,
  isBothPortFeasible,
  normCommodity,
  MIN_MATERIAL_SAVING_PCT,
  LARGE_SAVING_PCT,
};
