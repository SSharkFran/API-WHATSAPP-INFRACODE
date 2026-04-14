import { Skeleton } from "../../../../components/ui/Skeleton";

export default function AdminTenantsLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-10 w-48" />
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}
