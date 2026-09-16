import { useEffect, useRef } from "react";

/*
 * Crisp dependency-free 3D naval wireframe renderer.
 *
 * The model is projected in 2D canvas space instead of using WebGL so it
 * remains lightweight. The renderer is deliberately high-contrast: the hull
 * uses dense technical-ink strokes, while only the background swell contours
 * are allowed to recede into the parchment.
 */
export default function HullLines({ className = "" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const root = getComputedStyle(document.documentElement);
    const parseRGB = (name, fallback) => {
      const raw = root.getPropertyValue(name).trim();
      if (!raw) return fallback;
      return `rgb(${raw.replace(/\s+/g, ",")})`;
    };

    const ink = parseRGB("--c-ink", "rgb(28,49,68)");
    const inkSoft = parseRGB("--c-ink-soft", "rgb(92,116,136)");
    const accent = parseRGB("--c-vermilion", "rgb(180,74,46)");
    const rule = parseRGB("--c-rule", "rgb(126,108,76)");

    let width = 1;
    let height = 1;
    let raf = 0;
    let time = 0;
    let last = performance.now();
    let reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    const resize = () => {
      width = Math.max(1, Math.round(host.clientWidth));
      height = Math.max(1, Math.round(host.clientHeight));
      dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      // Draw in CSS-pixel coordinates while retaining the monitor's native
      // resolution. This is the main anti-blur step for thin blueprint lines.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const onPointerMove = (event) => {
      const rect = host.getBoundingClientRect();
      pointer.tx = ((event.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2;
      pointer.ty = ((event.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2;
    };

    const onPointerLeave = () => {
      pointer.tx = 0;
      pointer.ty = 0;
    };

    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerleave", onPointerLeave);

    const rotate = (point, yaw, pitch, roll) => {
      let { x, y, z } = point;

      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const x1 = x * cy - z * sy;
      const z1 = x * sy + z * cy;

      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;

      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      const x3 = x1 * cr - y2 * sr;
      const y3 = x1 * sr + y2 * cr;

      return { x: x3, y: y3, z: z2 };
    };

    const project = (point, scale) => {
      const camera = 9.6;
      const depth = camera - point.z;
      const focal = scale * camera / Math.max(2.4, depth);
      return {
        x: width * 0.515 + point.x * focal,
        y: height * 0.56 - point.y * focal,
        d: depth,
      };
    };

    const beamAt = (t) => {
      if (t < 0.16) return 0.72 * (0.6 + (t / 0.16) * 0.4);
      if (t < 0.70) return 0.72;
      const k = (t - 0.70) / 0.30;
      return 0.72 * Math.max(0.04, 1 - Math.pow(k, 1.7));
    };

    const hullFrames = [];
    const length = 6.6;
    const depth = 0.82;

    for (let i = 0; i < 17; i += 1) {
      const t = i / 16;
      const x = -length / 2 + t * length;
      const beam = beamAt(t);
      hullFrames.push([
        { x, y: 0.16, z: -beam },
        { x, y: -0.20, z: -beam },
        { x, y: -depth, z: -beam * 0.74 },
        { x, y: -depth, z: beam * 0.74 },
        { x, y: -0.20, z: beam },
        { x, y: 0.16, z: beam },
      ]);
    }

    const lines = [];

    // Transverse frames.
    for (let i = 0; i < hullFrames.length; i += 1) {
      lines.push({
        pts: hullFrames[i],
        kind: i % 4 === 0 ? "hull-strong" : "hull",
      });
    }

    // Longitudinals.
    for (let j = 0; j < 6; j += 1) {
      lines.push({
        pts: hullFrames.map((section) => section[j]),
        kind: j === 0 || j === 5 ? "hull-strong" : "long",
      });
    }

    // Keel / bow / stern profile.
    lines.push({
      pts: [
        { x: -3.3, y: -0.45, z: 0 },
        { x: -3.1, y: -0.82, z: 0 },
        { x: 2.7, y: -0.82, z: 0 },
        { x: 3.3, y: -0.15, z: 0 },
        { x: 3.3, y: 0.16, z: 0 },
      ],
      kind: "hull-strong",
    });

    // Vermilion waterline.
    for (const sign of [-1, 1]) {
      lines.push({
        pts: hullFrames.map((section, index) => ({
          x: section[0].x,
          y: -0.13,
          z: sign * beamAt(index / 16) * 0.71,
        })),
        kind: "accent",
      });
    }

    // Superstructure / holds.
    lines.push({ pts: box(1.0, 0.6, 1.45, -2.25, 0.5), kind: "detail" });
    lines.push({ pts: box(0.72, 0.22, 1.12, -2.25, 0.92), kind: "detail" });
    for (let i = 0; i < 5; i += 1) {
      lines.push({ pts: box(0.58, 0.12, 1.24, 2.15 - i * 0.92, 0.18), kind: "detail" });
    }

    const pillars = [1.6, 0.7, -0.2];
    pillars.forEach((x) => {
      lines.push({
        pts: [
          { x, y: 0.16, z: 0 },
          { x, y: 0.95, z: 0 },
          { x: x + 0.82, y: 0.42, z: 0 },
        ],
        kind: "detail",
      });
    });

    const funnelCenter = { x: -2.82, y: 1.32, z: 0 };
    lines.push({ pts: circle(0.18, 0.5, funnelCenter), kind: "accent-detail" });

    const drawLine = (points, yaw, pitch, roll, style) => {
      if (!points.length) return;

      const projected = points.map((point) =>
        project(rotate(point, yaw, pitch, roll), Math.min(width, height) * 0.11),
      );

      ctx.beginPath();
      projected.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });

      ctx.globalAlpha = style.alpha;
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
      ctx.lineCap = "butt";
      ctx.lineJoin = "miter";
      ctx.stroke();
    };

    const drawSea = (yaw, pitch, roll) => {
      // Fewer, lighter swell lines so they frame the ship rather than veil it.
      const rows = 9;
      for (let row = 0; row < rows; row += 1) {
        const z = -4.8 + row * 1.0;
        const points = [];

        for (let i = 0; i <= 56; i += 1) {
          const x = -8.7 + (i / 56) * 17.4;
          const swell =
            Math.sin(x * 0.55 + time * 0.0011) * 0.065 +
            Math.cos(z * 0.6 - time * 0.0008) * 0.035;
          points.push({ x, y: -0.15 + swell, z });
        }

        drawLine(points, yaw, pitch, roll, {
          color: inkSoft,
          alpha: 0.24,
          width: 0.72,
        });
      }
    };

    const styles = {
      "hull-strong": { color: ink, alpha: 0.92, width: 1.18 },
      hull: { color: ink, alpha: 0.82, width: 1.02 },
      long: { color: inkSoft, alpha: 0.68, width: 0.86 },
      detail: { color: ink, alpha: 0.62, width: 0.90 },
      accent: { color: accent, alpha: 0.96, width: 1.28 },
      "accent-detail": { color: accent, alpha: 0.92, width: 1.02 },
    };

    const render = (now) => {
      const dt = Math.min(50, now - last);
      last = now;
      if (!reduced) time += dt;

      pointer.x += (pointer.tx - pointer.x) * 0.055;
      pointer.y += (pointer.ty - pointer.y) * 0.055;

      const yaw = reduced
        ? -0.50 + pointer.x * 0.06
        : -0.44 + time * 0.00013 + pointer.x * 0.13;
      const pitch = 0.18 - pointer.y * 0.08;
      const roll = reduced ? 0.012 : Math.sin(time * 0.0009) * 0.012;

      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";

      drawSea(yaw, pitch, roll);

      // Painter's order gives the wireframe a convincing but restrained depth.
      const drawable = lines
        .map((line) => ({
          ...line,
          z:
            line.pts.reduce(
              (sum, point) => sum + rotate(point, yaw, pitch, roll).z,
              0,
            ) / line.pts.length,
        }))
        .sort((a, b) => a.z - b.z);

      drawable.forEach((line) => drawLine(line.pts, yaw, pitch, roll, styles[line.kind]));

      ctx.globalAlpha = 1;
      if (!reduced) raf = requestAnimationFrame(render);
    };

    render(performance.now());

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotionPreference = (event) => {
      reduced = event.matches;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    };

    media.addEventListener?.("change", onMotionPreference);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerLeave);
      media.removeEventListener?.("change", onMotionPreference);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`hull-lines-canvas ${className}`.trim()}
      aria-hidden="true"
    />
  );
}

function box(w, h, d, cx, cy) {
  const x = w / 2;
  const z = d / 2;
  return [
    { x: cx - x, y: cy - h / 2, z: -z },
    { x: cx + x, y: cy - h / 2, z: -z },
    { x: cx + x, y: cy + h / 2, z: -z },
    { x: cx - x, y: cy + h / 2, z: -z },
    { x: cx - x, y: cy - h / 2, z: -z },
    { x: cx - x, y: cy - h / 2, z },
    { x: cx + x, y: cy - h / 2, z },
    { x: cx + x, y: cy + h / 2, z },
    { x: cx - x, y: cy + h / 2, z },
    { x: cx - x, y: cy - h / 2, z },
    { x: cx + x, y: cy - h / 2, z: -z },
    { x: cx + x, y: cy - h / 2, z },
    { x: cx + x, y: cy + h / 2, z },
    { x: cx + x, y: cy + h / 2, z: -z },
    { x: cx - x, y: cy - h / 2, z: -z },
    { x: cx - x, y: cy - h / 2, z },
    { x: cx - x, y: cy + h / 2, z },
    { x: cx - x, y: cy + h / 2, z: -z },
  ];
}

function circle(radius, h, center) {
  const points = [];
  for (let i = 0; i <= 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    points.push({
      x: center.x + Math.cos(a) * radius,
      y: center.y + h / 2,
      z: center.z + Math.sin(a) * radius,
    });
  }
  for (let i = 16; i >= 0; i -= 1) {
    const a = (i / 16) * Math.PI * 2;
    points.push({
      x: center.x + Math.cos(a) * radius,
      y: center.y - h / 2,
      z: center.z + Math.sin(a) * radius,
    });
  }
  return points;
}
