import { InstanceGrid } from "../../../../components/instances/instance-grid";
import { getTenantInstances } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export default async function TenantInstancesPage() {
  const instances = await getTenantInstances();

  return (
    <section className="space-y-6">
      <div className="max-w-3xl space-y-2">
        <p className="control-kicker text-sky-300">Fleet control</p>
        <h2 className="text-3xl font-semibold text-white">Grid operacional das instancias</h2>
        <p className="text-sm leading-7 text-slate-300">
          Monitore status, uptime, risco e acoes frequentes sem sair do tenant workspace.
        </p>
      </div>

      <InstanceGrid instances={instances} />
    </section>
  );
}
