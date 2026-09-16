/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        inksoft: "rgb(var(--c-ink-soft) / <alpha-value>)",
        paper: "rgb(var(--c-paper) / <alpha-value>)",
        parchment: "rgb(var(--c-parchment) / <alpha-value>)",
        sand: "rgb(var(--c-sand) / <alpha-value>)",
        rule: "rgb(var(--c-rule) / <alpha-value>)",
        vermilion: "rgb(var(--c-vermilion) / <alpha-value>)",
        brass: "rgb(var(--c-brass) / <alpha-value>)",
        kelp: "rgb(var(--c-kelp) / <alpha-value>)",
        hull: {
          950: "rgb(var(--c-paper) / <alpha-value>)",
          900: "rgb(var(--c-paper) / <alpha-value>)",
          800: "rgb(var(--c-parchment) / <alpha-value>)",
          700: "rgb(var(--c-parchment) / <alpha-value>)",
          600: "rgb(var(--c-sand) / <alpha-value>)",
          500: "rgb(var(--c-rule) / <alpha-value>)",
        },
        signal: { DEFAULT: "rgb(var(--c-vermilion) / <alpha-value>)", soft: "rgb(var(--c-vermilion) / .7)", dim: "rgb(var(--c-vermilion) / .35)" },
        amber: { DEFAULT: "rgb(var(--c-brass) / <alpha-value>)" },
        port: { DEFAULT: "rgb(var(--c-vermilion) / <alpha-value>)" },
        starboard: { DEFAULT: "rgb(var(--c-kelp) / <alpha-value>)" },
      },
      fontFamily: {
        display: ["Fraunces", "Georgia", "serif"],
        body: ["IBM Plex Sans", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
      backgroundImage: {
        "chart-grid": "repeating-linear-gradient(0deg, rgb(var(--c-rule) / .15) 0 1px, transparent 1px 34px), repeating-linear-gradient(90deg, rgb(var(--c-rule) / .15) 0 1px, transparent 1px 34px)",
        "radar-sweep": "conic-gradient(from 0deg, transparent 0deg, rgb(var(--c-kelp) / .25) 25deg, transparent 50deg)",
      },
      backgroundSize: { grid: "34px 34px" },
      boxShadow: {
        glow: "0 0 0 1px rgb(var(--c-vermilion) / .22), 0 8px 24px -10px rgb(var(--c-vermilion) / .22)",
        card: "0 1px 0 rgb(255 255 255 / .5) inset",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
