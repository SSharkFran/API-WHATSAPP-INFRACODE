"use client";

import React from "react";
import { Menu } from "lucide-react";

interface TopbarProps {
  breadcrumb?: string[];
  actions?: React.ReactNode;
  onMenuClick?: () => void;
}

export const Topbar = ({ breadcrumb = [], actions, onMenuClick }: TopbarProps) => (
  <header
    className={[
      "flex items-center justify-between h-12 px-4",
      "border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]",
      "sticky top-0 z-[var(--z-base)]",
      "flex-shrink-0"
    ].join(" ")}
  >
    {/* Left: menu button (mobile) + breadcrumb */}
    <div className="flex items-center gap-2 min-w-0">
      {onMenuClick && (
        <button
          onClick={onMenuClick}
          aria-label="Abrir menu"
          className={[
            "flex md:hidden h-8 w-8 items-center justify-center rounded-[var(--radius-md)]",
            "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
            "transition-colors cursor-pointer flex-shrink-0",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]"
          ].join(" ")}
        >
          <Menu aria-hidden="true" className="h-4 w-4" />
        </button>
      )}

      {breadcrumb.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
          {breadcrumb.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 && (
                <span aria-hidden="true" className="text-[var(--text-disabled)] text-xs flex-shrink-0">/</span>
              )}
              <span
                className={[
                  "truncate text-sm",
                  i === breadcrumb.length - 1
                    ? "text-[var(--text-primary)] font-medium"
                    : "text-[var(--text-tertiary)]"
                ].join(" ")}
              >
                {crumb}
              </span>
            </React.Fragment>
          ))}
        </nav>
      )}
    </div>

    {/* Right: contextual actions */}
    {actions && (
      <div className="flex items-center gap-2 flex-shrink-0">
        {actions}
      </div>
    )}
  </header>
);
