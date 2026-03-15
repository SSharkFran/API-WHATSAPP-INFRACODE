"use client";

import { startTransition, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { InstanceSummary } from "@infracode/types";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { getClientPanelConfig } from "../../lib/client-panel-config";
import { QrModal } from "./qr-modal";

interface InstanceGridProps {
  instances: InstanceSummary[];
}

const statusToneMap = {
  INITIALIZING: "info",
  QR_PENDING: "warning",
  CONNECTED: "success",
  DISCONNECTED: "danger",
  BANNED: "danger",
  PAUSED: "neutral"
} as const;

const formatUptime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
};

const callApi = async (path: string, init?: RequestInit) => {
  const panelConfig = getClientPanelConfig();
  const response = await fetch(`${panelConfig.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(panelConfig.tenantAccessToken ? { authorization: `Bearer ${panelConfig.tenantAccessToken}` } : {}),
      ...(panelConfig.tenantApiKey ? { "x-api-key": panelConfig.tenantApiKey } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
};

export const InstanceGrid = ({ instances }: InstanceGridProps) => {
  const router = useRouter();
  const [selectedQrInstanceId, setSelectedQrInstanceId] = useState<string | null>(null);
  const [pendingInstanceId, setPendingInstanceId] = useState<string | null>(null);

  const sortedInstances = useMemo(
    () =>
      [...instances].sort((left, right) => {
        const leftActive = left.status === "CONNECTED" ? 1 : 0;
        const rightActive = right.status === "CONNECTED" ? 1 : 0;
        return rightActive - leftActive;
      }),
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
      startTransition(() => {
        router.refresh();
      });
    }
  };

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
        {sortedInstances.map((instance) => (
          <Card className="surface-card overflow-hidden" key={instance.id}>
            <CardHeader className="border-b border-slate-200/80">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-[22px] bg-[linear-gradient(135deg,#0f172a,#2563eb)] text-sm font-semibold uppercase tracking-[0.2em] text-white">
                    {instance.name.slice(0, 2)}
                  </div>
                  <div className="space-y-2">
                    <CardTitle className="text-2xl text-slate-950">{instance.name}</CardTitle>
                    <CardDescription className="font-[var(--font-mono)] text-xs uppercase tracking-[0.24em] text-slate-500">
                      {instance.phoneNumber ?? "Aguardando vinculacao"}
                    </CardDescription>
                  </div>
                </div>
                <Badge tone={statusToneMap[instance.status]}>{instance.status}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 rounded-[24px] bg-[linear-gradient(180deg,#0f172a,#111827)] p-4 text-white sm:grid-cols-3">
                <div>
                  <p className="control-kicker text-slate-400">Uptime</p>
                  <p className="mt-2 text-xl font-semibold">{formatUptime(instance.usage.uptimeSeconds)}</p>
                </div>
                <div>
                  <p className="control-kicker text-slate-400">Enviadas</p>
                  <p className="mt-2 text-xl font-semibold">{instance.usage.messagesSent}</p>
                </div>
                <div>
                  <p className="control-kicker text-slate-400">Risco</p>
                  <p className="mt-2 text-xl font-semibold">{instance.usage.riskScore}</p>
                </div>
              </div>

              <div className="grid gap-3 text-sm text-slate-600">
                <div className="list-row-light rounded-[20px] px-4 py-3">Ultima atividade: {instance.lastActivityAt ? new Date(instance.lastActivityAt).toLocaleString("pt-BR") : "sem trafego"}</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="list-row-light rounded-[20px] px-4 py-3">Recebidas: {instance.usage.messagesReceived}</div>
                  <div className="list-row-light rounded-[20px] px-4 py-3">Erros: {instance.usage.errors}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button className="rounded-2xl" disabled={pendingInstanceId === instance.id} onClick={() => setSelectedQrInstanceId(instance.id)} variant="secondary">
                  QR
                </Button>
                <Button className="rounded-2xl" disabled={pendingInstanceId === instance.id} onClick={() => void runAction(instance.id, "start")} variant="ghost">
                  Iniciar
                </Button>
                <Button className="rounded-2xl" disabled={pendingInstanceId === instance.id} onClick={() => void runAction(instance.id, "restart")} variant="ghost">
                  Reiniciar
                </Button>
                <Button className="rounded-2xl" disabled={pendingInstanceId === instance.id} onClick={() => void runAction(instance.id, "pause")} variant="ghost">
                  Pausar
                </Button>
                <Button className="rounded-2xl" disabled={pendingInstanceId === instance.id} onClick={() => void runAction(instance.id, "delete")} variant="destructive">
                  Apagar
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <QrModal instanceId={selectedQrInstanceId} onClose={() => setSelectedQrInstanceId(null)} open={Boolean(selectedQrInstanceId)} />
    </>
  );
};
