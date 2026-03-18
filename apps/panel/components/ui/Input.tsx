"use client";

import * as React from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, id, className = "", ...props }, ref) => {
    const inputId = id ?? label.toLowerCase().replace(/\s+/g, "-");

    return (
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={inputId}
          className="text-xs font-medium text-[var(--text-secondary)] tracking-wide select-none"
        >
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          className={[
            "h-11 w-full rounded-[var(--radius-md)] border px-3 text-sm",
            "bg-[var(--bg-tertiary)] text-[var(--text-primary)]",
            "placeholder:text-[var(--text-tertiary)]",
            "transition-[border-color,box-shadow] duration-200",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent",
            error
              ? "border-[var(--accent-red)] focus-visible:ring-[var(--accent-red)]"
              : "border-[var(--border-default)] focus:border-[var(--accent-blue)]",
            className
          ].join(" ")}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          {...props}
        />
        {error && (
          <p id={`${inputId}-error`} className="text-xs text-[var(--accent-red)]" role="alert">
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={`${inputId}-hint`} className="text-xs text-[var(--text-tertiary)]">
            {hint}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
