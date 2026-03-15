import type { InputHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input
    className={cn(
      "h-12 w-full rounded-2xl border border-slate-200/80 bg-white/92 px-4 text-sm text-slate-950 outline-none ring-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] transition placeholder:text-slate-400 focus:border-sky-400 focus:ring-4 focus:ring-sky-100",
      className
    )}
    {...props}
  />
);
