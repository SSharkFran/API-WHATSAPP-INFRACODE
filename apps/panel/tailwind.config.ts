import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      screens: {
        xs: "520px",
        ms: "820px"
      },
      colors: {
        surface: "var(--surface)",
        ink: "var(--ink)",
        accent: "var(--accent)",
        sand: "var(--sand)"
      },
      boxShadow: {
        panel: "0 24px 80px rgba(16, 24, 40, 0.12)"
      },
      backgroundImage: {
        "grid-fade":
          "linear-gradient(rgba(15,23,42,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.08) 1px, transparent 1px)"
      }
    }
  },
  plugins: []
};

export default config;
