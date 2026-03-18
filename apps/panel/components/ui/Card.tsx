import * as React from "react";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  clickable?: boolean;
  children: React.ReactNode;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ clickable = false, className = "", children, ...props }, ref) => (
    <div
      ref={ref}
      className={[
        "rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5",
        "transition-[border-color,box-shadow] duration-200",
        "hover:border-[var(--border-default)] hover:shadow-[var(--shadow-sm)]",
        clickable ? "cursor-pointer" : "",
        className
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  )
);

Card.displayName = "Card";

export const CardHeader = ({ className = "", children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={["mb-4", className].join(" ")} {...props}>{children}</div>
);

export const CardTitle = ({ className = "", children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={["text-base font-semibold text-[var(--text-primary)] leading-tight", className].join(" ")} {...props}>
    {children}
  </h3>
);

export const CardDescription = ({ className = "", children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={["text-xs text-[var(--text-tertiary)] font-mono uppercase tracking-widest mb-1", className].join(" ")} {...props}>
    {children}
  </p>
);

export const CardContent = ({ className = "", children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={className} {...props}>{children}</div>
);
