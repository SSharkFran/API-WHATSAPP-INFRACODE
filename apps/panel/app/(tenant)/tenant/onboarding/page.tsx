import { TenantOnboardingWorkbench } from "../../../../components/tenant/tenant-onboarding-workbench";
import { getTenantInstances, getTenantOnboarding } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export default async function TenantOnboardingPage() {
  const [onboarding, instances] = await Promise.all([getTenantOnboarding(), getTenantInstances()]);
  return <TenantOnboardingWorkbench initialInstances={instances} initialOnboarding={onboarding} />;
}
