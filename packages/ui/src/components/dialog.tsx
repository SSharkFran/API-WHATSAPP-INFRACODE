import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn.js";

export interface DialogProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  title: string;
  description?: string;
  onClose?: () => void;
  footer?: ReactNode;
}

/**
 * Modal simples e controlado, no mesmo estilo dos componentes gerados via shadcn/ui.
 */
export const Dialog = ({
  children,
  className,
  description,
  footer,
  onClose,
  open,
  title,
  ...props
}: DialogProps) => {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-md">
      <div
        className={cn(
          "w-full max-w-lg rounded-[32px] border border-white/12 bg-[linear-gradient(180deg,rgba(15,23,42,0.98),rgba(9,16,30,0.94))] p-6 text-slate-100 shadow-[0_40px_120px_rgba(2,8,23,0.6)]",
          className
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            {description ? <p className="mt-1 text-sm leading-6 text-slate-400">{description}</p> : null}
          </div>
          {onClose ? (
            <button
              aria-label="Fechar modal"
              className="rounded-full border border-white/8 bg-white/5 p-2 text-slate-400 transition hover:bg-white/10 hover:text-white"
              onClick={onClose}
              type="button"
            >
              x
            </button>
          ) : null}
        </div>
        <div className="mt-6">{children}</div>
        {footer ? <div className="mt-6 flex justify-end gap-3">{footer}</div> : null}
      </div>
    </div>
  );
};
