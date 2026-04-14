import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SeA Proxy Demo",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="bg-zinc-950 text-white">{children}</body>
    </html>
  );
}
