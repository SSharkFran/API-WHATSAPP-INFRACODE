import { CrmScreen } from "../../../../components/tenant/crm-screen";
import { getTenantInstances } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export default async function TenantCrmPage() {
  const instances = await getTenantInstances();
  return <CrmScreen initialInstances={instances} />;
}
