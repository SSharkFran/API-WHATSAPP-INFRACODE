import "server-only";
import type { InstanceSummary } from "@infracode/types";
import { getServerPanelSession } from "./server-session";

const publicApiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3333").replace(/\/$/, "");
const internalApiBaseUrl = (process.env.API_INTERNAL_BASE_URL ?? publicApiBaseUrl).replace(/\/$/, "");
const defaultTenantSlug = process.env.NEXT_PUBLIC_DEFAULT_TENANT ?? "tenant-demo";

interface TenantDashboardSnapshot {
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
}

interface OnboardingSnapshot {
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

interface AdminTenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  messagesThisMonth: number;
  messagesPerMonth: number;
  activeInstances: number;
  usersLimit: number;
  billingEmail: string | null;
  plan: {
    id: string;
    code: string;
    name: string;
  } | null;
}

interface BillingSummary {
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

const request = async <TResponse>(path: string, mode: "admin" | "tenant"): Promise<TResponse> => {
  const response = await fetch(`${internalApiBaseUrl}${path}`, {
    cache: "no-store",
    headers: buildHeaders(mode)
  });

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
  usersLimit: 8
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
    usersLimit: 8,
    billingEmail: "billing@acme.test",
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
    usersLimit: 4,
    billingEmail: "billing@globex.test",
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

/**
 * Lista instancias do tenant atual e faz fallback para dados demo quando a API nao responde.
 */
export const getTenantInstances = async (): Promise<InstanceSummary[]> => {
  try {
    return await request<InstanceSummary[]>("/instances", "tenant");
  } catch {
    return mockInstances;
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
  } catch {
    return mockTenantDashboard;
  }
};

/**
 * Carrega o estado do onboarding guiado do tenant.
 */
export const getTenantOnboarding = async (): Promise<OnboardingSnapshot> => {
  try {
    return await request<OnboardingSnapshot>("/tenant/onboarding", "tenant");
  } catch {
    return mockOnboarding;
  }
};

/**
 * Lista tenants do painel super admin.
 */
export const getAdminTenants = async (): Promise<AdminTenantSummary[]> => {
  try {
    return await request<AdminTenantSummary[]>("/admin/tenants", "admin");
  } catch {
    return mockAdminTenants;
  }
};

/**
 * Lista visao financeira resumida do painel InfraCode.
 */
export const getAdminBilling = async (): Promise<BillingSummary[]> => {
  try {
    return await request<BillingSummary[]>("/admin/billing", "admin");
  } catch {
    return mockBilling;
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
