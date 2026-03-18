"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CheckCircle, Info, TriangleAlert, XCircle, X } from "lucide-react";

type ToastVariant = "success" | "error" | "info" | "warning";

interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (opts: Omit<Toast, "id">) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
};

const icons: Record<ToastVariant, React.ElementType> = {
  success: CheckCircle,
  error:   XCircle,
  info:    Info,
  warning: TriangleAlert
};

const variantClasses: Record<ToastVariant, { icon: string; ring: string }> = {
  success: { icon: "text-[var(--accent-green)]",  ring: "ring-[var(--accent-green)]/20" },
  error:   { icon: "text-[var(--accent-red)]",    ring: "ring-[var(--accent-red)]/20" },
  info:    { icon: "text-[var(--accent-blue)]",   ring: "ring-[var(--accent-blue)]/20" },
  warning: { icon: "text-[var(--accent-yellow)]", ring: "ring-[var(--accent-yellow)]/20" }
};

const DISMISS_MS = 4000;

const ToastItem = ({
  toast: t,
  onDismiss
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) => {
  const Icon = icons[t.variant];
  const cls = variantClasses[t.variant];
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    el.style.transition = `width ${DISMISS_MS}ms linear`;
    // start animation next frame
    const rAF = requestAnimationFrame(() => {
      el.style.width = "0%";
    });
    return () => cancelAnimationFrame(rAF);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        "relative flex w-80 max-w-sm items-start gap-3 overflow-hidden rounded-[var(--radius-md)]",
        "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
        "p-4 shadow-[var(--shadow-lg)]",
        "ring-1", cls.ring,
        "animate-fade-in"
      ].join(" ")}
    >
      <Icon aria-hidden="true" className={["h-4 w-4 flex-shrink-0 mt-0.5", cls.icon].join(" ")} />

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)] leading-snug">{t.title}</p>
        {t.description && (
          <p className="mt-0.5 text-xs text-[var(--text-secondary)] leading-snug line-clamp-2">
            {t.description}
          </p>
        )}
      </div>

      <button
        onClick={() => onDismiss(t.id)}
        aria-label="Fechar notificação"
        className="flex-shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-blue)] rounded"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {/* Progress bar */}
      <div className="absolute bottom-0 left-0 h-0.5 bg-[var(--border-default)] w-full" aria-hidden="true">
        <div ref={barRef} className="h-full bg-[var(--accent-blue)] w-full" />
      </div>
    </div>
  );
};

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((opts: Omit<Toast, "id">) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev.slice(-1), { ...opts, id }]); // max 2
    setTimeout(() => dismiss(id), DISMISS_MS);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        aria-label="Notificações"
        className="fixed bottom-5 right-5 flex flex-col gap-2 pointer-events-none"
        style={{ zIndex: "var(--z-toast)" }}
      >
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <ToastItem toast={t} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
