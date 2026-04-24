import { FileText, Clock, User } from "lucide-react";
import { getTenantActionHistory } from "../../../../lib/api";

export const dynamic = "force-dynamic";

function DeliveryStatusBadge({ status }: { status: string }) {
  if (status === "sent") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
        Enviado
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
        Falhou
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border border-[var(--border-subtle)]">
      Pendente
    </span>
  );
}

function formatActionType(actionType: string): string {
  const labels: Record<string, string> = {
    document_send: "Envio de documento",
    session_close: "Encerramento de sessão",
    status_query: "Consulta de status",
    metrics_query: "Consulta de métricas",
    human_takeover: "Transferência humano",
  };
  return labels[actionType] ?? actionType;
}

export default async function TenantActionHistoryPage() {
  const history = await getTenantActionHistory(100);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Histórico de Ações</h1>
        <p className="text-sm text-[var(--text-tertiary)] mt-0.5">
          Últimas 100 ações administrativas registradas
        </p>
      </div>

      {history.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-8 text-center">
          <FileText className="h-8 w-8 mx-auto text-[var(--text-tertiary)] mb-2" aria-hidden="true" />
          <p className="text-sm text-[var(--text-tertiary)]">Nenhuma ação registrada ainda</p>
        </div>
      ) : (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-tertiary)]">
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />Quando</span>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-tertiary)]">Ação</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-tertiary)]">
                  <span className="flex items-center gap-1"><User className="h-3 w-3" />Admin</span>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-tertiary)]">Documento</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-tertiary)]">Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <td className="px-4 py-3 text-xs text-[var(--text-secondary)] whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--text-primary)]">
                    {formatActionType(entry.actionType)}
                    {entry.targetContactJid && (
                      <span className="block text-[var(--text-tertiary)] mt-0.5">
                        {entry.targetContactJid.replace(/@[^@]+$/, "")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--text-secondary)] truncate max-w-[160px]">
                    {entry.triggeredByJid.replace(/@[^@]+$/, "")}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--text-secondary)] truncate max-w-[160px]">
                    {entry.documentName ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <DeliveryStatusBadge status={entry.deliveryStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
