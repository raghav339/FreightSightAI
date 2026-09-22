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
      boxShadow: {
        glow: "0 0 0 1px rgb(var(--c-vermilion) / .22), 0 8px 24px -10px rgb(var(--c-vermilion) / .22)",
      },
      keyframes: {
        "ping-slow": {
          "75%, 100%": { transform: "scale(2.4)", opacity: "0" },
        },
      },
      animation: {
        "ping-slow": "ping-slow 2.6s cubic-bezier(0, 0, 0.2, 1) infinite",
      },
    },
  },
  plugins: [],
};
