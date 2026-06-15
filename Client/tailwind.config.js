/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', '"Geist Sans"', 'ui-sans-serif', 'system-ui'],
        mono: ['"JetBrains Mono"', '"Geist Mono"', 'ui-monospace', 'SFMono-Regular'],
      },
      colors: {
        void: "#0B0B0F",
        obsidian: "#12121A",
        graphite: "#1F1F2E",
        plasma: "#8B5CF6",
        ion: "#22D3EE",
      },
      boxShadow: {
        tactile: "inset 0 1px 0 rgba(255,255,255,0.06), 0 20px 60px rgba(0,0,0,0.32)",
        glow: "0 0 0 1px rgba(139,92,246,0.16), 0 0 44px rgba(34,211,238,0.12)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        terminalCursor: {
          "0%, 45%": { opacity: "1" },
          "46%, 100%": { opacity: "0" },
        },
      },
      animation: {
        shimmer: "shimmer 2.2s linear infinite",
        cursor: "terminalCursor 1s steps(1) infinite",
      },
    },
  },
  plugins: [],
};
