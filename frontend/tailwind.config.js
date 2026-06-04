/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bgDark: "#0a1929",
        bgPanel: "#0f2238",
        bgPanel2: "#142a44",
        teal: "#0d9488",
        tealDeep: "#115e59",
        amber: "#f59e0b",
        textMain: "#e6edf3",
        textSub: "#8b949e",
        border: "#1f3a5f",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
