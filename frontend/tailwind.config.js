// frontend/tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.25rem",
    },
    extend: {
      colors: {
        // Bridge-console palette: deep ocean night + signal cyan accent
        hull: {
          950: "#050810",
          900: "#070B12",
          800: "#0D1420",
          700: "#131C2B",
          600: "#1B2536",
          500: "#28344A",
        },
        signal: {
          DEFAULT: "#22D3C4",
          soft: "#7CF0E4",
          dim: "#0F5F58",
        },
        amber: {
          DEFAULT: "#FFB020",
        },
        port: {
          // navigation-light red (port side)
          DEFAULT: "#FF5470",
        },
        starboard: {
          // navigation-light green (starboard side)
          DEFAULT: "#34D8A0",
        },
        paper: {
          50: "#F7F9FC",
          100: "#EEF2F8",
          200: "#E3E9F2",
        },
      },
      fontFamily: {
        display: ["'Space Grotesk'", "system-ui", "sans-serif"],
        body: ["'Inter'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      backgroundImage: {
        "chart-grid":
          "linear-gradient(rgba(124, 240, 228, 0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(124, 240, 228, 0.06) 1px, transparent 1px)",
        "radar-sweep":
          "conic-gradient(from 0deg, transparent 0deg, rgba(34, 211, 196, 0.25) 25deg, transparent 50deg)",
      },
      backgroundSize: {
        grid: "34px 34px",
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(34, 211, 196, 0.25), 0 8px 30px -4px rgba(34, 211, 196, 0.25)",
        "glow-lg": "0 0 0 1px rgba(34, 211, 196, 0.2), 0 24px 60px -12px rgba(34, 211, 196, 0.3)",
        card: "0 1px 0 rgba(255,255,255,0.03) inset, 0 10px 30px -10px rgba(0,0,0,0.6)",
      },
      keyframes: {
        "ping-slow": {
          "0%": { transform: "scale(1)", opacity: "0.9" },
          "75%, 100%": { transform: "scale(2.4)", opacity: "0" },
        },
        "dash-flow": {
          to: { strokeDashoffset: "-200" },
        },
        "sweep-spin": {
          to: { transform: "rotate(360deg)" },
        },
        rise: {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "ping-slow": "ping-slow 2.8s cubic-bezier(0,0,0.2,1) infinite",
        "dash-flow": "dash-flow 6s linear infinite",
        "sweep-spin": "sweep-spin 6s linear infinite",
        rise: "rise 0.5s cubic-bezier(0.16,1,0.3,1) both",
        "fade-in": "fade-in 0.4s ease both",
        shimmer: "shimmer 2.5s linear infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};