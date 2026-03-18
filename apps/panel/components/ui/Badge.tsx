import * as React from "react";

type BadgeVariant = "success" | "error" | "warning" | "info" | "neutral";

interface BadgeProps {
  variant?: BadgeVariant;
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, { wrapper: string; dot: string }> = {
  success: {
    wrapper: "bg-emerald-500/12 text-emerald-400 border-emerald-500/20",
    dot: "bg-emerald-400"
  },
  error: {
    wrapper: "bg-red-500/12 text-red-400 border-red-500/20",
    dot: "bg-red-400"
  },
  warning: {
    wrapper: "bg-yellow-500/12 text-yellow-400 border-yellow-500/20",
    dot: "bg-yellow-400"
  },
  info: {
    wrapper: "bg-blue-500/12 text-blue-400 border-blue-500/20",
    dot: "bg-blue-400"
  },
  neutral: {
    wrapper: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-subtle)]",
    dot: "bg-[var(--text-tertiary)]"
  }
};

export const Badge = ({ variant = "neutral", pulse = false, children, className = "" }: BadgeProps) => {
  const styles = variantStyles[variant];

  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border",
        "text-xs font-medium tracking-wide select-none",
        styles.wrapper,
        className
      ].join(" ")}
    >
      <span
        className={["h-1.5 w-1.5 rounded-full flex-shrink-0", styles.dot, pulse ? "pulse-dot" : ""].join(" ")}
        aria-hidden="true"
      />
      {children}
    </span>
  );
};
