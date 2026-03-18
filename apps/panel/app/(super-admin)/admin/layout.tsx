"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  CreditCard,
  Settings,
  X
} from "lucide-react";
import { Topbar } from "../../../components/layout/Topbar";

export const dynamic = "force-dynamic";

const navItems = [
  { href: "/admin",          label: "Overview",  icon: LayoutDashboard },
  { href: "/admin/tenants",  label: "Tenants",   icon: Users },
  { href: "/admin/billing",  label: "Billing",   icon: CreditCard },
  { href: "/admin/settings", label: "Settings",  icon: Settings }
];

function AdminSidebar({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();
  return (
    <aside className="flex h-full flex-col bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] pt-4 pb-4 px-3 w-[220px]">
      {/* Logo row */}
      <div className="flex items-center justify-between px-2 mb-6">
        <div className="brand-chip">
          <div className="brand-mark">
            <span className="brand-mark__glyph">ADM</span>
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
      <nav className="flex-1 flex flex-col gap-0.5" aria-label="Navegação admin">
        {navItems.map((item, i) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/admin" && pathname.startsWith(item.href));
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

      {/* Super badge */}
      <div className="mt-4 px-2 border-t border-[var(--border-subtle)] pt-4">
        <div className="flex items-center gap-2 px-1">
          <div className="h-1.5 w-1.5 rounded-full bg-[var(--accent-blue)] pulse-dot flex-shrink-0" aria-hidden="true" />
          <span className="text-xs text-[var(--text-tertiary)] font-mono tracking-wide uppercase">
            Super Admin
          </span>
        </div>
      </div>
    </aside>
  );
}

function AdminLayoutClient({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  const breadcrumb = (() => {
    const segments = pathname.replace("/admin", "").split("/").filter(Boolean);
    if (segments.length === 0) return ["Overview"];
    return segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  })();

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] flex">
      {/* Desktop sidebar */}
      <div className="hidden md:block h-screen sticky top-0 flex-shrink-0">
        <AdminSidebar />
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
        <AdminSidebar onClose={() => setDrawerOpen(false)} />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          breadcrumb={["Admin", ...breadcrumb]}
          onMenuClick={() => setDrawerOpen(true)}
        />
        <main className="flex-1 p-5 sm:p-6 animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function SuperAdminLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <AdminLayoutClient>{children}</AdminLayoutClient>;
}
