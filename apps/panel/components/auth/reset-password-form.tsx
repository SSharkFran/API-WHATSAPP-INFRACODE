"use client";

import { useState } from "react";
import { Button, Input } from "@infracode/ui";
import { getClientPanelConfig } from "../../lib/client-panel-config";

const parseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { message?: string };
    return payload.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};

interface ResetPasswordFormProps {
  token?: string;
}

export const ResetPasswordForm = ({ token }: ResetPasswordFormProps) => {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (!token) {
      setError("Token de redefinicao ausente.");
      return;
    }

    if (password !== confirmPassword) {
      setError("As senhas nao conferem.");
      return;
    }

    setError(null);
    setSuccess(null);
    setPending(true);

    try {
      const response = await fetch(`${getClientPanelConfig().apiBaseUrl}/auth/password/reset`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          token,
          password
        })
      });

      if (!response.ok) {
        throw new Error(await parseErrorMessage(response));
      }

      setSuccess("Senha redefinida. Voce ja pode entrar no painel.");
      setPassword("");
      setConfirmPassword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao redefinir a senha");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-5">
      <label className="block text-sm font-medium text-slate-200">
        Nova senha
        <Input className="mt-2 h-12 rounded-2xl border-white/10 bg-slate-950/55 text-slate-50 placeholder:text-slate-500 focus:border-sky-400" onChange={(event) => setPassword(event.target.value)} placeholder="********" type="password" value={password} />
      </label>
      <label className="block text-sm font-medium text-slate-200">
        Confirmar senha
        <Input
          className="mt-2 h-12 rounded-2xl border-white/10 bg-slate-950/55 text-slate-50 placeholder:text-slate-500 focus:border-sky-400"
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder="********"
          type="password"
          value={confirmPassword}
        />
      </label>

      {error ? <p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p> : null}
      {success ? <p className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">{success}</p> : null}

      <Button className="h-12 w-full rounded-2xl bg-sky-400 text-base font-semibold text-slate-950 hover:bg-sky-300" disabled={pending || !token} onClick={() => void submit()}>
        {pending ? "Atualizando..." : "Atualizar senha"}
      </Button>
    </div>
  );
};
