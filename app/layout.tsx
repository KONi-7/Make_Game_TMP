import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "課題・締め切り管理",
  description: "学生向けの課題・締め切り管理アプリ",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
