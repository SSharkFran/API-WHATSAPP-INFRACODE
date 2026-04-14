import { Skeleton } from "../../../../components/ui/Skeleton";

export default function AdminBillingLoading() {
  return (
    <section className="space-y-6" aria-busy="true">
      <div className="max-w-3xl space-y-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-8 w-96" />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </section>
  );
}
