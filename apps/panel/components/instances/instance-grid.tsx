"use client";

import { startTransition, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { InstanceSummary } from "@infracode/types";
import { getClientPanelConfig } from "../../lib/client-panel-config";
import { QrModal } from "./qr-modal";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Server, QrCode, Play, RotateCcw, Pause, Trash2, MessageSquare, Clock, AlertCircle } from "lucide-react";

interface InstanceGridProps {
  instances: InstanceSummary[];
}

type BadgeVariant = "success" | "error" | "warning" | "info" | "neutral";

const statusVariantMap: Record<string, BadgeVariant> = {
  INITIALIZING:  "info",
  QR_PENDING:    "warning",
  CONNECTED:     "success",
  DISCONNECTED:  "neutral",
  BANNED:        "error",
  PAUSED:        "neutral"
};

const formatUptime = (seconds: number): string => {
  const hours   = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
};

const callApi = async (path: string, init?: RequestInit) => {
  const panelConfig = getClientPanelConfig();
  const hasBody = init?.body !== undefined;
  const response = await fetch(`${panelConfig.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(panelConfig.tenantAccessToken ? { authorization: `Bearer ${panelConfig.tenantAccessToken}` } : {}),
      ...(panelConfig.tenantApiKey ? { "x-api-key": panelConfig.tenantApiKey } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    try {
      const payload = (await response.json()) as { message?: string };
      throw new Error(payload.message ?? `HTTP ${response.status}`);
    } catch {
      throw new Error(`HTTP ${response.status}`);
    }
  }
};

export const InstanceGrid = ({ instances }: InstanceGridProps) => {
  const router = useRouter();
  const [selectedQrInstanceId, setSelectedQrInstanceId] = useState<string | null>(null);
  const [pendingInstanceId, setPendingInstanceId]       = useState<string | null>(null);
  const [hoveredId, setHoveredId]                       = useState<string | null>(null);

  const sortedInstances = useMemo(
    () =>
      [...instances].sort((a, b) =>
        (b.status === "CONNECTED" ? 1 : 0) - (a.status === "CONNECTED" ? 1 : 0)
      ),
    [instances]
  );

  const runAction = async (instanceId: string, action: "start" | "pause" | "restart" | "delete") => {
    setPendingInstanceId(instanceId);
    try {
      if (action === "delete") {
        await callApi(`/instances/${instanceId}`, { method: "DELETE" });
      } else {
        await callApi(`/instances/${instanceId}/${action}`, { method: "POST" });
      }
    } finally {
      setPendingInstanceId(null);
      startTransition(() => { router.refresh(); });
    }
  };

  if (instances.length === 0) {
    return (
      <EmptyState
        icon={Server}
        label="Nenhuma instância conectada"
        action={{ label: "Conectar", onClick: () => {} }}
      />
    );
  }

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {sortedInstances.map((instance, idx) => {
          const isPending = pendingInstanceId === instance.id;
          const isHovered = hoveredId === instance.id;
          const isConnected = instance.status === "CONNECTED";

          return (
            <div
              key={instance.id}
              className={[
                "group relative rounded-[var(--radius-lg)] border bg-[var(--bg-secondary)] overflow-hidden",
                "transition-[border-color,box-shadow] duration-200 animate-fade-in stagger-item"
              ].join(" ")}
              style={{
                borderColor: isHovered ? "var(--border-default)" : "var(--border-subtle)",
                boxShadow: isHovered ? "var(--shadow-md)" : "none",
                animationDelay: `${idx * 60}ms`
              }}
              onMouseEnter={() => setHoveredId(instance.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--border-subtle)]">
                <div className="flex items-center gap-3 min-w-0">
                  {/* Status dot */}
                  <div className="flex-shrink-0 relative">
                    <div
                      className={[
                        "h-2.5 w-2.5 rounded-full",
                        isConnected ? "bg-[var(--accent-green)] pulse-dot" : "bg-[var(--bg-active)]"
                      ].join(" ")}
                      aria-hidden="true"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{instance.name}</p>
                    <p className="text-xs text-[var(--text-tertiary)] font-mono truncate mt-0.5">
                      {instance.phoneNumber ?? "Aguardando vinculação"}
                    </p>
                  </div>
                </div>
                <Badge
                  variant={statusVariantMap[instance.status] ?? "neutral"}
                  pulse={isConnected}
                >
                  {instance.status}
                </Badge>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-3 divide-x divide-[var(--border-subtle)] border-b border-[var(--border-subtle)]">
                {[
                  { icon: Clock,         label: "Uptime",    value: formatUptime(instance.usage.uptimeSeconds) },
                  { icon: MessageSquare, label: "Enviadas",  value: String(instance.usage.messagesSent) },
                  { icon: AlertCircle,   label: "Risco",     value: String(instance.usage.riskScore) }
                ].map(({ icon: Icon, label, value }) => (
                  <div key={label} className="px-4 py-3 flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <Icon aria-hidden="true" className="h-3 w-3 text-[var(--text-tertiary)]" strokeWidth={1.5} />
                      <span className="text-[10px] uppercase tracking-widest text-[var(--text-tertiary)] font-mono">{label}</span>
                    </div>
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{value}</span>
                  </div>
                ))}
              </div>

              {/* Info row */}
              <div className="px-5 py-3 text-xs text-[var(--text-tertiary)] border-b border-[var(--border-subtle)]">
                <span>
                  Última atividade:{" "}
                  <span className="text-[var(--text-secondary)]">
                    {instance.lastActivityAt
                      ? new Date(instance.lastActivityAt).toLocaleString("pt-BR")
                      : "sem tráfego"}
                  </span>
                </span>
                {instance.lastError && (
                  <div className="mt-1 text-[var(--accent-red)]">Erro: {instance.lastError}</div>
                )}
              </div>

              {/* Actions — fade in on hover */}
              <div
                className={[
                  "flex flex-wrap gap-2 px-5 py-4",
                  "transition-opacity duration-200",
                  isHovered ? "opacity-100" : "opacity-70"
                ].join(" ")}
              >
                <Button variant="secondary" size="sm" disabled={isPending} onClick={() => setSelectedQrInstanceId(instance.id)}>
                  <QrCode aria-hidden="true" className="h-3.5 w-3.5" /> QR
                </Button>
                <Button variant="ghost" size="sm" disabled={isPending} onClick={() => void runAction(instance.id, "start")}>
                  <Play aria-hidden="true" className="h-3.5 w-3.5" /> Iniciar
                </Button>
                <Button variant="ghost" size="sm" disabled={isPending} onClick={() => void runAction(instance.id, "restart")}>
                  <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" /> Reiniciar
                </Button>
                <Button variant="ghost" size="sm" disabled={isPending} onClick={() => void runAction(instance.id, "pause")}>
                  <Pause aria-hidden="true" className="h-3.5 w-3.5" /> Pausar
                </Button>
                <Button variant="danger" size="sm" disabled={isPending} onClick={() => void runAction(instance.id, "delete")}>
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" /> Apagar
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <QrModal instanceId={selectedQrInstanceId} onClose={() => setSelectedQrInstanceId(null)} open={Boolean(selectedQrInstanceId)} />
    </>
  );
};
