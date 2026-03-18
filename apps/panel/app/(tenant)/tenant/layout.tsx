"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Server,
  Bot,
  Key,
  Rocket,
  Menu,
  X
} from "lucide-react";
import { Topbar } from "../../../components/layout/Topbar";

export const dynamic = "force-dynamic";

const navItems = [
  { href: "/tenant",              label: "Dashboard",  icon: LayoutDashboard },
  { href: "/tenant/instances",   label: "Instâncias", icon: Server },
  { href: "/tenant/chatbot",     label: "Chatbot",    icon: Bot },
  { href: "/tenant/api-keys",    label: "API Keys",   icon: Key },
  { href: "/tenant/onboarding",  label: "Onboarding", icon: Rocket }
];

function TenantSidebar({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();
  return (
    <aside className="flex h-full flex-col bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] pt-4 pb-4 px-3 w-[220px]">
      {/* Logo row */}
      <div className="flex items-center justify-between px-2 mb-6">
        <div className="brand-chip">
          <div className="brand-mark">
            <span className="brand-mark__glyph">IC</span>
            <span className="brand-mark__text text-base font-semibold text-[var(--text-primary)]">
              <strong>Infra</strong><strong>Code</strong>
            </span>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Fechar menu"
            className="md:hidden h-7 w-7 flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 flex flex-col gap-0.5" aria-label="Navegação do tenant">
        {navItems.map((item, i) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/tenant" && pathname.startsWith(item.href));
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              style={{ animationDelay: `${i * 50}ms` }}
              className={[
                "flex items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-sm font-medium",
                "transition-colors duration-150 cursor-pointer animate-slide-in stagger-item",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]",
                isActive
                  ? "bg-[var(--bg-active)] text-[var(--text-primary)] border-l-2 border-[var(--accent-blue)] pl-[10px]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              ].join(" ")}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon aria-hidden="true" className="h-4 w-4 flex-shrink-0" strokeWidth={isActive ? 2 : 1.5} />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

function TenantLayoutClient({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  const breadcrumb = (() => {
    const segments = pathname.replace("/tenant", "").split("/").filter(Boolean);
    if (segments.length === 0) return ["Dashboard"];
    return segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  })();

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] flex">
      {/* Desktop sidebar */}
      <div className="hidden md:block h-screen sticky top-0 flex-shrink-0">
        <TenantSidebar />
      </div>

      {/* Mobile overlay + drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-[25]"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      <div
        className={[
          "fixed inset-y-0 left-0 z-30 transition-transform duration-[var(--transition-slow)] md:hidden",
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        ].join(" ")}
      >
        <TenantSidebar onClose={() => setDrawerOpen(false)} />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          breadcrumb={["Tenant", ...breadcrumb]}
          onMenuClick={() => setDrawerOpen(true)}
        />
        <main className="flex-1 p-5 sm:p-6 animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function TenantLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <TenantLayoutClient>{children}</TenantLayoutClient>;
}
