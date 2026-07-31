import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";

  return {
    metadataBase: host ? new URL(`${protocol}://${host}`) : undefined,
    title: "小络助手 — 一句话完成跨系统业务办理",
    description: "面向企业员工的智能业务办理入口：理解需求、连接现有系统、确认关键内容并返回可追踪结果。",
    icons: {
      icon: "/xiaoluo-logo.png",
      shortcut: "/xiaoluo-logo.png",
    },
    openGraph: {
      title: "小络助手",
      description: "一句话完成跨系统业务办理",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "小络助手 — 一句话完成跨系统业务办理" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "小络助手",
      description: "一句话完成跨系统业务办理",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
