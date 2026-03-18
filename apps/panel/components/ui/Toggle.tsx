"use client";

import * as React from "react";

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
  id?: string;
}

export const Toggle = ({ label, checked, onChange, disabled = false, id }: ToggleProps) => {
  const toggleId = id ?? `toggle-${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div className="flex items-center gap-3">
      <button
        id={toggleId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          "relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full",
          "transition-colors duration-200 cursor-pointer",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          checked ? "bg-[var(--accent-green)]" : "bg-[var(--bg-active)]"
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={[
            "inline-block h-4 w-4 rounded-full bg-white shadow-sm",
            "transition-transform duration-200",
            checked ? "translate-x-6" : "translate-x-1"
          ].join(" ")}
        />
      </button>
      <label
        htmlFor={toggleId}
        className="text-sm text-[var(--text-secondary)] select-none cursor-pointer"
      >
        {label}
      </label>
    </div>
  );
};
