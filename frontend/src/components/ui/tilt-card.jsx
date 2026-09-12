// A lightweight, dependency-free 3D tilt effect driven by pointer position.
// Respects prefers-reduced-motion by skipping the transform entirely.
import { useRef } from "react";
import { cn } from "../../lib/utils.js";

const REDUCE_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function TiltCard({ className, children, maxTilt = 6, glare = true, ...props }) {
  const ref = useRef(null);
  const glareRef = useRef(null);

  function handleMove(e) {
    if (REDUCE_MOTION || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const rotateY = (px - 0.5) * maxTilt * 2;
    const rotateX = (0.5 - py) * maxTilt * 2;
    ref.current.style.transform = `perspective(900px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateZ(0)`;
    if (glareRef.current) {
      glareRef.current.style.background = `radial-gradient(circle at ${px * 100}% ${py * 100}%, rgba(124,240,228,0.14), transparent 60%)`;
    }
  }

  function handleLeave() {
    if (!ref.current) return;
    ref.current.style.transform = "perspective(900px) rotateX(0deg) rotateY(0deg) translateZ(0)";
    if (glareRef.current) glareRef.current.style.background = "transparent";
  }

  return (
    <div
      ref={ref}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      className={cn("relative transition-transform duration-200 ease-out will-change-transform", className)}
      style={{ transformStyle: "preserve-3d" }}
      {...props}
    >
      {glare && (
        <div
          ref={glareRef}
          className="pointer-events-none absolute inset-0 rounded-2xl transition-[background] duration-150"
        />
      )}
      {children}
    </div>
  );
}