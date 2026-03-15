import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}

const toneMap = {
  neutral: "border border-slate-200 bg-slate-100/90 text-slate-700",
  success: "border border-emerald-200 bg-emerald-100/90 text-emerald-700",
  warning: "border border-amber-200 bg-amber-100/90 text-amber-700",
  danger: "border border-rose-200 bg-rose-100/90 text-rose-700",
  info: "border border-sky-200 bg-sky-100/90 text-sky-700"
};

export const Badge = ({ className, tone = "neutral", ...props }: BadgeProps) => (
  <span
    className={cn(
      "inline-flex rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
      toneMap[tone],
      className
    )}
    {...props}
  />
);
