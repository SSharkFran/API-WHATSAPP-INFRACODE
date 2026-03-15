import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export type ButtonVariant = "default" | "secondary" | "ghost" | "destructive";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantMap: Record<ButtonVariant, string> = {
  default: "bg-sky-400 text-slate-950 shadow-[0_14px_36px_rgba(56,189,248,0.28)] hover:bg-sky-300",
  secondary: "border border-slate-200 bg-white/88 text-slate-900 shadow-[0_10px_24px_rgba(15,23,42,0.08)] hover:bg-white",
  ghost: "bg-transparent text-slate-700 hover:bg-slate-950/[0.05] hover:text-slate-950",
  destructive: "bg-rose-600 text-white hover:bg-rose-500"
};

/**
 * Botao base seguindo a convencao visual do shadcn/ui.
 */
export const Button = ({ className, variant = "default", type = "button", ...props }: ButtonProps) => (
  <button
    className={cn(
      "inline-flex items-center justify-center rounded-2xl px-4 py-2.5 text-sm font-semibold tracking-[-0.01em] transition-all duration-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-50",
      variantMap[variant],
      className
    )}
    type={type}
    {...props}
  />
);
