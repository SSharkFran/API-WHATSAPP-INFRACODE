import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import { ToastProvider } from "../components/ui/Toast";
import "./globals.css";

const displayFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["300", "400", "500", "600", "700"]
});

const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"]
});

export const metadata: Metadata = {
  title: "InfraCode Panel",
  description: "Painel enterprise para operação multi-instância do WhatsApp"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body
        className={`${displayFont.variable} ${monoFont.variable} antialiased`}
        style={{ fontFamily: "var(--font-display)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
      >
        <ToastProvider>
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}


//ds