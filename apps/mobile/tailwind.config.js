/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "bg-primary": "#18181b",
        "bg-secondary": "#27272a",
        "bg-tertiary": "#3f3f46",
        "fg-primary": "#f4f4f5",
        "fg-secondary": "#a1a1aa",
        "fg-muted": "#71717a",
        accent: "#6d28d9",
        "accent-hover": "#7c3aed",
        border: "#3f3f46",
      },
    },
  },
  plugins: [],
};