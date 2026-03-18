import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "./Button";

interface EmptyStateProps {
  icon: LucideIcon;
  label: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export const EmptyState = ({ icon: Icon, label, action }: EmptyStateProps) => (
  <div className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center">
    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--bg-tertiary)]">
      <Icon aria-hidden="true" className="h-6 w-6 text-[var(--text-tertiary)]" strokeWidth={1.5} />
    </div>
    <p className="text-sm text-[var(--text-secondary)]">{label}</p>
    {action && (
      <Button variant="primary" size="sm" onClick={action.onClick}>
        {action.label}
      </Button>
    )}
  </div>
);
