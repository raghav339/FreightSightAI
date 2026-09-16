import { useEffect, useRef } from "react";

/*
 * Dependency-free 3D naval wireframe renderer.
 * It uses a perspective projection from XYZ -> canvas coordinates, so the
 * signature hull is an actual animated 3D line model without requiring WebGL
 * packages in the production bundle.
 */
export default function HullLines({ className = "" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const css = getComputedStyle(document.documentElement);
    const parseRGB = (name, fallback) => {
      const raw = css.getPropertyValue(name).trim();
      if (!raw) return fallback;
      return `rgb(${raw.replace(/\s+/g, ",")})`;
    };
    const ink = parseRGB("--c-ink", "rgb(28,49,68)");
    const inkSoft = parseRGB("--c-ink-soft", "rgb(92,116,136)");
    const accent = parseRGB("--c-vermilion", "rgb(180,74,46)");

    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let width = 1;
    let height = 1;
    let raf = 0;
    let time = 0;
    let last = performance.now();
    let reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    const resize = () => {
      width = Math.max(1, host.clientWidth);
      height = Math.max(1, host.clientHeight);
      canvas.width = Math.round(width * DPR);
      canvas.height = Math.round(height * DPR);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const onPointerMove = (e) => {
      const r = host.getBoundingClientRect();
      pointer.tx = ((e.clientX - r.left) / Math.max(1, r.width) - 0.5) * 2;
      pointer.ty = ((e.clientY - r.top) / Math.max(1, r.height) - 0.5) * 2;
    };
    host.addEventListener("pointermove", onPointerMove);

    const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
    const rotate = (p, yaw, pitch, roll) => {
      let { x, y, z } = p;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const x1 = x * cy - z * sy;
      const z1 = x * sy + z * cy;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const x3 = x1 * cr - y2 * sr;
      const y3 = x1 * sr + y2 * cr;
      return { x: x3, y: y3, z: z2 };
    };
    const project = (p, scale) => {
      const camera = 9.6;
      const depth = camera - p.z;
      const f = scale * camera / Math.max(2.2, depth);
      return { x: width * 0.515 + p.x * f, y: height * 0.56 - p.y * f, d: depth };
    };

    const beamAt = (t) => {
      if (t < 0.16) return 0.72 * (0.6 + (t / 0.16) * 0.4);
      if (t < 0.7) return 0.72;
      const k = (t - 0.7) / 0.3;
      return 0.72 * Math.max(0.04, 1 - Math.pow(k, 1.7));
    };

    const hullFrames = [];
    const L = 6.6;
    const depth = 0.82;
    for (let i = 0; i < 17; i += 1) {
      const t = i / 16;
      const x = -L / 2 + t * L;
      const b = beamAt(t);
      hullFrames.push([
        { x, y: 0.16, z: -b },
        { x, y: -0.2, z: -b },
        { x, y: -depth, z: -b * 0.74 },
        { x, y: -depth, z: b * 0.74 },
        { x, y: -0.2, z: b },
        { x, y: 0.16, z: b },
      ]);
    }

    const lines = [];
    for (let i = 0; i < hullFrames.length; i += 1) lines.push({ pts: hullFrames[i], kind: i % 4 === 0 ? "hull" : "long" });
    for (let j = 0; j < 6; j += 1) lines.push({ pts: hullFrames.map((s) => s[j]), kind: j === 0 || j === 5 ? "hull" : "long" });
    lines.push({
      pts: [{ x: -3.3, y: -0.45, z: 0 }, { x: -3.1, y: -0.82, z: 0 }, { x: 2.7, y: -0.82, z: 0 }, { x: 3.3, y: -0.15, z: 0 }, { x: 3.3, y: 0.16, z: 0 }],
      kind: "hull",
    });

    for (const sign of [-1, 1]) {
      lines.push({ pts: hullFrames.map((s, i) => ({ x: s[0].x, y: -0.13, z: sign * beamAt(i / 16) * 0.71 })), kind: "accent" });
    }

    // Deck houses / bulkheads.
    lines.push({ pts: box(1.0, 0.6, 1.45, -2.25, 0.5), kind: "detail" });
    lines.push({ pts: box(0.72, 0.22, 1.12, -2.25, 0.92), kind: "detail" });
    for (let i = 0; i < 5; i += 1) lines.push({ pts: box(0.58, 0.12, 1.24, 2.15 - i * 0.92, 0.18), kind: "detail" });

    const pillars = [1.6, 0.7, -0.2];
    pillars.forEach((x) => lines.push({ pts: [{ x, y: 0.16, z: 0 }, { x, y: 0.95, z: 0 }, { x: x + 0.82, y: 0.42, z: 0 }], kind: "detail" }));

    const funnelCenter = { x: -2.82, y: 1.32, z: 0 };
    const funnel = circle(0.18, 0.5, funnelCenter);
    lines.push({ pts: funnel, kind: "accent" });

    const drawLine = (pts, yaw, pitch, roll, opts) => {
      const projected = pts.map((p) => project(rotate({ ...p }, yaw, pitch, roll), Math.min(width, height) * 0.11));
      ctx.beginPath();
      projected.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.strokeStyle = opts.color;
      ctx.globalAlpha = opts.alpha;
      ctx.lineWidth = opts.width;
      ctx.stroke();
    };

    const drawSea = (yaw, pitch, roll) => {
      ctx.save();
      ctx.globalAlpha = 0.18;
      for (let row = 0; row < 13; row += 1) {
        const z = -4.8 + row * 0.8;
        const points = [];
        for (let i = 0; i <= 52; i += 1) {
          const x = -8.7 + i / 52 * 17.4;
          const swell = Math.sin(x * 0.55 + time * 0.0011) * 0.08 + Math.cos(z * 0.6 - time * 0.0008) * 0.05;
          points.push({ x, y: -0.15 + swell, z });
        }
        drawLine(points, yaw, pitch, roll, { color: inkSoft, alpha: 0.8, width: 0.7 });
      }
      ctx.restore();
    };

    const render = (now) => {
      const dt = now - last;
      last = now;
      if (!reduced) time += dt;

      pointer.x += (pointer.tx - pointer.x) * 0.035;
      pointer.y += (pointer.ty - pointer.y) * 0.035;
      const yaw = reduced ? -0.58 : -0.48 + time * 0.00016 + pointer.x * 0.12;
      const pitch = 0.23 - pointer.y * 0.07;
      const roll = reduced ? 0.02 : Math.sin(time * 0.0009) * 0.016;

      ctx.clearRect(0, 0, width, height);
      drawSea(yaw, pitch, roll);

      // Furthest lines first for a convincing wireframe depth ordering.
      const drawable = lines.map((line) => ({ ...line, z: line.pts.reduce((s, p) => s + rotate(p, yaw, pitch, roll).z, 0) / line.pts.length })).sort((a, b) => a.z - b.z);
      drawable.forEach((line) => {
        const options = line.kind === "accent"
          ? { color: accent, alpha: 0.9, width: 1.05 }
          : line.kind === "hull"
            ? { color: ink, alpha: 0.78, width: 1.0 }
            : line.kind === "detail"
              ? { color: ink, alpha: 0.52, width: 0.8 }
              : { color: inkSoft, alpha: 0.54, width: 0.72 };
        drawLine(line.pts, yaw, pitch, roll, options);
      });

      if (!reduced) raf = requestAnimationFrame(render);
    };

    render(performance.now());

    const onMotionPreference = (e) => { reduced = e.matches; if (reduced) render(performance.now()); else { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); } };
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    media.addEventListener?.("change", onMotionPreference);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("pointermove", onPointerMove);
      media.removeEventListener?.("change", onMotionPreference);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

function box(w, h, d, cx, cy) {
  const x = w / 2, z = d / 2;
  return [
    { x: cx - x, y: cy - h / 2, z: -z }, { x: cx + x, y: cy - h / 2, z: -z }, { x: cx + x, y: cy + h / 2, z: -z }, { x: cx - x, y: cy + h / 2, z: -z }, { x: cx - x, y: cy - h / 2, z: -z },
    { x: cx - x, y: cy - h / 2, z: z }, { x: cx + x, y: cy - h / 2, z: z }, { x: cx + x, y: cy + h / 2, z: z }, { x: cx - x, y: cy + h / 2, z: z }, { x: cx - x, y: cy - h / 2, z: z },
    { x: cx + x, y: cy - h / 2, z: -z }, { x: cx + x, y: cy - h / 2, z: z }, { x: cx + x, y: cy + h / 2, z: z }, { x: cx + x, y: cy + h / 2, z: -z },
    { x: cx - x, y: cy - h / 2, z: -z }, { x: cx - x, y: cy - h / 2, z: z }, { x: cx - x, y: cy + h / 2, z: z }, { x: cx - x, y: cy + h / 2, z: -z },
  ];
}

function circle(radius, h, center) {
  const pts = [];
  for (let i = 0; i <= 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    pts.push({ x: center.x + Math.cos(a) * radius, y: center.y + h / 2, z: center.z + Math.sin(a) * radius });
  }
  for (let i = 16; i >= 0; i -= 1) {
    const a = (i / 16) * Math.PI * 2;
    pts.push({ x: center.x + Math.cos(a) * radius, y: center.y - h / 2, z: center.z + Math.sin(a) * radius });
  }
  return pts;
}
