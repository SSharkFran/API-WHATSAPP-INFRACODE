"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface SidebarProps {
  items: NavItem[];
  logo?: React.ReactNode;
  footer?: React.ReactNode;
}

import React from "react";

export const Sidebar = ({ items, logo, footer }: SidebarProps) => {
  const pathname = usePathname();

  return (
    <aside
      className={[
        "flex h-full flex-col",
        "w-[220px] flex-shrink-0",
        "bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)]",
        "pt-5 pb-4 px-3"
      ].join(" ")}
    >
      {/* Logo */}
      {logo && (
        <div className="px-3 mb-6">
          {logo}
        </div>
      )}

      {/* Nav items */}
      <nav className="flex-1 flex flex-col gap-0.5" aria-label="Navegação principal">
        {items.map((item, i) => {
          const isActive =
            pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href + "/"));
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={[
                "flex items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5",
                "text-sm font-medium transition-all cursor-pointer",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]",
                "animate-slide-in stagger-item",
                isActive
                  ? "bg-[var(--bg-active)] text-[var(--text-primary)] border-l-2 border-[var(--accent-blue)] -ml-px pl-[calc(0.75rem-2px)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              ].join(" ")}
              style={{ animationDelay: `${i * 50}ms` }}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon
                aria-hidden="true"
                className="h-4 w-4 flex-shrink-0"
                strokeWidth={isActive ? 2 : 1.5}
              />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      {footer && (
        <div className="mt-4 px-1 border-t border-[var(--border-subtle)] pt-4">
          {footer}
        </div>
      )}
    </aside>
  );
};

/* ─── Mobile Drawer version ─────────────────────────────────────────── */
interface SidebarDrawerProps extends SidebarProps {
  open: boolean;
  onClose: () => void;
}

export const SidebarDrawer = ({ open, onClose, ...props }: SidebarDrawerProps) => (
  <>
    {/* Overlay */}
    <div
      onClick={onClose}
      aria-hidden="true"
      className={[
        "fixed inset-0 bg-black/60 z-[var(--z-modal)] transition-opacity duration-[var(--transition-slow)]",
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      ].join(" ")}
    />

    {/* Drawer panel */}
    <div
      className={[
        "fixed inset-y-0 left-0 z-[var(--z-modal)] transition-transform duration-[var(--transition-slow)]",
        open ? "translate-x-0" : "-translate-x-full"
      ].join(" ")}
    >
      <Sidebar {...props} />
    </div>
  </>
);
