"use client";

import { startTransition, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, Input } from "@infracode/ui";
import type { AdminPlanSummary, AdminTenantSummary } from "../../lib/api";
import { requestClientApi } from "../../lib/client-api";

interface TenantManagerProps {
  initialPlans: AdminPlanSummary[];
  initialTenants: AdminTenantSummary[];
}

interface TenantCreateFormState {
  name: string;
  slug: string;
  billingEmail: string;
  firstAdminEmail: string;
  planId: string;
  firstAdminRole: "ADMIN";
  nextDueAt: string;
}

interface TenantEditFormState {
  name: string;
  billingEmail: string;
  planId: string;
  status: string;
  instanceLimit: string;
  messagesPerMonth: string;
  usersLimit: string;
  rateLimitPerMinute: string;
}

interface TenantCreateResponse {
  firstAccessUrl: string;
  tenant: AdminTenantSummary;
}

const selectClassName =
  "h-12 w-full rounded-2xl border border-slate-200/80 bg-white/92 px-4 text-sm text-slate-950 outline-none ring-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100";

const formatNumber = (value: number): string => new Intl.NumberFormat("pt-BR").format(value);
const formatCurrency = (priceCents: number, currency: string): string =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency
  }).format(priceCents / 100);

const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

const buildCreateForm = (plans: AdminPlanSummary[]): TenantCreateFormState => ({
  name: "",
  slug: "",
  billingEmail: "",
  firstAdminEmail: "",
  planId: plans[0]?.id ?? "",
  firstAdminRole: "ADMIN",
  nextDueAt: ""
});

const buildEditForm = (tenant: AdminTenantSummary): TenantEditFormState => ({
  name: tenant.name,
  billingEmail: tenant.billingEmail ?? "",
  planId: tenant.plan?.id ?? "",
  status: tenant.status,
  instanceLimit: String(Math.max(tenant.activeInstances, 1)),
  messagesPerMonth: String(tenant.messagesPerMonth),
  usersLimit: String(tenant.usersLimit),
  rateLimitPerMinute: "20"
});

export const TenantManager = ({ initialPlans, initialTenants }: TenantManagerProps) => {
  const router = useRouter();
  const [tenants, setTenants] = useState(initialTenants);
  const [plans] = useState(initialPlans);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTenantId, setEditTenantId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<TenantCreateFormState>(() => buildCreateForm(initialPlans));
  const [editForm, setEditForm] = useState<TenantEditFormState>(() =>
    initialTenants[0]
      ? buildEditForm(initialTenants[0])
      : {
          name: "",
          billingEmail: "",
          planId: initialPlans[0]?.id ?? "",
          status: "ACTIVE",
          instanceLimit: "1",
          messagesPerMonth: "10000",
          usersLimit: "1",
          rateLimitPerMinute: "20"
        }
  );
  const [pendingAction, setPendingAction] = useState<"create" | "update" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successLink, setSuccessLink] = useState<string | null>(null);

  const sortedTenants = useMemo(
    () =>
      [...tenants].sort((left, right) => {
        if (left.status === right.status) {
          return left.name.localeCompare(right.name, "pt-BR");
        }

        return left.status.localeCompare(right.status, "pt-BR");
      }),
    [tenants]
  );

  const editingTenant = useMemo(
    () => (editTenantId ? tenants.find((tenant) => tenant.id === editTenantId) ?? null : null),
    [editTenantId, tenants]
  );

  const resetCreate = () => {
    setCreateForm(buildCreateForm(plans));
    setCreateOpen(false);
  };

  const openEdit = (tenant: AdminTenantSummary) => {
    setError(null);
    setEditTenantId(tenant.id);
    setEditForm(buildEditForm(tenant));
  };

  const submitCreate = async () => {
    setPendingAction("create");
    setError(null);
    setSuccessLink(null);

    try {
      const response = await requestClientApi<TenantCreateResponse>("/admin/tenants", {
        method: "POST",
        body: {
          name: createForm.name,
          slug: createForm.slug,
          billingEmail: createForm.billingEmail || undefined,
          firstAdminEmail: createForm.firstAdminEmail,
          firstAdminRole: createForm.firstAdminRole,
          nextDueAt: createForm.nextDueAt ? new Date(createForm.nextDueAt).toISOString() : undefined,
          planId: createForm.planId
        }
      });

      setTenants((current) => [response.tenant, ...current]);
      setSuccessLink(response.firstAccessUrl);
      resetCreate();
      startTransition(() => {
        router.refresh();
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao criar tenant");
    } finally {
      setPendingAction(null);
    }
  };

  const submitUpdate = async () => {
    if (!editingTenant) {
      return;
    }

    setPendingAction("update");
    setError(null);

    try {
      const updated = await requestClientApi<AdminTenantSummary>(`/admin/tenants/${editingTenant.id}`, {
        method: "PATCH",
        body: {
          name: editForm.name,
          billingEmail: editForm.billingEmail || null,
          planId: editForm.planId || undefined,
          status: editForm.status,
          instanceLimit: Number(editForm.instanceLimit),
          messagesPerMonth: Number(editForm.messagesPerMonth),
          usersLimit: Number(editForm.usersLimit),
          rateLimitPerMinute: Number(editForm.rateLimitPerMinute)
        }
      });

      setTenants((current) => current.map((tenant) => (tenant.id === updated.id ? updated : tenant)));
      setEditTenantId(null);
      startTransition(() => {
        router.refresh();
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao atualizar tenant");
    } finally {
      setPendingAction(null);
    }
  };

  const removeTenant = async (tenant: AdminTenantSummary) => {
    if (!window.confirm(`Excluir o tenant ${tenant.name}? Essa acao remove o schema dedicado.`)) {
      return;
    }

    setPendingAction("delete");
    setError(null);

    try {
      await requestClientApi(`/admin/tenants/${tenant.id}`, {
        method: "DELETE"
      });
      setTenants((current) => current.filter((currentTenant) => currentTenant.id !== tenant.id));
      startTransition(() => {
        router.refresh();
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao excluir tenant");
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-3xl space-y-2">
          <p className="control-kicker text-slate-400">Tenants</p>
          <h2 className="text-3xl font-semibold text-white">Cadastro operacional pronto para venda</h2>
          <p className="text-sm leading-7 text-slate-300">
            Crie clientes, escolha o plano, ajuste limites e entregue o link de primeiro acesso sem sair do control plane.
          </p>
        </div>
        <Button className="rounded-2xl" onClick={() => setCreateOpen(true)}>
          Novo tenant
        </Button>
      </div>

      {successLink ? (
        <Card className="surface-card">
          <CardHeader>
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Primeiro acesso</CardDescription>
            <CardTitle className="text-2xl text-slate-950">Link gerado para o cliente</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-7 text-slate-600">
            <div className="list-row-light rounded-[22px] p-4">
              <p className="control-kicker text-slate-400">URL</p>
              <p className="mt-2 break-all text-slate-950">{successLink}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button className="rounded-2xl" onClick={() => void navigator.clipboard.writeText(successLink)} variant="secondary">
                Copiar link
              </Button>
              <Button className="rounded-2xl" onClick={() => setSuccessLink(null)} variant="ghost">
                Fechar aviso
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {error ? <p className="rounded-[20px] border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</p> : null}

      <div className="grid gap-5 xl:grid-cols-2">
        {sortedTenants.map((tenant) => {
          const usage = Math.round((tenant.messagesThisMonth / Math.max(tenant.messagesPerMonth, 1)) * 100);
          const plan = plans.find((item) => item.id === tenant.plan?.id) ?? null;

          return (
            <Card className="surface-card-dark text-white" key={tenant.id}>
              <CardHeader className="border-b border-white/8">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="text-2xl text-white">{tenant.name}</CardTitle>
                    <CardDescription className="mt-2 font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">
                      {tenant.slug}
                    </CardDescription>
                  </div>
                  <span className="status-pill bg-white/10 text-slate-200">{tenant.status}</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="list-row-dark rounded-[22px] p-4">
                    <p className="control-kicker text-slate-400">Plano</p>
                    <p className="mt-3 text-lg font-semibold text-white">{plan?.name ?? tenant.plan?.name ?? "Sem plano"}</p>
                    <p className="mt-2 text-sm text-slate-300">
                      {plan ? formatCurrency(plan.priceCents, plan.currency) : "Sem valor configurado"}
                    </p>
                  </div>
                  <div className="list-row-dark rounded-[22px] p-4">
                    <p className="control-kicker text-slate-400">Capacidade</p>
                    <p className="mt-3 text-lg font-semibold text-white">{formatNumber(tenant.messagesPerMonth)} mensagens/mes</p>
                    <p className="mt-2 text-sm text-slate-300">{tenant.usersLimit} usuarios internos</p>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between text-sm text-slate-300">
                    <span>{formatNumber(tenant.messagesThisMonth)} usadas no mes</span>
                    <span className="font-[var(--font-mono)]">{usage}% do plano</span>
                  </div>
                  <div className="progress-track mt-3">
                    <div className="progress-fill" style={{ width: `${Math.max(8, Math.min(100, usage))}%` }} />
                  </div>
                </div>

                <div className="grid gap-3 text-sm text-slate-300 md:grid-cols-2">
                  <div className="list-row-dark rounded-[20px] px-4 py-3">Instancias ativas: {tenant.activeInstances}</div>
                  <div className="list-row-dark rounded-[20px] px-4 py-3">Billing: {tenant.billingEmail ?? "nao informado"}</div>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button className="rounded-2xl" onClick={() => openEdit(tenant)} variant="secondary">
                    Editar
                  </Button>
                  <Button className="rounded-2xl" onClick={() => void removeTenant(tenant)} variant="destructive">
                    Excluir
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog
        description="Provisiona schema, convite inicial e limites do plano para o novo cliente."
        footer={
          <>
            <Button onClick={resetCreate} variant="ghost">
              Cancelar
            </Button>
            <Button disabled={pendingAction !== null} onClick={() => void submitCreate()}>
              {pendingAction === "create" ? "Criando..." : "Criar tenant"}
            </Button>
          </>
        }
        onClose={resetCreate}
        open={createOpen}
        title="Novo tenant"
      >
        <div className="grid gap-4">
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Nome do cliente</span>
            <Input
              onChange={(event) => {
                const nextName = event.target.value;
                setCreateForm((current) => ({
                  ...current,
                  name: nextName,
                  slug: current.slug ? current.slug : slugify(nextName)
                }));
              }}
              placeholder="Acme Commerce"
              value={createForm.name}
            />
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Slug</span>
            <Input
              onChange={(event) => setCreateForm((current) => ({ ...current, slug: slugify(event.target.value) }))}
              placeholder="acme-commerce"
              value={createForm.slug}
            />
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Plano</span>
            <select
              className={selectClassName}
              onChange={(event) => setCreateForm((current) => ({ ...current, planId: event.target.value }))}
              value={createForm.planId}
            >
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} · {formatCurrency(plan.priceCents, plan.currency)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Email do primeiro admin</span>
            <Input
              onChange={(event) => setCreateForm((current) => ({ ...current, firstAdminEmail: event.target.value }))}
              placeholder="admin@cliente.com"
              type="email"
              value={createForm.firstAdminEmail}
            />
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Email de billing</span>
            <Input
              onChange={(event) => setCreateForm((current) => ({ ...current, billingEmail: event.target.value }))}
              placeholder="financeiro@cliente.com"
              type="email"
              value={createForm.billingEmail}
            />
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Próximo vencimento</span>
            <Input
              onChange={(event) => setCreateForm((current) => ({ ...current, nextDueAt: event.target.value }))}
              type="datetime-local"
              value={createForm.nextDueAt}
            />
          </label>
        </div>
      </Dialog>

      <Dialog
        description="Ajuste status, plano e limites sem sair do control plane."
        footer={
          <>
            <Button onClick={() => setEditTenantId(null)} variant="ghost">
              Cancelar
            </Button>
            <Button disabled={pendingAction !== null || !editingTenant} onClick={() => void submitUpdate()}>
              {pendingAction === "update" ? "Salvando..." : "Salvar alteracoes"}
            </Button>
          </>
        }
        onClose={() => setEditTenantId(null)}
        open={Boolean(editingTenant)}
        title={editingTenant ? `Editar ${editingTenant.name}` : "Editar tenant"}
      >
        <div className="grid gap-4">
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Nome</span>
            <Input onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))} value={editForm.name} />
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Status</span>
            <select
              className={selectClassName}
              onChange={(event) => setEditForm((current) => ({ ...current, status: event.target.value }))}
              value={editForm.status}
            >
              <option value="ACTIVE">ACTIVE</option>
              <option value="SUSPENDED">SUSPENDED</option>
              <option value="CANCELED">CANCELED</option>
            </select>
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Plano</span>
            <select
              className={selectClassName}
              onChange={(event) => setEditForm((current) => ({ ...current, planId: event.target.value }))}
              value={editForm.planId}
            >
              <option value="">Manter atual</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Billing email</span>
            <Input
              onChange={(event) => setEditForm((current) => ({ ...current, billingEmail: event.target.value }))}
              type="email"
              value={editForm.billingEmail}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm">
              <span className="text-slate-300">Limite de instancias</span>
              <Input
                min={1}
                onChange={(event) => setEditForm((current) => ({ ...current, instanceLimit: event.target.value }))}
                type="number"
                value={editForm.instanceLimit}
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="text-slate-300">Usuarios</span>
              <Input
                min={1}
                onChange={(event) => setEditForm((current) => ({ ...current, usersLimit: event.target.value }))}
                type="number"
                value={editForm.usersLimit}
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="text-slate-300">Mensagens/mes</span>
              <Input
                min={1}
                onChange={(event) => setEditForm((current) => ({ ...current, messagesPerMonth: event.target.value }))}
                type="number"
                value={editForm.messagesPerMonth}
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="text-slate-300">Rate limit/min</span>
              <Input
                min={1}
                onChange={(event) => setEditForm((current) => ({ ...current, rateLimitPerMinute: event.target.value }))}
                type="number"
                value={editForm.rateLimitPerMinute}
              />
            </label>
          </div>
        </div>
      </Dialog>
    </div>
  );
};
