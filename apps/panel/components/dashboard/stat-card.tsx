import * as React from "react";
import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: "light" | "dark";
  className?: string;
}

export const StatCard = ({ label, value, icon: Icon, className = "" }: StatCardProps) => (
  <div
    className={[
      "relative flex flex-col justify-between",
      "rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5",
      "transition-[border-color,box-shadow] duration-200",
      "hover:border-[var(--border-default)] hover:shadow-[var(--shadow-sm)]",
      "animate-fade-in stagger-item overflow-hidden",
      className
    ].join(" ")}
  >
    {/* Accent bottom line */}
    <div
      className="absolute bottom-0 left-0 right-0 h-px"
      style={{ background: "linear-gradient(90deg, var(--accent-blue), transparent)" }}
      aria-hidden="true"
    />

    {/* Header row */}
    <div className="flex items-start justify-between gap-2 mb-4">
      <p className="text-[10px] text-[var(--text-tertiary)] font-mono uppercase tracking-widest select-none">
        {label}
      </p>
      {Icon && (
        <Icon
          aria-hidden="true"
          className="h-4 w-4 text-[var(--text-tertiary)] flex-shrink-0"
          strokeWidth={1.5}
        />
      )}
    </div>

    {/* Value */}
    <p
      className="text-3xl font-semibold text-[var(--text-primary)] leading-none tracking-tight"
      style={{ fontFamily: "var(--font-display)" }}
    >
      {value}
    </p>
  </div>
);
