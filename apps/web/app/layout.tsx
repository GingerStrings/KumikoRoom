import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "KumikoRoom",
  description: "A local-first music and creative workspace.",
  icons: {
    icon: "/icon.svg"
  }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
