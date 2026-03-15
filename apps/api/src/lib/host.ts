/**
 * Resolve o slug do tenant a partir do hostname esperado no modelo SaaS por subdominio.
 */
export const resolveTenantSlugFromHostname = (
  hostname: string,
  rootDomain: string,
  adminSubdomain: string
): string | undefined => {
  const normalizedHost = hostname.toLowerCase();
  const normalizedRoot = rootDomain.toLowerCase();
  const normalizedAdmin = adminSubdomain.toLowerCase();

  if (normalizedHost === normalizedRoot || normalizedHost === `${normalizedAdmin}.${normalizedRoot}`) {
    return undefined;
  }

  if (!normalizedHost.endsWith(`.${normalizedRoot}`)) {
    return undefined;
  }

  const candidate = normalizedHost.slice(0, normalizedHost.length - normalizedRoot.length - 1);

  if (!candidate || candidate === normalizedAdmin || candidate.includes(".")) {
    return undefined;
  }

  return candidate;
};

/**
 * Indica se o hostname atual pertence ao painel super admin da InfraCode.
 */
export const isAdminHostname = (hostname: string, rootDomain: string, adminSubdomain: string): boolean =>
  hostname.toLowerCase() === `${adminSubdomain}.${rootDomain}`.toLowerCase();
