import type { Config } from "tailwindcss";

const config: Config = {
  // ./components was MISSING until 2026-08-11, so any utility class used ONLY
  // inside ui/components/*.tsx was never generated. Every component there had
  // been surviving on classes that happened to also appear under ./app - which
  // is invisible until you move markup into a component and its styling
  // silently disappears. That is exactly what happened to the CareerOps logo
  // mark when it moved from page.tsx into SiteHeader.tsx: h-8 w-8 rounded-lg
  // bg-gradient-to-br from-indigo-400 to-violet-500 stopped being emitted and
  // the mark rendered as a bare letter "C".
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      }
    }
  },
  plugins: []
};

export default config;
