import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Platform Admin | VPS Server Management",
  description: "Minimal administration panel for VPS infrastructure services.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
