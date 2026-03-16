"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Dialog } from "@infracode/ui";
import type { InstanceHealthReport, QrCodeEvent } from "@infracode/types";
import { getClientPanelConfig } from "../../lib/client-panel-config";
import { requestClientApi } from "../../lib/client-api";

interface QrModalProps {
  instanceId: string | null;
  open: boolean;
  onClose: () => void;
}

const resolveWebSocketUrl = (): string =>
  getClientPanelConfig().apiBaseUrl.replace(/^http/, "ws");

export const QrModal = ({ instanceId, onClose, open }: QrModalProps) => {
  const [event, setEvent] = useState<QrCodeEvent | null>(null);
  const [countdown, setCountdown] = useState(60);
  const [health, setHealth] = useState<InstanceHealthReport | null>(null);
  const [socketError, setSocketError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !instanceId) {
      setEvent(null);
      setCountdown(60);
      setHealth(null);
      setSocketError(null);
      return;
    }

    const searchParams = new URLSearchParams();
    const panelConfig = getClientPanelConfig();

    if (panelConfig.tenantApiKey) {
      searchParams.set("apiKey", panelConfig.tenantApiKey);
    }

    if (panelConfig.tenantAccessToken) {
      searchParams.set("accessToken", panelConfig.tenantAccessToken);
    }

    const socket = new WebSocket(`${resolveWebSocketUrl()}/instances/${instanceId}/qr/ws?${searchParams.toString()}`, []);

    socket.onerror = () => {
      setSocketError("Nao foi possivel abrir o canal em tempo real do QR Code.");
    };

    socket.onclose = () => {
      setSocketError((current) => current ?? "Canal do QR fechado antes de receber um codigo valido.");
    };

    socket.onmessage = (message) => {
      const nextEvent = JSON.parse(message.data) as QrCodeEvent;
      setEvent(nextEvent);
      setCountdown(nextEvent.expiresInSeconds);
      setSocketError(null);
    };

    return () => {
      socket.close();
    };
  }, [instanceId, open]);

  useEffect(() => {
    if (!open || !event) {
      return;
    }

    const timer = window.setInterval(() => {
      setCountdown((current) => (current > 0 ? current - 1 : 0));
    }, 1_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [event, open]);

  useEffect(() => {
    if (!open || !instanceId) {
      return;
    }

    let active = true;

    const loadHealth = async () => {
      try {
        const nextHealth = await requestClientApi<InstanceHealthReport>(`/instances/${instanceId}/health`);

        if (active) {
          setHealth(nextHealth);
        }
      } catch {
        if (active) {
          setHealth(null);
        }
      }
    };

    void loadHealth();
    const timer = window.setInterval(() => {
      void loadHealth();
    }, 5_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [instanceId, open]);

  const footer = useMemo(
    () => (
      <Button className="rounded-2xl border border-white/12 bg-white/6 text-white hover:bg-white/12" onClick={onClose} variant="secondary">
        Fechar
      </Button>
    ),
    [onClose]
  );

  return (
    <Dialog
      description="Escaneie com o WhatsApp e mantenha esta janela aberta enquanto o countdown estiver ativo."
      footer={footer}
      onClose={onClose}
      open={open}
      title="QR Code da instancia"
    >
      <div className="space-y-4">
        <div className="rounded-[28px] border border-white/10 bg-slate-950/60 p-4">
          {event ? (
            <img alt="QR Code da instancia" className="mx-auto aspect-square w-full max-w-sm rounded-[24px] bg-white p-3" src={event.qrCodeBase64} />
          ) : (
            <div className="flex aspect-square items-center justify-center rounded-[24px] border border-white/8 bg-white/5 text-sm text-slate-400">
              Aguardando QR Code em tempo real...
            </div>
          )}
        </div>
        <div className="flex items-center justify-between rounded-[24px] border border-sky-300/12 bg-sky-400/10 px-4 py-3 text-sm text-slate-200">
          <span>Countdown de expiracao</span>
          <span className="font-[var(--font-mono)] text-lg text-white">{countdown}s</span>
        </div>
        {health ? (
          <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300">
            <div className="flex items-center justify-between gap-4">
              <span>Status da instancia</span>
              <span className="font-[var(--font-mono)] text-white">{health.status}</span>
            </div>
            {health.lastError ? <p className="mt-3 text-rose-300">Ultimo erro: {health.lastError}</p> : null}
          </div>
        ) : null}
        {socketError ? <div className="rounded-[24px] border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">{socketError}</div> : null}
      </div>
    </Dialog>
  );
};
