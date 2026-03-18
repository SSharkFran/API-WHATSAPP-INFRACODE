import * as React from "react";

interface SkeletonProps {
  className?: string;
  width?: string;
  height?: string;
}

export const Skeleton = ({ className = "", width, height }: SkeletonProps) => (
  <div
    className={["skeleton rounded-[var(--radius-md)]", className].join(" ")}
    style={{ width, height }}
    aria-hidden="true"
  />
);

export const SkeletonText = ({ lines = 1, className = "" }: { lines?: number; className?: string }) => (
  <div className={["space-y-2", className].join(" ")} aria-hidden="true">
    {Array.from({ length: lines }).map((_, i) => (
      <Skeleton
        key={i}
        className={i === lines - 1 && lines > 1 ? "w-3/4" : "w-full"}
        height="14px"
      />
    ))}
  </div>
);

export const SkeletonCard = ({ className = "" }: { className?: string }) => (
  <div
    className={[
      "rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5",
      className
    ].join(" ")}
    aria-hidden="true"
  >
    <div className="flex items-start justify-between gap-4 mb-4">
      <Skeleton width="100px" height="12px" />
      <Skeleton width="32px" height="32px" className="rounded-full" />
    </div>
    <Skeleton width="80px" height="32px" className="mb-2" />
    <Skeleton width="60%" height="12px" />
  </div>
);
