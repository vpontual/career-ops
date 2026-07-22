import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Career Ops",
  description: "Personal job pipeline reader"
};

// bg-slate-950 on the body ensures the sticky header has a consistent backdrop
// when content scrolls beneath it (per VP design system: surface = #0f172a,
// which is slate-950's neighbor — using -950 here matches the page bg
// inherited from existing globals.css).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100">{children}</body>
    </html>
  );
}
