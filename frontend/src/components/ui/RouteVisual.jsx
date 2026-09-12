// The hero's signature moment: a shipping lane between two ports, an AIS-style
// pulse at each terminus, and a vessel gliding along the course. Built from
// the subject matter itself (freight routes) rather than a stock illustration.
import { motion } from "framer-motion";

export default function RouteVisual({ className }) {
  return (
    <svg
      viewBox="0 0 560 320"
      fill="none"
      className={className}
      role="img"
      aria-label="Animated shipping route between two ports"
    >
      <defs>
        <linearGradient id="routeLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#22D3C4" stopOpacity="0.15" />
          <stop offset="50%" stopColor="#22D3C4" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#22D3C4" stopOpacity="0.15" />
        </linearGradient>
        <radialGradient id="nodeGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#7CF0E4" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#7CF0E4" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* lat/long chart grid */}
      <g opacity="0.18" stroke="#7CF0E4" strokeWidth="0.6">
        {Array.from({ length: 8 }).map((_, i) => (
          <line key={`h${i}`} x1="0" y1={i * 40} x2="560" y2={i * 40} />
        ))}
        {Array.from({ length: 15 }).map((_, i) => (
          <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="320" />
        ))}
      </g>

      {/* course line, origin (Gladstone) -> destination (Visakhapatnam) */}
      <path
        id="course"
        d="M 70 230 C 160 130, 300 260, 420 100 S 500 60, 500 60"
        stroke="url(#routeLine)"
        strokeWidth="2"
        strokeDasharray="6 10"
        className="animate-dash-flow"
      />

      {/* origin node */}
      <circle cx="70" cy="230" r="26" fill="url(#nodeGlow)" />
      <circle cx="70" cy="230" r="5" fill="#7CF0E4" />
      <circle cx="70" cy="230" r="5" fill="#7CF0E4" className="animate-ping-slow" />
      <text x="70" y="256" textAnchor="middle" fontSize="11" fill="#8FA3B8" fontFamily="'JetBrains Mono', monospace">
        GLADSTONE
      </text>

      {/* destination node */}
      <circle cx="500" cy="60" r="26" fill="url(#nodeGlow)" />
      <circle cx="500" cy="60" r="5" fill="#22D3C4" />
      <circle cx="500" cy="60" r="5" fill="#22D3C4" className="animate-ping-slow" />
      <text x="500" y="40" textAnchor="middle" fontSize="11" fill="#8FA3B8" fontFamily="'JetBrains Mono', monospace">
        VISAKHAPATNAM
      </text>

      {/* vessel gliding along the course */}
      <motion.g
        initial={{ offsetDistance: "0%" }}
        animate={{ offsetDistance: "100%" }}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
        style={{ offsetPath: "path('M 70 230 C 160 130, 300 260, 420 100 S 500 60, 500 60')" }}
      >
        <g transform="translate(-7,-7)">
          <path
            d="M0 7 L14 7 L11 12 L3 12 Z M2 7 L2 2 L12 2 L12 7"
            fill="#FFB020"
            stroke="#0F1620"
            strokeWidth="0.6"
          />
        </g>
      </motion.g>
    </svg>
  );
}