import { TenantManager } from "../../../../components/admin/tenant-manager";
import { getAdminPlans, getAdminTenants } from "../../../../lib/api";

export default async function SuperAdminTenantsPage() {
  const [tenants, plans] = await Promise.all([getAdminTenants(), getAdminPlans()]);

  return (
    <TenantManager initialPlans={plans} initialTenants={tenants} />
  );
}
