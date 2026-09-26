// backend/src/utils/disruptionBriefPdf.js
//
// Renders a structured Disruption Decision Brief (see
// utils/disruptionBrief.js) to a PDF buffer with pdfkit. Same visual
// identity as the forecast Decision Brief (utils/decisionBriefPdf.js) —
// Helvetica, teal #0f766e, amber for warnings — kept as its own drawing
// routine (not shared code) so the two briefs can evolve independently, the
// same way routes/pdf.js and utils/decisionBriefPdf.js do today.
//
// Deliberately laid out to fit ONE page for the common case (an event at one
// port, with or without a lane and alternatives): "cyclone hits Paradip" is
// meant to become a single forwardable page, not a report. If a scenario has
// enough alternative ports / notes to overflow, ensureSpace() below adds a
// continuation page rather than truncating content — a graceful fallback,
// not the design target.
"use strict";

const { usdPerTon, signedUsdPerTon, formatUsdCompact, days } = require("./disruptionBrief");

function signedUsdCompact(n) {
  if (n === null || n === undefined) return "-";
  const v = Number(n);
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${formatUsdCompact(Math.abs(v))}`;
}
const L = require("./pdfCopy");

const B = L.disruptionBrief;

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
  vermilion: "#b91c1c",
  vermilionTint: "#fef2f2",
  vermilionBar: "#b91c1c",
  good: "#047857",
};

const MARGIN = 50;
const FOOTER_RESERVE = 30;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(v) {
  const d = new Date(String(v).length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) return String(v ?? "-");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function draw(doc, brief) {
  const CW = doc.page.width - MARGIN * 2;
  let y = MARGIN;
  const bottom = () => doc.page.height - MARGIN - FOOTER_RESERVE;

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
    ensureSpace(30);
    y += 3;
    y += text(str, MARGIN, y, { size: 11.5, font: BOLD, color: C.teal }) + 4;
  }

  function bullets(items, { size = 9, color = C.body, gap = 3.5 } = {}) {
    for (const item of items) {
      const h = measure(item, { size, width: CW - 14 });
      ensureSpace(h + gap);
      text("\u2022", MARGIN + 2, y, { size, color });
      text(item, MARGIN + 14, y, { size, color, width: CW - 14 });
      y += h + gap;
    }
  }

  const line = (str, o = {}) => ({ str: String(str), ...o });

  function drawTable(cols, rows, { headFill = C.headFill, padY = 4.5 } = {}) {
    const padX = 6;
    const cellHeight = (cell, col) =>
      (cell || []).reduce(
        (sum, ln) => sum + measure(ln.str, { size: ln.size || 9, font: ln.font || REGULAR, width: col.w - padX * 2 }) + 1.5,
        0
      );

    const headH = 18;
    ensureSpace(headH + 30);
    box(MARGIN, y, CW, headH, headFill, 2);
    let x = MARGIN;
    for (const col of cols) {
      text(col.header, x + padX, y + 5, { size: 8.5, font: BOLD, color: C.muted, width: col.w - padX * 2, align: col.align || "left" });
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
          const opts = { size: ln.size || 9, font: ln.font || REGULAR, color: ln.color || C.body, width: cols[i].w - padX * 2, align: cols[i].align || "left" };
          cy += text(ln.str, x + padX, cy, opts) + 1.5;
        }
        x += cols[i].w;
      });
      y += h;
      rule(y);
    }
  }

  // -------------------------------------------------------------- masthead
  text("FreightSight AI", MARGIN, y, { size: 9, font: BOLD, color: C.teal });
  text(`${B.prepared} ${fmtDate(brief.generated_at)}`, MARGIN, y, { size: 9, color: C.muted, align: "right" });
  y += 15;
  rule(y, C.teal);
  y += 12;

  y += text(B.title, MARGIN, y, { size: 24, font: BOLD, color: C.ink }) + 2;
  y += text(`${brief.event.label || "Disruption"} \u00b7 ${brief.port}`, MARGIN, y, { size: 13, font: BOLD, color: C.body }) + 4;

  const isLive = brief.source === "live";
  {
    const badgeText = isLive ? B.live : B.simulated;
    doc.font(BOLD).fontSize(8.5);
    const bw = doc.widthOfString(badgeText) + 16;
    box(MARGIN, y, bw, 16, isLive ? C.tealTint : C.amberTint, 8);
    text(badgeText, MARGIN, y + 4, { size: 8.5, font: BOLD, color: isLive ? C.teal : C.amber, width: bw, align: "center" });
    let meta = `Severity ${brief.event.severity_pct ?? "-"}/100`;
    if (brief.event.duration_days && brief.event.duration_days !== 1) meta += `  \u00b7  ~${brief.event.duration_days.toFixed(0)}d duration`;
    if (brief.lane) meta += `  \u00b7  ${brief.lane.commodity}, ${brief.lane.origin_port} to ${brief.lane.destination_port}`;
    text(meta, MARGIN + bw + 10, y + 4, { size: 9.5, color: C.muted, width: CW - bw - 10 });
    y += 24;
  }

  // ------------------------------------------------------------ the call
  {
    const kind = brief.call.kind;
    const tone =
      kind === "divert"
        ? { tint: C.vermilionTint, bar: C.vermilionBar, accent: C.vermilion }
        : kind === "wait"
        ? { tint: C.tealTint, bar: C.teal, accent: C.teal }
        : { tint: C.amberTint, bar: C.amberBar, accent: C.amber };
    const padT = 13;
    const padX = 18;
    const x = MARGIN + 5 + padX;
    const w = CW - 5 - padX * 2;

    const labelH = measure(B.call, { size: 9, font: BOLD, width: w });
    const headH = measure(brief.call.headline, { size: 17, font: BOLD, width: w });
    const subH = measure(brief.call.subline, { size: 10.5, width: w });
    const panelH = padT + labelH + 4 + headH + 6 + subH + padT;

    ensureSpace(panelH + 10);
    box(MARGIN, y, CW, panelH, tone.tint, 3);
    box(MARGIN, y, 5, panelH, tone.bar, 0);

    let py = y + padT;
    py += text(B.call, x, py, { size: 9, font: BOLD, color: tone.accent, width: w }) + 4;
    py += text(brief.call.headline, x, py, { size: 17, font: BOLD, color: C.ink, width: w }) + 6;
    text(brief.call.subline, x, py, { size: 10.5, color: C.body, width: w });
    y += panelH + 10;
  }

  // ------------------------------------------------------------ propagation
  sectionTitle(B.propagation);
  {
    const cols = [
      { header: B.colStep, w: 150 },
      { header: B.colDetail, w: CW - 150 },
    ];
    const rows = brief.propagation.map((s) => ({
      cells: [
        [line(s.label, { font: BOLD, size: 9, color: s.breached ? C.vermilion : C.ink })],
        [line(s.detail, { size: 9, color: s.breached ? C.vermilion : C.body })],
      ],
    }));
    drawTable(cols, rows);
    y += 4;
  }

  // ------------------------------------------------------------- freight
  if (brief.lane) {
    sectionTitle(B.freightImpact);
    const l = brief.lane;
    ensureSpace(40);
    const colW = CW / 2;
    text(B.baseline, MARGIN, y, { size: 8.5, font: BOLD, color: C.muted, width: colW });
    text(B.withDisruption, MARGIN + colW, y, { size: 8.5, font: BOLD, color: C.muted, width: colW });
    y += 12;
    text(usdPerTon(l.baseline_rate_usd_per_ton), MARGIN, y, { size: 14, font: BOLD, color: C.ink, width: colW });
    text(usdPerTon(l.adjusted_rate_usd_per_ton), MARGIN + colW, y, { size: 14, font: BOLD, color: C.vermilion, width: colW });
    y += 20;
    y +=
      text(
        `${signedUsdPerTon(l.delta_usd_per_ton)} per tonne \u00b7 ${l.total_impact_usd != null ? `${l.total_impact_usd >= 0 ? "+" : "-"}$${Math.abs(Math.round(l.total_impact_usd)).toLocaleString("en-US")}` : "-"} total on this parcel.`,
        MARGIN,
        y,
        { size: 9.5, color: C.body }
      ) + 6;
  } else if (brief.reasons.some((r) => r.includes("priced in this brief"))) {
    sectionTitle(B.freightImpact);
    ensureSpace(16);
    y += text("No loading port, discharge port and commodity were all given, so freight-rate impact is not shown.", MARGIN, y, { size: 9, color: C.muted }) + 4;
  }

  // --------------------------------------------------------- wait vs divert
  if (brief.decision) {
    sectionTitle(B.waitVsDivert);
    const { wait, alternative } = brief.decision;
    const cols = [
      { header: B.colOption, w: CW - 95 - 80 - 90 - 85 },
      { header: B.colExpectedDelay, w: 95, align: "right" },
      { header: B.colFreight, w: 80, align: "right" },
      { header: "$ on this cargo", w: 90, align: "right" },
      { header: B.colDistance, w: 85, align: "right" },
    ];
    const rows = [
      {
        cells: [
          [line(B.wait, { font: BOLD, size: 9 }), line(wait.port, { size: 8.5, color: C.muted })],
          [line(`+${days(wait.expected_delay_days)}`, { size: 9 })],
          [line(wait.freight_delta_usd_per_ton == null ? "-" : signedUsdPerTon(wait.freight_delta_usd_per_ton), { size: 9 })],
          [line(signedUsdCompact(wait.freight_impact_usd), { size: 9, font: BOLD })],
          [line("-", { size: 9, color: C.muted })],
        ],
        fill: brief.call.kind === "wait" ? C.tealTint : undefined,
      },
    ];
    if (alternative) {
      rows.push({
        cells: [
          [line(B.divert, { font: BOLD, size: 9 }), line(alternative.port, { size: 8.5, color: C.muted })],
          [line(`+${days(alternative.expected_delay_days)}`, { size: 9 })],
          [line(alternative.freight_delta_usd_per_ton == null ? "-" : signedUsdPerTon(alternative.freight_delta_usd_per_ton), { size: 9 })],
          [line(signedUsdCompact(alternative.freight_impact_usd), { size: 9, font: BOLD })],
          [line(alternative.distance_from_disrupted_port_nm == null ? "-" : `${Math.round(alternative.distance_from_disrupted_port_nm)} nm`, { size: 9 })],
        ],
        fill: brief.call.kind === "divert" ? C.vermilionTint : undefined,
      });
    } else {
      rows.push({
        cells: [[line("No vessel-feasible alternative found for this cargo.", { size: 9, color: C.muted })], [], [], [], []],
      });
    }
    drawTable(cols, rows);
    y += 4;
  }

  // ------------------------------------------------------------------ why
  if (brief.reasons.length) {
    sectionTitle(B.why);
    bullets(brief.reasons.slice(0, 5));
  }

  // --------------------------------------------------- other alternatives
  if (brief.alternatives && brief.alternatives.options.length) {
    sectionTitle(B.alternativePorts);
    ensureSpace(14);
    y += text(brief.alternatives.recommendation, MARGIN, y, { size: 9, color: C.muted, lineGap: 1 }) + 4;
    const cols = [
      { header: "Rank / Port", w: 220 },
      { header: "Delay", w: (CW - 220) / 2, align: "right" },
      { header: "Freight vs. baseline", w: (CW - 220) / 2, align: "right" },
    ];
    const rows = brief.alternatives.options.map((o) => ({
      cells: [
        [line(`${o.rank}. ${o.port}`, { font: BOLD, size: 9 })],
        [line(o.delay?.total_days != null ? `${Number(o.delay.total_days).toFixed(1)}d` : "-", { size: 9 })],
        [line(o.freight?.delta_usd_per_ton == null ? "-" : signedUsdPerTon(o.freight.delta_usd_per_ton), { size: 9 })],
      ],
    }));
    drawTable(cols, rows);
    y += 4;
  }

  // ------------------------------------------------------------------ notes
  if (brief.notes.length) {
    sectionTitle(B.notes);
    bullets(brief.notes, { color: C.amber, size: 8.5 });
  }

  // ---------------------------------------------------------------- limits
  sectionTitle(B.limits);
  bullets(brief.assumptions, { size: 7.5, color: C.muted, gap: 3 });

  // ---------------------------------------------------------------- footer
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
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
 * @param {object} brief  output of buildDisruptionBrief()
 * @param {{ PDFDocument?: Function }} [deps]  injectable for tests
 * @returns {Promise<Buffer>}
 */
function renderDisruptionBriefPdf(brief, { PDFDocument } = {}) {
  const PDF = PDFDocument || require("pdfkit");
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDF({
        size: "A4",
        margin: MARGIN,
        bufferPages: true,
        info: {
          Title: `Disruption Decision Brief - ${brief.event.label || "Disruption"}, ${brief.port}`,
          Author: "FreightSight AI",
          Subject: brief.call.headline,
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

module.exports = { renderDisruptionBriefPdf };
