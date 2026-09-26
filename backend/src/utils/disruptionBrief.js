// backend/src/utils/disruptionBrief.js
//
// Pure logic for the Disruption Decision Brief: takes ONE Disruption Engine
// result (ml-service POST /disruption/simulate or /disruption/live — see
// ml-service/app/disruption_engine.py and
// app/utils.py::_build_disruption_response, which already wires the
// Disruption Engine into the route forecast and the Port Substitution
// Engine) and reduces it to a single call — wait it out at the disrupted
// port, or divert to the recommended alternative — plus the propagation
// chain and freight impact that justify it.
//
// This is the missing link between four features that otherwise don't talk
// to each other in the final output: forecast, port substitution, disruption
// simulation, and the Decision Brief PDF. "Cyclone hits Paradip" becomes one
// downloadable page with the propagation chain, the wait-vs-divert call, and
// the recommended alternative port.
//
// No I/O, no PDF, no clock: routes/disruptionBrief.js does the fetching and
// utils/disruptionBriefPdf.js does the rendering, so this file can be tested
// directly with plain objects, in the style of utils/decisionBrief.js.
//
// Nothing in here is generated text from a language model. Every sentence is
// assembled from numbers the ml-service Disruption Engine and Port
// Substitution Engine returned; the PDF can never say something the model
// output does not support.
"use strict";

// An alternative port must beat waiting it out by at least this many days of
// expected delay before the brief calls for diverting. Below this, the
// difference sits inside the noise of the planning-assumption delay figures
// (see disruption_engine.py's own ASSUMPTIONS) and is not worth the
// switching effort — losing a booked slot, onward logistics to a different
// port, etc. — none of which is modelled here. Mirrors decisionBrief.js's
// MIN_MATERIAL_SAVING_PCT idea, but in days rather than percent, because
// delay (not cost) is the primary lever the Disruption Engine's wait-vs-
// divert comparison actually measures.
const MIN_MATERIAL_DELAY_SAVING_DAYS = 1.0;

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function days(n, digits = 1) {
  if (n === null || n === undefined) return "-";
  const v = Number(n);
  return `${v.toFixed(digits)} day${Math.abs(v - 1) < 0.05 ? "" : "s"}`;
}

function usdPerTon(n) {
  return n === null || n === undefined ? "-" : `$${Number(n).toFixed(2)}/t`;
}

function signedUsdPerTon(n) {
  if (n === null || n === undefined) return "-";
  const v = Number(n);
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}/t`;
}

// $1.04M / $207K / $850 — mirrors decisionBrief.js's formatUsdCompact, kept
// local (rather than imported) so this file stays testable standalone, in
// the style described in the file header.
function formatUsdCompact(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "-";
  const v = Number(n);
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3).toLocaleString("en-US")}K`;
  return `${sign}$${Math.round(a)}`;
}

// The $ headline the "$ saved" / "$ at risk" rollup is built from. Prefers
// the freight_impact_usd ml-service now computes directly (server-side, one
// source of truth); falls back to deriving it from freight_delta_usd_per_ton
// and a cargo-tons figure recovered from decision.cargo_weight_tons or
// lane.total_impact_usd / lane.delta_usd_per_ton, so a payload from an older
// ml-service (or a test fixture) still gets a dollar figure rather than
// silently losing it.
function freightImpactUsd(option, { decision, lane }) {
  if (!option) return null;
  if (option.freight_impact_usd !== null && option.freight_impact_usd !== undefined) {
    return num(option.freight_impact_usd);
  }
  const delta = num(option.freight_delta_usd_per_ton);
  if (delta === null) return null;
  let cargoTons = num(decision?.cargo_weight_tons);
  if (cargoTons === null && lane && num(lane.delta_usd_per_ton) && lane.delta_usd_per_ton !== 0) {
    cargoTons = num(lane.total_impact_usd) / num(lane.delta_usd_per_ton);
  }
  return cargoTons === null ? null : delta * cargoTons;
}

// -------------------------------------------------------------- the call ---

// Decides wait vs. divert vs. "not applicable" (loading ports / unresolved
// roles don't get a wait-vs-divert comparison — see disruption_engine.py's
// module docstring: this engine's ETA impact is port-side only, and the
// alternative-port comparison only makes sense for a discharge port).
function chooseCall({ portRole, decision, propagation, lane }) {
  if (portRole !== "destination") {
    return { kind: "not_applicable", option: null, breached: null, delaySavedDays: null, dollarSavedUsd: null, dollarAtRiskUsd: null };
  }
  if (!decision) {
    return { kind: "no_alternatives_checked", option: null, breached: null, delaySavedDays: null, dollarSavedUsd: null, dollarAtRiskUsd: null };
  }
  const wait = decision.wait;
  const alt = decision.alternative;
  const stockpileStep = (propagation || []).find((s) => s.key === "stockpile");
  const breached = stockpileStep ? Boolean(stockpileStep.breached) : null;
  const waitImpactUsd = freightImpactUsd(wait, { decision, lane });

  if (!alt) {
    return { kind: "wait", option: wait, breached, delaySavedDays: null, dollarSavedUsd: null, dollarAtRiskUsd: waitImpactUsd };
  }

  const altImpactUsd = freightImpactUsd(alt, { decision, lane });
  const waitDays = num(wait.expected_delay_days);
  const altDays = num(alt.expected_delay_days);
  const delaySavedDays = waitDays !== null && altDays !== null ? waitDays - altDays : null;
  // $ saved by diverting rather than waiting — positive means diverting is
  // cheaper. Only meaningful when both sides priced a lane.
  const dollarSavedUsd = waitImpactUsd !== null && altImpactUsd !== null ? waitImpactUsd - altImpactUsd : null;
  const materialSaving = delaySavedDays !== null && delaySavedDays >= MIN_MATERIAL_DELAY_SAVING_DAYS;

  if (materialSaving || breached) {
    return { kind: "divert", option: alt, breached, delaySavedDays, dollarSavedUsd, dollarAtRiskUsd: null };
  }
  return { kind: "wait", option: wait, breached, delaySavedDays, dollarSavedUsd, dollarAtRiskUsd: waitImpactUsd };
}

// --------------------------------------------------------------- narrative --

function describeReasons({ call, wait, alt, port, portRole, lane }) {
  const reasons = [];

  if (call.kind === "divert") {
    reasons.push(
      `Diverting to ${alt.port} is expected to take ${days(alt.expected_delay_days)} against ${days(wait.expected_delay_days)} waiting it out at ${port} — ${days(Math.max(call.delaySavedDays, 0))} saved.`
    );
    if (alt.freight_delta_usd_per_ton !== null && wait.freight_delta_usd_per_ton !== null) {
      const diff = alt.freight_delta_usd_per_ton - wait.freight_delta_usd_per_ton;
      if (Math.abs(diff) >= 0.01) {
        reasons.push(
          `Freight at ${alt.port} is ${signedUsdPerTon(Math.abs(diff))} ${diff < 0 ? "cheaper" : "more expensive"} than the ${port} lane under this disruption.`
        );
      }
    }
    if (call.dollarSavedUsd !== null && Math.abs(call.dollarSavedUsd) >= 1) {
      reasons.push(
        call.dollarSavedUsd >= 0
          ? `On this cargo, diverting is worth about ${formatUsdCompact(call.dollarSavedUsd)} in avoided freight pressure compared with waiting.`
          : `Diverting costs about ${formatUsdCompact(Math.abs(call.dollarSavedUsd))} more in freight than waiting — the call is made on delay/stockpile grounds, not freight cost.`
      );
    }
    if (alt.distance_from_disrupted_port_nm !== null && alt.distance_from_disrupted_port_nm !== undefined) {
      reasons.push(`${alt.port} is about ${Math.round(alt.distance_from_disrupted_port_nm)} nm from ${port}.`);
    }
    if (call.breached) {
      reasons.push(`Waiting it out would breach the stockpile buffer set for ${port}; diverting avoids that.`);
    }
  } else if (call.kind === "wait") {
    if (!alt) {
      reasons.push(
        `No vessel-feasible alternative discharge port was found for this cargo, so waiting it out at ${port} is the only option.`
      );
    } else {
      const saved = call.delaySavedDays !== null ? days(Math.max(call.delaySavedDays, 0)) : "an unclear amount of time";
      reasons.push(
        `The best alternative, ${alt.port}, only saves ${saved} over waiting at ${port} — under the ${MIN_MATERIAL_DELAY_SAVING_DAYS}-day margin needed to justify diverting.`
      );
    }
    reasons.push(
      `Expected delay waiting it out: ${days(wait.expected_delay_days)}` +
        (wait.freight_delta_usd_per_ton !== null && wait.freight_delta_usd_per_ton !== undefined
          ? `, freight ${signedUsdPerTon(wait.freight_delta_usd_per_ton)}` +
            (call.dollarAtRiskUsd !== null && Math.abs(call.dollarAtRiskUsd) >= 1
              ? ` (${formatUsdCompact(Math.abs(call.dollarAtRiskUsd))} on this cargo).`
              : ".")
          : ".")
    );
  } else if (call.kind === "no_alternatives_checked") {
    reasons.push("Alternative discharge ports were not evaluated for this scenario.");
  } else if (portRole === "origin") {
    reasons.push(
      `${port} is a loading port; the wait-vs-divert comparison applies to discharge ports. Use the Port Substitution Engine directly to compare alternative loading ports.`
    );
  } else {
    reasons.push(`${port}'s role (loading vs. discharge) could not be determined, so no wait-vs-divert comparison was made.`);
  }

  if (!lane) {
    reasons.push("No loading port, discharge port and commodity were all given, so freight-rate impact is not priced in this brief.");
  }
  return reasons;
}

// ------------------------------------------------------------------ builder-

/**
 * @param {object} input
 * @param {object} input.result  one Disruption Engine result — the JSON body
 *   of ml-service POST /disruption/simulate or /disruption/live (see
 *   app/utils.py::_build_disruption_response for the shape: port, port_role,
 *   disruption{propagation,...}, lane, alternatives, decision, notes).
 * @param {Date} [input.generatedAt]
 */
function buildDisruptionBrief({ result, generatedAt = new Date() }) {
  const d = result.disruption || {};
  const port = result.port;
  const portRole = result.port_role;
  const decision = result.decision || null;
  const wait = decision?.wait || null;
  const alt = decision?.alternative || null;

  const call = chooseCall({ portRole, decision, propagation: d.propagation, lane: result.lane });
  const reasons = describeReasons({ call, wait, alt, port, portRole, lane: result.lane });

  // Normalize freight_impact_usd onto wait/alternative so every consumer of
  // `brief.decision` (the PDF table, any other caller) sees the same $
  // figure chooseCall() used, even when ml-service didn't send it directly.
  const decisionOut = decision
    ? {
        ...decision,
        wait: wait ? { ...wait, freight_impact_usd: freightImpactUsd(wait, { decision, lane: result.lane }) } : wait,
        alternative: alt ? { ...alt, freight_impact_usd: freightImpactUsd(alt, { decision, lane: result.lane }) } : alt,
      }
    : decision;

  let headline;
  let subline;
  if (call.kind === "divert") {
    headline = `Divert to ${alt.port}`;
    const timePart = `${days(Math.max(call.delaySavedDays, 0))} faster`;
    const dollarPart =
      call.dollarSavedUsd !== null
        ? call.dollarSavedUsd >= 0
          ? ` and ${formatUsdCompact(call.dollarSavedUsd)} cheaper`
          : ` (though ${formatUsdCompact(Math.abs(call.dollarSavedUsd))} more expensive on freight — diverting is still called for the reason below)`
        : "";
    subline = `${timePart}${dollarPart} than waiting it out at ${port}.`;
  } else if (call.kind === "wait") {
    headline = `Wait it out at ${port}`;
    const riskPart = call.dollarAtRiskUsd !== null && call.dollarAtRiskUsd !== 0 ? ` ${formatUsdCompact(Math.abs(call.dollarAtRiskUsd))} at risk on freight if this holds.` : "";
    subline = (alt
      ? `The best alternative (${alt.port}) does not save enough time to justify diverting.`
      : "No vessel-feasible alternative discharge port was found.") + riskPart;
  } else if (call.kind === "no_alternatives_checked") {
    headline = `Review ${port} manually`;
    subline = "Alternative discharge ports were not evaluated for this scenario.";
  } else {
    headline = `${d.event_label || "Disruption"} at ${port}`;
    subline =
      portRole === "origin"
        ? `${port} is a loading port; see the propagation and freight impact below.`
        : "See the propagation and freight impact below.";
  }

  const alternatives = result.alternatives
    ? {
        recommendation: result.alternatives.recommendation,
        options: (result.alternatives.options || []).filter((o) => o.feasible).slice(0, 3),
      }
    : null;

  return {
    generated_at: generatedAt.toISOString(),
    source: d.source,
    port,
    port_role: portRole,
    event: {
      type: d.event_type,
      label: d.event_label,
      severity_pct: num(d.severity) !== null ? Math.round(d.severity * 100) : null,
      duration_days: num(d.duration_days),
    },
    call: {
      kind: call.kind,
      headline,
      subline,
      delay_saved_days: call.delaySavedDays,
      stockpile_breached: call.breached,
      // "$ saved" / "$ at risk" rollup — only one of the two is ever
      // meaningful for a given call kind (see chooseCall): dollar_saved_usd
      // for "divert" (diverting vs. waiting), dollar_at_risk_usd for "wait"
      // (exposure on this parcel if the disruption holds).
      dollar_saved_usd: call.dollarSavedUsd,
      dollar_at_risk_usd: call.dollarAtRiskUsd,
    },
    impact: {
      productivity_loss_pct: num(d.productivity_loss_pct),
      loading_delay_days: num(d.loading_delay_days),
      vessel_waiting_days: num(d.vessel_waiting_days),
      freight_pressure_pct: num(d.freight_pressure_pct),
      total_eta_impact_days: num(d.total_eta_impact_days),
    },
    propagation: d.propagation || [],
    lane: result.lane || null,
    decision: decisionOut,
    alternatives,
    reasons,
    notes: result.notes || [],
    assumptions: d.assumptions || [],
    live_conditions: result.live_conditions || null,
  };
}

module.exports = {
  buildDisruptionBrief,
  MIN_MATERIAL_DELAY_SAVING_DAYS,
  usdPerTon,
  signedUsdPerTon,
  formatUsdCompact,
  days,
};
