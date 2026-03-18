"use client";

import { startTransition, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChatbotAiProvider } from "@infracode/types";
import { Dialog } from "@infracode/ui";
import type { AdminPlanSummary, AdminTenantAiConfig, AdminTenantSummary } from "../../lib/api";
import { requestClientApi } from "../../lib/client-api";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Search, Plus, Pencil, Bot, Trash2 } from "lucide-react";

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

interface TenantAiFormState {
  provider: ChatbotAiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
  isConfigured: boolean;
  isActive: boolean;
  updatedAt: string | null;
}

interface TenantCreateResponse {
  firstAccessUrl: string;
  tenant: AdminTenantSummary;
}

/* ─── Shared field styles ───────────────────────────────────────────── */
const fieldClass = [
  "w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)]",
  "px-3 h-11 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]",
  "transition-[border-color] duration-150",
  "focus:outline-none focus:border-[var(--accent-blue)]"
].join(" ");

const selectClass = [fieldClass, "cursor-pointer"].join(" ");

const formatNumber = (value: number): string => new Intl.NumberFormat("pt-BR").format(value);
const formatCurrency = (priceCents: number, currency: string): string =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(priceCents / 100);

const slugify = (value: string): string =>
  value.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toLowerCase()
    .replace(/\s+/g, "-").replace(/-+/g, "-");

const buildCreateForm = (plans: AdminPlanSummary[]): TenantCreateFormState => ({
  name: "", slug: "", billingEmail: "", firstAdminEmail: "",
  planId: plans[0]?.id ?? "", firstAdminRole: "ADMIN", nextDueAt: ""
});

const buildEditForm = (tenant: AdminTenantSummary): TenantEditFormState => ({
  name: tenant.name, billingEmail: tenant.billingEmail ?? "",
  planId: tenant.plan?.id ?? "", status: tenant.status,
  instanceLimit: String(tenant.instanceLimit), messagesPerMonth: String(tenant.messagesPerMonth),
  usersLimit: String(tenant.usersLimit), rateLimitPerMinute: String(tenant.rateLimitPerMinute)
});

const aiProviderDefaults: Record<ChatbotAiProvider, { baseUrl: string; model: string }> = {
  GROQ:             { baseUrl: "https://api.groq.com/openai/v1",    model: "llama-3.1-8b-instant" },
  ANTHROPIC:        { baseUrl: "https://api.anthropic.com",          model: "claude-sonnet-4-20250514" },
  OPENAI_COMPATIBLE: { baseUrl: "https://api.openai.com/v1",         model: "gpt-4.1-mini" }
};

const buildAiForm = (config?: AdminTenantAiConfig | null): TenantAiFormState => ({
  provider: config?.provider ?? "GROQ",
  baseUrl: config?.baseUrl ?? aiProviderDefaults.GROQ.baseUrl,
  model: config?.model ?? aiProviderDefaults.GROQ.model,
  apiKey: "", hasApiKey: config?.hasApiKey ?? false,
  isConfigured: config?.isConfigured ?? false, isActive: config?.isActive ?? false,
  updatedAt: config?.updatedAt ?? null
});

type BadgeVariant = "success" | "error" | "warning" | "neutral";
const statusVariant: Record<string, BadgeVariant> = {
  ACTIVE: "success", SUSPENDED: "error", CANCELED: "neutral"
};

const PAGE_SIZE = 10;

export const TenantManager = ({ initialPlans, initialTenants }: TenantManagerProps) => {
  const router = useRouter();
  const [tenants, setTenants] = useState(initialTenants);
  const [plans] = useState(initialPlans);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTenantId, setEditTenantId] = useState<string | null>(null);
  const [aiTenantId, setAiTenantId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<TenantCreateFormState>(() => buildCreateForm(initialPlans));
  const [editForm, setEditForm] = useState<TenantEditFormState>(() =>
    initialTenants[0] ? buildEditForm(initialTenants[0]) : {
      name: "", billingEmail: "", planId: initialPlans[0]?.id ?? "",
      status: "ACTIVE", instanceLimit: "1", messagesPerMonth: "10000",
      usersLimit: "1", rateLimitPerMinute: "20"
    }
  );
  const [aiForm, setAiForm] = useState<TenantAiFormState>(() => buildAiForm());
  const [pendingAction, setPendingAction] = useState<"create" | "update" | "delete" | "load-ai" | "save-ai" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successLink, setSuccessLink] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const sortedTenants = useMemo(
    () => [...tenants].sort((a, b) =>
      a.status === b.status ? a.name.localeCompare(b.name, "pt-BR") : a.status.localeCompare(b.status, "pt-BR")
    ),
    [tenants]
  );

  const filteredTenants = useMemo(
    () => search.trim()
      ? sortedTenants.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || t.slug.includes(search.toLowerCase()))
      : sortedTenants,
    [sortedTenants, search]
  );

  const totalPages = Math.ceil(filteredTenants.length / PAGE_SIZE);
  const pagedTenants = filteredTenants.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const editingTenant = useMemo(
    () => editTenantId ? tenants.find((t) => t.id === editTenantId) ?? null : null,
    [editTenantId, tenants]
  );
  const aiTenant = useMemo(
    () => aiTenantId ? tenants.find((t) => t.id === aiTenantId) ?? null : null,
    [aiTenantId, tenants]
  );

  const resetCreate = () => { setCreateForm(buildCreateForm(plans)); setCreateOpen(false); };
  const openEdit = (tenant: AdminTenantSummary) => { setError(null); setEditTenantId(tenant.id); setEditForm(buildEditForm(tenant)); };

  const openAiManager = async (tenant: AdminTenantSummary) => {
    setPendingAction("load-ai"); setError(null);
    try {
      const config = await requestClientApi<AdminTenantAiConfig>(`/admin/tenants/${tenant.id}/ai`);
      setAiTenantId(tenant.id); setAiForm(buildAiForm(config));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar IA do tenant");
    } finally { setPendingAction(null); }
  };

  const submitCreate = async () => {
    setPendingAction("create"); setError(null); setSuccessLink(null);
    try {
      const response = await requestClientApi<TenantCreateResponse>("/admin/tenants", {
        method: "POST",
        body: {
          name: createForm.name, slug: createForm.slug,
          billingEmail: createForm.billingEmail || undefined,
          firstAdminEmail: createForm.firstAdminEmail, firstAdminRole: createForm.firstAdminRole,
          nextDueAt: createForm.nextDueAt ? new Date(createForm.nextDueAt).toISOString() : undefined,
          planId: createForm.planId
        }
      });
      setTenants((c) => [response.tenant, ...c]);
      setSuccessLink(response.firstAccessUrl);
      resetCreate();
      startTransition(() => { router.refresh(); });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao criar tenant");
    } finally { setPendingAction(null); }
  };

  const submitUpdate = async () => {
    if (!editingTenant) return;
    setPendingAction("update"); setError(null);
    try {
      const updated = await requestClientApi<AdminTenantSummary>(`/admin/tenants/${editingTenant.id}`, {
        method: "PATCH",
        body: {
          name: editForm.name, billingEmail: editForm.billingEmail || null,
          planId: editForm.planId || undefined, status: editForm.status,
          instanceLimit: Number(editForm.instanceLimit), messagesPerMonth: Number(editForm.messagesPerMonth),
          usersLimit: Number(editForm.usersLimit), rateLimitPerMinute: Number(editForm.rateLimitPerMinute)
        }
      });
      setTenants((c) => c.map((t) => (t.id === updated.id ? updated : t)));
      setEditTenantId(null);
      startTransition(() => { router.refresh(); });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao atualizar tenant");
    } finally { setPendingAction(null); }
  };

  const submitAiConfig = async () => {
    if (!aiTenant) return;
    setPendingAction("save-ai"); setError(null);
    try {
      const saved = await requestClientApi<AdminTenantAiConfig>(`/admin/tenants/${aiTenant.id}/ai`, {
        method: "PUT",
        body: {
          provider: aiForm.provider, baseUrl: aiForm.baseUrl.trim(),
          model: aiForm.model.trim(), apiKey: aiForm.apiKey.trim() || undefined,
          isActive: aiForm.isActive
        }
      });
      setAiForm(buildAiForm(saved));
      setTenants((c) => c.map((t) =>
        t.id === aiTenant.id
          ? { ...t, aiConfigured: saved.isConfigured, aiProvider: saved.provider, aiModel: saved.model }
          : t
      ));
      startTransition(() => { router.refresh(); });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao salvar IA");
    } finally { setPendingAction(null); }
  };

  const removeTenant = async (tenant: AdminTenantSummary) => {
    if (!window.confirm(`Excluir o tenant ${tenant.name}? Essa ação remove o schema dedicado.`)) return;
    setPendingAction("delete"); setError(null);
    try {
      await requestClientApi(`/admin/tenants/${tenant.id}`, { method: "DELETE" });
      setTenants((c) => c.filter((t) => t.id !== tenant.id));
      startTransition(() => { router.refresh(); });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao excluir tenant");
    } finally { setPendingAction(null); }
  };

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="relative flex-1 max-w-sm">
          <Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-tertiary)]" />
          <input
            type="search"
            placeholder="Buscar tenant…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className={[
              "h-11 w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)]",
              "pl-9 pr-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]",
              "transition-[border-color] duration-150 focus:outline-none focus:border-[var(--accent-blue)]"
            ].join(" ")}
          />
        </div>
        <Button variant="primary" size="md" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" className="h-4 w-4" /> Novo tenant
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--accent-red)]/20 bg-[var(--accent-red)]/8 px-4 py-3 text-sm text-[var(--accent-red)]" role="alert">
          {error}
        </div>
      )}

      {/* Success link */}
      {successLink && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--accent-green)]/20 bg-[var(--accent-green)]/8 p-5 space-y-3">
          <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--accent-green)]">Link de primeiro acesso</p>
          <p className="text-sm text-[var(--text-primary)] break-all font-mono">{successLink}</p>
          <div className="flex gap-3">
            <Button variant="secondary" size="sm" onClick={() => void navigator.clipboard.writeText(successLink)}>
              Copiar link
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSuccessLink(null)}>
              Fechar
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
        {/* Table head */}
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 px-5 py-3 border-b border-[var(--border-subtle)] text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)]">
          <span>Tenant</span>
          <span className="hidden sm:block text-right">Instâncias</span>
          <span className="hidden md:block text-right">Uso/mês</span>
          <span className="text-right">Status</span>
          <span className="text-right">Ações</span>
        </div>

        {/* Rows */}
        {pagedTenants.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-[var(--text-tertiary)]">
            {search ? "Nenhum tenant encontrado para esse filtro." : "Nenhum tenant cadastrado ainda."}
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {pagedTenants.map((tenant, idx) => {
              const usage = Math.round((tenant.messagesThisMonth / Math.max(tenant.messagesPerMonth, 1)) * 100);
              return (
                <div
                  key={tenant.id}
                  className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 items-center px-5 py-4 hover:bg-[var(--bg-hover)] transition-colors duration-150 animate-fade-in stagger-item cursor-pointer"
                  style={{ animationDelay: `${idx * 30}ms` }}
                >
                  {/* Name + slug */}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{tenant.name}</p>
                    <p className="text-xs text-[var(--text-tertiary)] font-mono truncate">{tenant.slug}</p>
                    {tenant.aiConfigured && (
                      <span className="text-[10px] text-[var(--accent-blue)] font-mono mt-0.5 block">
                        IA: {tenant.aiProvider} · {tenant.aiModel ?? "—"}
                      </span>
                    )}
                  </div>

                  {/* Active instances */}
                  <div className="hidden sm:flex flex-col items-end">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{tenant.activeInstances}</span>
                    <span className="text-[10px] text-[var(--text-tertiary)] font-mono">instâncias</span>
                  </div>

                  {/* Usage */}
                  <div className="hidden md:flex flex-col items-end gap-1.5 min-w-[80px]">
                    <span className="text-xs font-mono text-[var(--text-secondary)]">{usage}%</span>
                    <div className="progress-track w-20">
                      <div className="progress-fill" style={{ width: `${Math.max(2, Math.min(100, usage))}%` }} />
                    </div>
                  </div>

                  {/* Status badge */}
                  <Badge variant={statusVariant[tenant.status] ?? "neutral"} pulse={tenant.status === "ACTIVE"}>
                    {tenant.status}
                  </Badge>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => openEdit(tenant)}
                      aria-label={`Editar ${tenant.name}`}
                      className="h-8 w-8 flex items-center justify-center rounded-[var(--radius-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]"
                    >
                      <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => void openAiManager(tenant)}
                      aria-label={`IA de ${tenant.name}`}
                      disabled={pendingAction === "load-ai"}
                      className="h-8 w-8 flex items-center justify-center rounded-[var(--radius-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-active)] hover:text-[var(--accent-blue)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]"
                    >
                      <Bot aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => void removeTenant(tenant)}
                      aria-label={`Excluir ${tenant.name}`}
                      className="h-8 w-8 flex items-center justify-center rounded-[var(--radius-md)] text-[var(--text-tertiary)] hover:bg-[var(--accent-red)]/10 hover:text-[var(--accent-red)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-red)]"
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--border-subtle)]">
            <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ← Anterior
            </Button>
            <span className="text-xs text-[var(--text-tertiary)] font-mono">
              {page + 1} de {totalPages}
            </span>
            <Button variant="ghost" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
              Próxima →
            </Button>
          </div>
        )}
      </div>

      {/* ── CREATE DIALOG ─────────────────────────────────────────────── */}
      <Dialog
        title="Novo tenant"
        description="Provisiona schema, convite inicial e limites do plano."
        open={createOpen}
        onClose={resetCreate}
        footer={
          <>
            <Button variant="ghost" size="md" onClick={resetCreate}>Cancelar</Button>
            <Button variant="primary" size="md" loading={pendingAction === "create"} disabled={pendingAction !== null} onClick={() => void submitCreate()}>
              Criar tenant
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {[
            { label: "Nome do cliente",      type: "text",           placeholder: "Acme Commerce",      field: "name",              transform: (v: string) => v },
            { label: "Slug",                 type: "text",           placeholder: "acme-commerce",       field: "slug",              transform: slugify },
            { label: "Email do primeiro admin", type: "email",       placeholder: "admin@cliente.com",  field: "firstAdminEmail",   transform: (v: string) => v },
            { label: "Email de billing",     type: "email",          placeholder: "fin@cliente.com",    field: "billingEmail",      transform: (v: string) => v },
            { label: "Próximo vencimento",   type: "datetime-local", placeholder: "",                   field: "nextDueAt",         transform: (v: string) => v }
          ].map(({ label, type, placeholder, field, transform }) => (
            <div key={field}>
              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">{label}</label>
              <input
                type={type}
                placeholder={placeholder}
                className={fieldClass}
                value={String(createForm[field as keyof TenantCreateFormState] ?? "")}
                onChange={(e) => {
                  const val = transform(e.target.value);
                  setCreateForm((c) => {
                    const next = { ...c, [field]: val };
                    if (field === "name" && !c.slug) next.slug = slugify(val);
                    return next;
                  });
                }}
              />
            </div>
          ))}
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Plano</label>
            <select className={selectClass} value={createForm.planId}
              onChange={(e) => setCreateForm((c) => ({ ...c, planId: e.target.value }))}>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>{plan.name} · {formatCurrency(plan.priceCents, plan.currency)}</option>
              ))}
            </select>
          </div>
        </div>
      </Dialog>

      {/* ── EDIT DIALOG ───────────────────────────────────────────────── */}
      <Dialog
        title={editingTenant ? `Editar ${editingTenant.name}` : "Editar tenant"}
        description="Ajuste status, plano e limites."
        open={Boolean(editingTenant)}
        onClose={() => setEditTenantId(null)}
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setEditTenantId(null)}>Cancelar</Button>
            <Button variant="primary" size="md" loading={pendingAction === "update"} disabled={pendingAction !== null || !editingTenant} onClick={() => void submitUpdate()}>
              Salvar
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Nome</label>
            <input type="text" className={fieldClass} value={editForm.name}
              onChange={(e) => setEditForm((c) => ({ ...c, name: e.target.value }))} />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Status</label>
            <select className={selectClass} value={editForm.status}
              onChange={(e) => setEditForm((c) => ({ ...c, status: e.target.value }))}>
              <option value="ACTIVE">ACTIVE</option>
              <option value="SUSPENDED">SUSPENDED</option>
              <option value="CANCELED">CANCELED</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Plano</label>
            <select className={selectClass} value={editForm.planId}
              onChange={(e) => setEditForm((c) => ({ ...c, planId: e.target.value }))}>
              <option value="">Manter atual</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>{plan.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Billing email</label>
            <input type="email" className={fieldClass} value={editForm.billingEmail}
              onChange={(e) => setEditForm((c) => ({ ...c, billingEmail: e.target.value }))} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { label: "Limite instâncias",  field: "instanceLimit" },
              { label: "Usuários",          field: "usersLimit" },
              { label: "Mensagens/mês",     field: "messagesPerMonth" },
              { label: "Rate limit/min",    field: "rateLimitPerMinute" }
            ].map(({ label, field }) => (
              <div key={field}>
                <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">{label}</label>
                <input type="number" min={1} className={fieldClass}
                  value={String(editForm[field as keyof TenantEditFormState] ?? "")}
                  onChange={(e) => setEditForm((c) => ({ ...c, [field]: e.target.value }))} />
              </div>
            ))}
          </div>
        </div>
      </Dialog>

      {/* ── AI CONFIG DIALOG ──────────────────────────────────────────── */}
      <Dialog
        title={aiTenant ? `IA — ${aiTenant.name}` : "IA do tenant"}
        description="Provedor, modelo e chave ficam no control plane. O cliente só vê o modo do bot."
        open={Boolean(aiTenant)}
        onClose={() => { setAiTenantId(null); setAiForm(buildAiForm()); }}
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => { setAiTenantId(null); setAiForm(buildAiForm()); }}>Cancelar</Button>
            <Button variant="primary" size="md" loading={pendingAction === "save-ai"} disabled={pendingAction !== null || !aiTenant} onClick={() => void submitAiConfig()}>
              Salvar IA
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-secondary)]">
            O tenant vê apenas o modo de uso da IA no chatbot. Credenciais ficam sob controle da InfraCode.
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Provedor</label>
            <select className={selectClass} value={aiForm.provider}
              onChange={(e) => {
                const provider = e.target.value as ChatbotAiProvider;
                const defaults = aiProviderDefaults[provider];
                setAiForm((c) => ({ ...c, provider, baseUrl: defaults.baseUrl, model: defaults.model }));
              }}>
              <option value="ANTHROPIC">Anthropic</option>
              <option value="GROQ">Groq</option>
              <option value="OPENAI_COMPATIBLE">OpenAI compatível</option>
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Base URL</label>
              <input type="text" className={fieldClass} value={aiForm.baseUrl}
                onChange={(e) => setAiForm((c) => ({ ...c, baseUrl: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Modelo</label>
              <input type="text" className={fieldClass} value={aiForm.model}
                onChange={(e) => setAiForm((c) => ({ ...c, model: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">
              API Key {aiForm.hasApiKey ? "(já cadastrada)" : ""}
            </label>
            <input type="password" className={fieldClass}
              placeholder={aiForm.hasApiKey ? "Preencha apenas se quiser trocar" : "gsk_..."}
              value={aiForm.apiKey}
              onChange={(e) => setAiForm((c) => ({ ...c, apiKey: e.target.value }))} />
          </div>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <span className="relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors duration-200"
                style={{ background: aiForm.isActive ? "var(--accent-green)" : "var(--bg-active)" }}>
              <input type="checkbox" className="sr-only" checked={aiForm.isActive}
                onChange={(e) => setAiForm((c) => ({ ...c, isActive: e.target.checked }))} />
              <span className={["inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
                aiForm.isActive ? "translate-x-6" : "translate-x-1"].join(" ")} />
            </span>
            <span className="text-sm text-[var(--text-secondary)] select-none">Provedor ativo para o tenant</span>
          </label>
          <div className="grid gap-2 sm:grid-cols-2 text-xs font-mono">
            <div className="px-3 py-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
              Status: <span className="text-[var(--text-primary)]">{aiForm.isConfigured ? "configurado" : "pendente"}</span>
            </div>
            <div className="px-3 py-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
              Atualizado: <span className="text-[var(--text-primary)]">{aiForm.updatedAt ? new Date(aiForm.updatedAt).toLocaleString("pt-BR") : "nunca"}</span>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
};
