import { InstanceGrid } from "../../../components/instances/instance-grid";
import { getInstances } from "../../../lib/api";

export const dynamic = "force-dynamic";

export default async function InstancesPage() {
  const instances = await getInstances();

  return (
    <section className="space-y-6">
      <div className="max-w-3xl space-y-2">
        <p className="control-kicker text-sky-700">Fleet control</p>
        <h2 className="text-3xl font-semibold text-slate-950">Grid legado de instancias</h2>
        <p className="text-sm leading-7 text-slate-600">
          Mantido para compatibilidade, mas agora no mesmo visual da operacao principal.
        </p>
      </div>

      <InstanceGrid instances={instances} />
    </section>
  );
}
