import { Skeleton } from "../../../components/ui/Skeleton";

export default function AdminOverviewLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <section className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </section>
      <section className="grid gap-4 xl:grid-cols-[1.25fr_0.95fr]">
        <Skeleton className="h-64 w-full" />
        <div className="grid gap-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </section>
    </div>
  );
}
