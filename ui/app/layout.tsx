import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Career Ops",
  description: "Personal job pipeline reader"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
