import "server-only";
import type { InstanceSummary } from "@infracode/types";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect";
import { getServerPanelSession } from "./server-session";

/**
 * Thrown when the API returns 403 — caller lacks PLATFORM_OWNER scope.
 * Server components catch this to render the ShieldOff EmptyState.
 */
export class ForbiddenError extends Error {
  constructor() {
    super("forbidden");
    this.name = "ForbiddenError";
  }
}

const resolveInternalApiBaseUrl = (): string => {
  // API_INTERNAL_BASE_URL is a server-only runtime env (not NEXT_PUBLIC_), so it works at runtime
  if (process.env.API_INTERNAL_BASE_URL) {
    return process.env.API_INTERNAL_BASE_URL.replace(/\/$/, "");
  }

  if (process.env.NEXT_PUBLIC_API_BASE_URL) {
    return process.env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "");
  }

  console.warn("[api.ts] Nenhuma URL de API configurada. Usando http://localhost:3333. Configure API_INTERNAL_BASE_URL no Railway.");
  return "http://localhost:3333";
};

const internalApiBaseUrl = resolveInternalApiBaseUrl();
const publicApiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? internalApiBaseUrl).replace(/\/$/, "");
const defaultTenantSlug = process.env.NEXT_PUBLIC_DEFAULT_TENANT ?? "tenant-demo";

export interface TenantDashboardSnapshot {
  tenantId: string;
  tenantName: string;
  activeInstances: number;
  totalInstances: number;
  connectedInstances: number;
  queuedMessages: number;
  messagesThisMonth: number;
  messagesPerMonth: number;
  usersUsed: number;
  usersLimit: number;
  messagesTodayOutbound: number;
  escalationsToday: number;
  knowledgeLearnedToday: number;
  resolutionRateLast7Days: number;
}

export interface TodayMetricsSnapshot {
  startedCount: number;
  endedCount: number;
  inactiveCount: number;
  handoffCount: number;
  avgDurationSeconds: number | null;
  avgFirstResponseMs: number | null;
  continuationRate: number | null;
}

export interface ActiveQueueEntry {
  id: string;
  instanceId: string;
  remoteJid: string;
  contactId: string | null;
  startedAt: string;
  urgencyScore: number;
  elapsedSeconds: number;
}

export interface OnboardingSnapshot {
  tenantId: string;
  tenantSlug: string;
  currentStep: string;
  completedAt: string | null;
  steps: Array<{
    code: string;
    label: string;
    completed: boolean;
  }>;
}

export interface AdminTenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  messagesThisMonth: number;
  messagesPerMonth: number;
  activeInstances: number;
  instanceLimit: number;
  usersLimit: number;
  rateLimitPerMinute: number;
  billingEmail: string | null;
  aiConfigured: boolean;
  aiProvider: "GROQ" | "OPENAI_COMPATIBLE" | null;
  aiModel: string | null;
  plan: {
    id: string;
    code: string;
    name: string;
  } | null;
}

export interface AdminTenantAiConfig {
  tenantId: string;
  provider: "GROQ" | "OPENAI_COMPATIBLE";
  baseUrl: string;
  model: string;
  isActive: boolean;
  isConfigured: boolean;
  hasApiKey: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BillingSummary {
  id: string;
  tenantId: string;
  tenantName: string;
  planName: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string | null;
  nextDueAt: string | null;
  suspendedAt: string | null;
  canceledAt: string | null;
}

const buildHeaders = (mode: "admin" | "tenant"): HeadersInit => {
  const session = getServerPanelSession();

  if (mode === "admin") {
    return session.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {};
  }

  if (session.accessToken) {
    return {
      authorization: `Bearer ${session.accessToken}`
    };
  }

  if (session.apiKey) {
    return {
      "x-api-key": session.apiKey
    };
  }

  return {};
};

const allowMockFallback = process.env.NODE_ENV !== "production";

const request = async <TResponse>(path: string, mode: "admin" | "tenant"): Promise<TResponse> => {
  const response = await fetch(`${internalApiBaseUrl}${path}`, {
    cache: "no-store",
    headers: buildHeaders(mode)
  });

  if (response.status === 401) {
    redirect("/login");
  }

  if (response.status === 403) {
    throw new ForbiddenError();
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return (await response.json()) as TResponse;
};

const now = new Date().toISOString();

const mockInstances: InstanceSummary[] = [
  {
    id: "tenant-demo-sales",
    tenantId: "tenant-demo",
    name: "Sales BR",
    phoneNumber: "5511999999999",
    avatarUrl: null,
    status: "CONNECTED",
    lastActivityAt: now,
    connectedAt: now,
    createdAt: now,
    updatedAt: now,
    usage: {
      instanceId: "tenant-demo-sales",
      messagesSent: 1824,
      messagesReceived: 1659,
      errors: 3,
      uptimeSeconds: 284400,
      riskScore: 14
    }
  },
  {
    id: "tenant-demo-support",
    tenantId: "tenant-demo",
    name: "Support LATAM",
    phoneNumber: "5511888888888",
    avatarUrl: null,
    status: "QR_PENDING",
    lastActivityAt: now,
    connectedAt: null,
    createdAt: now,
    updatedAt: now,
    usage: {
      instanceId: "tenant-demo-support",
      messagesSent: 421,
      messagesReceived: 512,
      errors: 1,
      uptimeSeconds: 45200,
      riskScore: 9
    }
  }
];

const mockTenantDashboard: TenantDashboardSnapshot = {
  tenantId: "tenant-demo",
  tenantName: "Acme Commerce",
  activeInstances: 2,
  totalInstances: 3,
  connectedInstances: 2,
  queuedMessages: 24,
  messagesThisMonth: 18240,
  messagesPerMonth: 50000,
  usersUsed: 3,
  usersLimit: 8,
  messagesTodayOutbound: 0,
  escalationsToday: 0,
  knowledgeLearnedToday: 0,
  resolutionRateLast7Days: 0
};

const mockOnboarding: OnboardingSnapshot = {
  tenantId: "tenant-demo",
  tenantSlug: defaultTenantSlug,
  currentStep: "INSTANCE_CONNECTED",
  completedAt: null,
  steps: [
    { code: "PASSWORD_DEFINED", label: "Definir senha", completed: true },
    { code: "INSTANCE_CREATED", label: "Criar primeira instancia", completed: true },
    { code: "INSTANCE_CONNECTED", label: "Conectar QR Code", completed: false },
    { code: "WEBHOOK_CONFIGURED", label: "Configurar webhook", completed: false }
  ]
};

const mockAdminTenants: AdminTenantSummary[] = [
  {
    id: "tenant-a",
    name: "Acme Commerce",
    slug: "acme-commerce",
    status: "ACTIVE",
    messagesThisMonth: 18240,
    messagesPerMonth: 50000,
    activeInstances: 2,
    instanceLimit: 5,
    usersLimit: 8,
    rateLimitPerMinute: 60,
    billingEmail: "billing@acme.test",
    aiConfigured: true,
    aiProvider: "GROQ",
    aiModel: "llama-3.1-8b-instant",
    plan: {
      id: "plan-scale",
      code: "SCALE_50K",
      name: "Scale 50K"
    }
  },
  {
    id: "tenant-b",
    name: "Globex Support",
    slug: "globex-support",
    status: "SUSPENDED",
    messagesThisMonth: 3100,
    messagesPerMonth: 10000,
    activeInstances: 0,
    instanceLimit: 1,
    usersLimit: 4,
    rateLimitPerMinute: 20,
    billingEmail: "billing@globex.test",
    aiConfigured: false,
    aiProvider: null,
    aiModel: null,
    plan: {
      id: "plan-starter",
      code: "STARTER_10K",
      name: "Starter 10K"
    }
  }
];

const mockBilling: BillingSummary[] = [
  {
    id: "sub-1",
    tenantId: "tenant-a",
    tenantName: "Acme Commerce",
    planName: "Scale 50K",
    status: "ACTIVE",
    currentPeriodStart: now,
    currentPeriodEnd: null,
    nextDueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    suspendedAt: null,
    canceledAt: null
  },
  {
    id: "sub-2",
    tenantId: "tenant-b",
    tenantName: "Globex Support",
    planName: "Starter 10K",
    status: "PAST_DUE",
    currentPeriodStart: now,
    currentPeriodEnd: null,
    nextDueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    suspendedAt: null,
    canceledAt: null
  }
];

const mockPlans: AdminPlanSummary[] = [
  {
    id: "plan-starter",
    code: "STARTER_10K",
    name: "Starter 10K",
    description: "Plano base para onboarding rapido de novos clientes.",
    priceCents: 9900,
    currency: "BRL",
    instanceLimit: 1,
    messagesPerMonth: 10000,
    usersLimit: 2,
    rateLimitPerMinute: 20,
    isActive: true,
    createdAt: now,
    updatedAt: now
  },
  {
    id: "plan-scale",
    code: "SCALE_50K",
    name: "Scale 50K",
    description: "Plano comercial para operacoes com maior throughput.",
    priceCents: 29900,
    currency: "BRL",
    instanceLimit: 5,
    messagesPerMonth: 50000,
    usersLimit: 8,
    rateLimitPerMinute: 60,
    isActive: true,
    createdAt: now,
    updatedAt: now
  }
];

/**
 * Lista instancias do tenant atual e faz fallback para dados demo quando a API nao responde.
 */
export const getTenantInstances = async (): Promise<InstanceSummary[]> => {
  try {
    return await request<InstanceSummary[]>("/instances", "tenant");
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (allowMockFallback) {
      return mockInstances;
    }

    throw new Error("Falha ao carregar as instancias do tenant.");
  }
};

/**
 * Mantem compatibilidade com o grid operacional legado.
 */
export const getInstances = getTenantInstances;

/**
 * Carrega o dashboard principal do tenant.
 */
export const getTenantDashboard = async (): Promise<TenantDashboardSnapshot> => {
  try {
    return await request<TenantDashboardSnapshot>("/tenant/dashboard", "tenant");
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (allowMockFallback) {
      return mockTenantDashboard;
    }

    throw new Error("Falha ao carregar o dashboard do tenant.");
  }
};

/**
 * Carrega metricas de atendimento do dia corrente para o tenant.
 */
export async function getTenantTodayMetrics(): Promise<TodayMetricsSnapshot> {
  try {
    return await request<TodayMetricsSnapshot>("/tenant/metrics/today", "tenant");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return {
      startedCount: 0,
      endedCount: 0,
      inactiveCount: 0,
      handoffCount: 0,
      avgDurationSeconds: null,
      avgFirstResponseMs: null,
      continuationRate: null,
    };
  }
}

/**
 * Carrega a fila de atendimentos ativos ordenada por urgencia.
 */
export async function getTenantActiveQueue(): Promise<ActiveQueueEntry[]> {
  try {
    return await request<ActiveQueueEntry[]>("/tenant/metrics/queue", "tenant");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return [];
  }
}

/**
 * Carrega o estado do onboarding guiado do tenant.
 */
export const getTenantOnboarding = async (): Promise<OnboardingSnapshot> => {
  try {
    return await request<OnboardingSnapshot>("/tenant/onboarding", "tenant");
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (allowMockFallback) {
      return mockOnboarding;
    }

    throw new Error("Falha ao carregar o onboarding do tenant.");
  }
};

/**
 * Lista tenants do painel super admin.
 */
export const getAdminTenants = async (): Promise<AdminTenantSummary[]> => {
  try {
    return await request<AdminTenantSummary[]>("/admin/tenants", "admin");
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (error instanceof ForbiddenError) {
      throw error;
    }

    if (allowMockFallback) {
      return mockAdminTenants;
    }

    throw new Error("Falha ao carregar os tenants.");
  }
};

/**
 * Lista visao financeira resumida do painel InfraCode.
 */
export const getAdminBilling = async (): Promise<BillingSummary[]> => {
  try {
    return await request<BillingSummary[]>("/admin/billing", "admin");
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (error instanceof ForbiddenError) {
      throw error;
    }

    if (allowMockFallback) {
      return mockBilling;
    }

    throw new Error("Falha ao carregar o billing.");
  }
};

/**
 * Lista planos comerciais disponiveis para provisionamento de tenants.
 */
export const getAdminPlans = async (): Promise<AdminPlanSummary[]> => {
  try {
    return await request<AdminPlanSummary[]>("/admin/plans", "admin");
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (error instanceof ForbiddenError) {
      throw error;
    }

    if (allowMockFallback) {
      return mockPlans;
    }

    throw new Error("Falha ao carregar os planos.");
  }
};

/**
 * Expose o runtime efetivo usado pelo painel no SSR.
 */
export const getServerPanelConfig = () => {
  const session = getServerPanelSession();

  return {
    apiBaseUrl: publicApiBaseUrl,
    internalApiBaseUrl,
    tenantAccessToken: session.accessToken ?? "",
    tenantApiKey: session.apiKey ?? "",
    tenantSlug: session.tenantSlug ?? defaultTenantSlug
  };
};
export interface AdminPlanSummary {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  priceCents: number;
  currency: string;
  instanceLimit: number;
  messagesPerMonth: number;
  usersLimit: number;
  rateLimitPerMinute: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
