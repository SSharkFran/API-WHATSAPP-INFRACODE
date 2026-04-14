import { ShieldOff, AlertTriangle } from "lucide-react";
import { TenantManager } from "../../../../components/admin/tenant-manager";
import { getAdminPlans, getAdminTenants, ForbiddenError } from "../../../../lib/api";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { isRedirectError } from "next/dist/client/components/redirect";

export const dynamic = "force-dynamic";

export default async function SuperAdminTenantsPage() {
  let tenants: Awaited<ReturnType<typeof getAdminTenants>>;
  let plans: Awaited<ReturnType<typeof getAdminPlans>>;

  try {
    [tenants, plans] = await Promise.all([getAdminTenants(), getAdminPlans()]);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    if (error instanceof ForbiddenError) {
      return (
        <div role="alert" aria-live="assertive">
          <EmptyState
            icon={ShieldOff}
            label="Acesso negado. Esta área requer permissão de Platform Owner."
          />
        </div>
      );
    }
    return (
      <div role="alert" aria-live="assertive">
        <EmptyState
          icon={AlertTriangle}
          label="Não foi possível carregar os dados. Tente recarregar a página."
        />
      </div>
    );
  }

  return (
    <TenantManager initialPlans={plans} initialTenants={tenants} />
  );
}
