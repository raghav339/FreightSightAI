// backend/src/utils/decisionBriefPdf.js
//
// Renders a structured Decision Brief (see utils/decisionBrief.js) to a PDF
// buffer with pdfkit. Same visual identity as the one-page forecast report in
// routes/pdf.js (Helvetica, teal #0f766e, amber for data warnings) — this is
// the boardroom-facing companion to it, not a replacement.
//
// Page 1 is what gets forwarded: recommendation, options compared, why.
// Page 2 is the supporting detail: scenario, current-lane forecast, limits.
//
// Every draw call uses explicit coordinates and a manually tracked cursor so
// layout does not depend on pdfkit's implicit text flow. The whole document
// is buffered and returned, so a rendering error becomes a clean JSON 500 in
// the route instead of a half-sent PDF.
"use strict";

const { formatUsd, formatUsdCompact, fmtTons, usdPerTon, MIN_MATERIAL_SAVING_PCT } = require("./decisionBrief");
const L = require("./pdfCopy");

const B = L.brief;

const REGULAR = "Helvetica";
const BOLD = "Helvetica-Bold";

const C = {
  teal: "#0f766e",
  tealTint: "#ecf6f4",
  ink: "#111827",
  body: "#1f2937",
  muted: "#6b7280",
  hair: "#e5e7eb",
  headFill: "#f3f4f6",
  amber: "#92400e",
  amberTint: "#fffbeb",
  amberBar: "#d97706",
  good: "#047857",
  bad: "#b45309",
};

const MARGIN = 50;
const FOOTER_RESERVE = 30; // keep content clear of the page footer
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(v) {
  const d = new Date(String(v).length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) return String(v ?? "-");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function capFirst(s) {
  const t = String(s ?? "");
  return t ? t[0].toUpperCase() + t.slice(1) : "-";
}

function months(n) {
  return n ? `${n} month${n === 1 ? "" : "s"}` : B.spot;
}

function draw(doc, brief) {
  const CW = doc.page.width - MARGIN * 2;
  let y = MARGIN;

  const bottom = () => doc.page.height - MARGIN - FOOTER_RESERVE;

  // ------------------------------------------------------------ primitives
  function measure(str, { size = 10, font = REGULAR, width = CW, lineGap = 0 } = {}) {
    doc.font(font).fontSize(size);
    return doc.heightOfString(String(str), { width, lineGap });
  }

  function text(str, x, yy, { size = 10, font = REGULAR, color = C.body, width = CW, align = "left", lineGap = 0 } = {}) {
    doc.font(font).fontSize(size).fillColor(color);
    doc.text(String(str), x, yy, { width, align, lineGap });
    return doc.heightOfString(String(str), { width, lineGap });
  }

  function rule(yy, color = C.hair) {
    doc.save().lineWidth(0.75).strokeColor(color).moveTo(MARGIN, yy).lineTo(MARGIN + CW, yy).stroke().restore();
  }

  function box(x, yy, w, h, fill, radius = 3) {
    doc.save().roundedRect(x, yy, w, h, radius).fill(fill).restore();
  }

  function ensureSpace(h) {
    if (y + h > bottom()) {
      doc.addPage();
      y = MARGIN;
    }
  }

  function sectionTitle(str) {
    ensureSpace(34);
    y += 4;
    y += text(str, MARGIN, y, { size: 12, font: BOLD, color: C.teal }) + 4;
  }

  function bullets(items, { size = 9.5, color = C.body, gap = 4 } = {}) {
    for (const item of items) {
      const h = measure(item, { size, width: CW - 14 });
      ensureSpace(h + gap);
      text("\u2022", MARGIN + 2, y, { size, color });
      text(item, MARGIN + 14, y, { size, color, width: CW - 14 });
      y += h + gap;
    }
  }

  // A table cell is a list of styled lines. Row height is the tallest cell.
  const line = (str, o = {}) => ({ str: String(str), ...o });

  // Page 1 tables breathe; the supporting page uses denser rows so it stays one page.
  let tablePad = 6;

  function drawTable(cols, rows, { headFill = C.headFill, padY = tablePad } = {}) {
    const padX = 6;

    const cellHeight = (cell, col) =>
      (cell || []).reduce(
        (sum, ln) => sum + measure(ln.str, { size: ln.size || 9.5, font: ln.font || REGULAR, width: col.w - padX * 2 }) + 1.5,
        0
      );

    // header
    const headH = 20;
    ensureSpace(headH + 40);
    box(MARGIN, y, CW, headH, headFill, 2);
    let x = MARGIN;
    for (const col of cols) {
      text(col.header, x + padX, y + 6, { size: 8.5, font: BOLD, color: C.muted, width: col.w - padX * 2, align: col.align || "left" });
      x += col.w;
    }
    y += headH;

    for (const row of rows) {
      const h = Math.max(...row.cells.map((cell, i) => cellHeight(cell, cols[i]))) + padY * 2 - 1.5;
      ensureSpace(h);
      if (row.fill) box(MARGIN, y, CW, h, row.fill, 0);
      x = MARGIN;
      row.cells.forEach((cell, i) => {
        let cy = y + padY;
        for (const ln of cell || []) {
          const opts = { size: ln.size || 9.5, font: ln.font || REGULAR, color: ln.color || C.body, width: cols[i].w - padX * 2, align: cols[i].align || "left" };
          cy += text(ln.str, x + padX, cy, opts) + 1.5;
        }
        x += cols[i].w;
      });
      y += h;
      rule(y);
    }
  }

  // ============================================================== PAGE 1
  // Masthead
  text("FreightSight AI", MARGIN, y, { size: 9, font: BOLD, color: C.teal });
  text(`${B.prepared} ${fmtDate(brief.generated_at)}`, MARGIN, y, { size: 9, color: C.muted, align: "right" });
  y += 15;
  rule(y, C.teal);
  y += 12;

  y += text(B.title, MARGIN, y, { size: 26, font: BOLD, color: C.ink }) + 2;
  const { lane, scenario, recommendation: rec } = brief;
  y += text(`${lane.commodity}, ${lane.origin_port} to ${lane.destination_port}`, MARGIN, y, { size: 13, font: BOLD, color: C.body }) + 3;

  let meta = `${B.shipment} ${fmtDate(lane.shipment_date)}   \u00b7   ${brief.basis.label}`;
  if (scenario.changed) {
    meta += `   \u00b7   ${B.scenario}: ${fmtTons(scenario.cargo_tons)} t per lift, ${months(scenario.duration_months)}`;
  }
  y += text(meta, MARGIN, y, { size: 9.5, color: C.muted }) + 14;

  // Recommendation panel — the one memorable element on the page.
  {
    const tone = rec.kind === "none" ? { tint: C.amberTint, bar: C.amberBar, accent: C.amber } : { tint: C.tealTint, bar: C.teal, accent: C.teal };
    const padT = 14;
    const padX = 18;
    const x = MARGIN + 5 + padX;
    const w = CW - 5 - padX * 2;

    const hasSaving = rec.savings_usd !== null && rec.savings_usd !== undefined;
    const labelH = measure(B.recommendation, { size: 9, font: BOLD, width: w });
    const headH = measure(rec.headline, { size: 18, font: BOLD, width: w });
    const bigH = hasSaving ? measure("0", { size: 30, font: BOLD, width: w }) : 0;
    const subH = measure(rec.subline, { size: 10.5, width: w });
    const panelH = padT + labelH + 5 + headH + 8 + (hasSaving ? bigH + 4 : 0) + subH + padT;

    ensureSpace(panelH + 10);
    box(MARGIN, y, CW, panelH, tone.tint, 3);
    box(MARGIN, y, 5, panelH, tone.bar, 0);

    let py = y + padT;
    py += text(B.recommendation, x, py, { size: 9, font: BOLD, color: tone.accent, width: w }) + 5;
    py += text(rec.headline, x, py, { size: 18, font: BOLD, color: C.ink, width: w }) + 8;
    if (hasSaving) {
      const big = formatUsdCompact(rec.savings_usd);
      doc.font(BOLD).fontSize(30);
      const bigW = doc.widthOfString(big);
      text(big, x, py, { size: 30, font: BOLD, color: C.teal, width: w });
      text(`saved (${rec.savings_pct.toFixed(1)}%)`, x + bigW + 10, py + 17, {
        size: 10.5,
        color: C.body,
        width: Math.max(60, w - bigW - 10),
      });
      py += bigH + 4;
    }
    text(rec.subline, x, py, { size: 10.5, color: C.body, width: w });
    y += panelH + 10;
  }

  // Data disclaimer and priority warnings, straight under the headline.
  {
    const notes = [brief.disclaimer, ...brief.warnings].filter(Boolean);
    if (notes.length) {
      const w = CW - 5 - 20;
      const heights = notes.map((n) => measure(n, { size: 8.5, width: w }));
      const h = 16 + heights.reduce((a, b) => a + b, 0) + (notes.length - 1) * 4;
      ensureSpace(h + 10);
      box(MARGIN, y, CW, h, C.amberTint, 3);
      box(MARGIN, y, 3, h, C.amberBar, 0);
      let ny = y + 8;
      notes.forEach((n, i) => {
        text(n, MARGIN + 14, ny, { size: 8.5, color: C.amber, width: w });
        ny += heights[i] + 4;
      });
      y += h + 10;
    }
  }

  // Options compared
  sectionTitle(B.optionsCompared);
  {
    const cols = [
      { header: B.colOption, w: 170 },
      { header: B.colRate, w: 58, align: "right" },
      { header: B.colCost, w: 84, align: "right" },
      { header: B.colVsCurrent, w: 88, align: "right" },
      { header: B.colVoyage, w: 45, align: "right" },
      { header: B.colRisk, w: 50, align: "right" },
    ];
    const rows = brief.options.map((o) => {
      const dim = !o.eligible;
      const num = (str, extra = {}) => [line(str, { color: dim ? C.muted : C.body, ...extra })];
      const first = [line(o.title, { font: BOLD, size: 9.5, color: C.ink })];
      if (o.subtitle) first.push(line(o.subtitle, { size: 8.5, color: C.muted }));
      if (o.recommended) first.push(line(B.recommended, { size: 8, font: BOLD, color: C.teal }));
      for (const n of (o.notes || []).slice(0, 2)) first.push(line(n, { size: 8, color: C.muted }));
      if (!o.eligible && o.reason) first.push(line(o.reason, { size: 8, color: C.amber }));

      let vs;
      if (o.key === "stay") vs = [line(o.eligible ? B.baseline : "-", { color: C.muted })];
      else if (o.delta_usd === null || o.delta_usd === undefined) vs = num("-");
      else {
        const cheaper = o.delta_usd < 0;
        const colour = dim ? C.muted : cheaper ? C.good : C.bad;
        vs = [
          line(`${cheaper ? "-" : "+"}${formatUsd(Math.abs(o.delta_usd))}`, { color: colour, font: BOLD }),
          line(`${cheaper ? "-" : "+"}${Math.abs(o.delta_pct).toFixed(1)}%`, { color: colour, size: 8.5 }),
        ];
      }

      return {
        fill: o.recommended ? C.tealTint : null,
        cells: [
          first,
          num(o.rate_usd_per_ton !== null ? usdPerTon(o.rate_usd_per_ton) : "-"),
          num(o.cost_usd !== null ? formatUsd(o.cost_usd) : "-", { font: BOLD }),
          vs,
          num(o.voyage_days !== null ? `${o.voyage_days} d` : "-"),
          num(o.risk_label ? capFirst(o.risk_label) : o.risk_note || "-", { size: 8.5 }),
        ],
      };
    });
    drawTable(cols, rows);
    y += 4;
    y += text(
      `Cost is rate per tonne multiplied by ${fmtTons(brief.basis.tons)} t. Voyage is one round of loading, sailing and discharge, in days.`,
      MARGIN,
      y,
      { size: 8, color: C.muted }
    ) + 4;
  }

  // Why
  if (brief.reasons.length) {
    sectionTitle(B.why);
    bullets(brief.reasons.slice(0, 5), { size: 9.5 });
  }

  // ============================================================== PAGE 2
  doc.addPage();
  y = MARGIN;
  tablePad = 3.5;
  text("FreightSight AI", MARGIN, y, { size: 9, font: BOLD, color: C.teal });
  text(`${lane.commodity}, ${lane.origin_port} to ${lane.destination_port}`, MARGIN, y, { size: 9, color: C.muted, align: "right" });
  y += 15;
  rule(y, C.teal);
  y += 10;
  y += text(B.supporting, MARGIN, y, { size: 18, font: BOLD, color: C.ink }) + 2;

  const ctx = brief.context;
  const wi = scenario.whatif;

  sectionTitle(B.scenarioInputs);
  {
    const cols = [
      { header: B.colItem, w: 150 },
      { header: B.colForecast, w: 170 },
      { header: B.colBrief, w: 175 },
    ];
    const vesselText = (status, vessel, reason) =>
      status === "NO_FEASIBLE_VESSEL" ? `No feasible vessel${reason ? `: ${reason}` : ""}` : `${vessel || "-"} fits both ports`;
    const turn = (d) => (d !== null && d !== undefined ? `${d} days` : "-");

    const same = !scenario.changed || !wi;
    const rowsDef = [
      [B.cargoPerLift, `${fmtTons(scenario.base_cargo_tons)} t`, `${fmtTons(scenario.cargo_tons)} t`],
      [B.contractLength, months(scenario.base_duration_months), months(scenario.duration_months)],
      [
        B.vesselFit,
        vesselText(ctx.vessel_status, ctx.recommended_vessel_type, ctx.vessel_rejection_reason),
        same ? "Unchanged" : vesselText(wi.vessel_status, wi.recommended_vessel_type, wi.vessel_rejection_reason),
      ],
      [B.turnaround, turn(ctx.port_turnaround_days), same ? "Unchanged" : turn(wi.port_turnaround_days)],
      [B.charterWindow, ctx.charter_window || "-", same ? "Unchanged" : wi.recommended_charter_window || "-"],
    ];
    if (brief.basis.is_program) rowsDef.splice(2, 0, ["Program size", `${fmtTons(brief.basis.tons)} t`, `${fmtTons(brief.basis.tons)} t`]);

    drawTable(
      cols,
      rowsDef.map(([a, b, c]) => ({
        cells: [[line(a, { font: BOLD, size: 9, color: C.ink })], [line(b, { size: 9 })], [line(c, { size: 9 })]],
      }))
    );
  }

  sectionTitle(B.currentLane);
  {
    const conf = ctx.risk_confidence !== null && ctx.risk_confidence !== undefined ? `, confidence ${(ctx.risk_confidence * 100).toFixed(1)}%` : "";
    const facts = [
      `Forecast rate ${usdPerTon(ctx.rate_usd_per_ton)} on ${lane.origin_port} to ${lane.destination_port}. Market risk ${String(ctx.risk_label || "-").toUpperCase()}${conf}.`,
      `Data: ${ctx.data_confidence || "-"} confidence, source level ${String(ctx.data_source_level || "-").replace(/_/g, " ")}.`,
    ];
    if (ctx.congestion_warning) facts.push(ctx.congestion_warning);
    for (const f of facts) {
      const h = measure(f, { size: 9.5 });
      ensureSpace(h + 2);
      y += text(f, MARGIN, y, { size: 9 }) + 2;
    }

    if (ctx.forecast_curve.length) {
      y += 4;
      const cols = [
        { header: B.outlook, w: 130 },
        { header: "Date", w: 110 },
        { header: "Forecast", w: 100, align: "right" },
        { header: "Range", w: 155, align: "right" },
      ];
      const rows = ctx.forecast_curve.map((p) => ({
        cells: [
          [line(p.horizon || "-", { size: 9 })],
          [line(p.date ? fmtDate(p.date) : "-", { size: 9 })],
          [line(p.predicted_rate != null ? usdPerTon(p.predicted_rate) : "-", { size: 9, font: BOLD })],
          [line(p.lower_bound != null && p.upper_bound != null ? `${usdPerTon(p.lower_bound)} to ${usdPerTon(p.upper_bound)}` : "-", { size: 9, color: C.muted })],
        ],
      }));
      drawTable(cols, rows);
    }
  }

  {
    const pc = brief.port_conditions;
    sectionTitle(B.portConditions);
    if (!pc || !pc.available || !pc.rows.length) {
      ensureSpace(18);
      y += text(B.portConditionsNone, MARGIN, y, { size: 9.5, color: C.muted }) + 4;
    } else {
      const cols = [
        { header: "Port", w: 150 },
        { header: "Status", w: 85 },
        { header: "Waiting vs normal", w: 150, align: "right" },
        { header: "Data", w: 110, align: "right" },
      ];
      const statusColor = (st) => (st === "CRITICAL" || st === "ELEVATED" ? C.bad : st === "WATCH" ? C.amber : st === "NORMAL" ? C.good : C.muted);
      const rows = pc.rows.map((r) => {
        const waiting =
          r.waiting_now != null && r.waiting_baseline != null
            ? `${r.waiting_now} vs ${r.waiting_baseline}${r.waiting_change_pct != null ? ` (${r.waiting_change_pct > 0 ? "+" : ""}${r.waiting_change_pct.toFixed(0)}%)` : ""}`
            : "-";
        const first = [line(r.port, { font: BOLD, size: 9.5, color: C.ink }), line(r.role, { size: 8.5, color: C.muted })];
        if (r.reason) first.push(line(r.reason, { size: 8, color: C.amber }));
        return {
          cells: [
            first,
            [line(String(r.status).replace("_", " "), { font: BOLD, size: 9, color: statusColor(r.status) })],
            [line(waiting, { size: 9 })],
            [line(r.confidence_label ? `${r.confidence_label} coverage` : "-", { size: 9, color: C.muted })],
          ],
        };
      });
      drawTable(cols, rows);
      y += 4;
      y += text(B.portConditionsNote, MARGIN, y, { size: 8, color: C.muted }) + 4;
    }
  }

  if (wi && (wi.contracting_strategy || wi.idle_management_advice)) {
    sectionTitle("Scenario guidance");
    const items = [wi.contracting_strategy, wi.idle_management_advice].filter(Boolean);
    bullets(items, { size: 8.5, gap: 3 });
  }

  sectionTitle(B.watchOuts);
  bullets(brief.caveats, { size: 8.5, color: C.body, gap: 3 });

  // Method note sits under the limits, without a heading of its own.
  y += 4;
  {
    const t = B.methodText.replace("{min}", String(MIN_MATERIAL_SAVING_PCT));
    const ref = B.fullReport.replace("{id}", String(brief.forecast_record_id));
    const both = `${t} ${ref}`;
    ensureSpace(measure(both, { size: 8 }) + 4);
    text(both, MARGIN, y, { size: 8, color: C.muted });
  }

  // ---------------------------------------------------------------- footer
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits inside the bottom margin; without this pdfkit would
    // treat writing there as overflow and add a blank page.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 38;
    rule(fy - 6);
    doc.font(REGULAR).fontSize(8).fillColor(C.muted);
    doc.text(`${L.footer} \u00b7 ${B.footerNote}`, MARGIN, fy, { width: CW - 60, align: "left", lineBreak: false });
    doc.text(`${B.page} ${i - range.start + 1} of ${range.count}`, MARGIN, fy, { width: CW, align: "right", lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
}

/**
 * @param {object} brief  output of buildDecisionBrief()
 * @param {{ PDFDocument?: Function }} [deps]  injectable for tests
 * @returns {Promise<Buffer>}
 */
function renderDecisionBriefPdf(brief, { PDFDocument } = {}) {
  const PDF = PDFDocument || require("pdfkit");
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDF({
        size: "A4",
        margin: MARGIN,
        bufferPages: true,
        info: {
          Title: `Decision Brief - ${brief.lane.commodity}, ${brief.lane.origin_port} to ${brief.lane.destination_port}`,
          Author: "FreightSight AI",
          Subject: brief.recommendation.headline,
        },
      });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      draw(doc, brief);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderDecisionBriefPdf };
