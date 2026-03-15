"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface PanelNavItem {
  href: string;
  label: string;
  meta?: string;
}

interface PanelNavProps {
  items: PanelNavItem[];
  tone: "super" | "tenant";
}

const activeClasses = {
  super: "border-sky-300/24 bg-sky-400/12 text-white shadow-[0_18px_42px_rgba(2,8,23,0.28)]",
  tenant: "border-sky-200 bg-sky-50 text-sky-950 shadow-[0_16px_32px_rgba(56,189,248,0.14)]"
} as const;

const idleClasses = {
  super: "border-white/8 bg-white/5 text-slate-300 hover:bg-white/8 hover:text-white",
  tenant: "border-slate-200/90 bg-white/72 text-slate-600 hover:bg-white hover:text-slate-950"
} as const;

export const PanelNav = ({ items, tone }: PanelNavProps) => {
  const pathname = usePathname();

  return (
    <nav className="grid gap-3">
      {items.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);

        return (
          <Link
            className={[
              "rounded-[24px] border px-4 py-3 transition-all duration-200",
              isActive ? activeClasses[tone] : idleClasses[tone]
            ].join(" ")}
            href={item.href}
            key={item.href}
          >
            <div className="text-sm font-semibold">{item.label}</div>
            {item.meta ? <div className="mt-1 text-xs leading-5 opacity-80">{item.meta}</div> : null}
          </Link>
        );
      })}
    </nav>
  );
};
