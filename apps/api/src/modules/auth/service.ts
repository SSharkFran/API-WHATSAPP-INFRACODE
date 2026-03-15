import { randomBytes } from "node:crypto";
import { sha256 } from "../../lib/crypto.js";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";
import type { EmailService } from "../../lib/mail.js";
import { verifyPassword, hashPassword } from "../../lib/password.js";
import { createRefreshToken, signAccessToken } from "../../lib/tokens.js";
import { createTotpSecret, verifyTotpCode } from "../../lib/totp.js";
import {
  dedupeScopes,
  getScopesForPlatformRole,
  getScopesForTenantRole,
  isPlatformRole,
  isTenantRole,
  type AuthContext,
  type PlatformRole,
  type TenantRole
} from "../../lib/authz.js";

interface AuthServiceDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  emailService: EmailService;
}

interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

interface LoginInput {
  email: string;
  password: string;
  tenantSlug?: string;
  totpCode?: string;
  backupCode?: string;
}

interface AcceptInvitationInput {
  token: string;
  name: string;
  password: string;
}

/**
 * Implementa autenticacao humana, convites, refresh token e TOTP.
 */
export class AuthService {
  private readonly config: AppConfig;
  private readonly platformPrisma: PlatformPrisma;
  private readonly emailService: EmailService;

  public constructor(deps: AuthServiceDeps) {
    this.config = deps.config;
    this.platformPrisma = deps.platformPrisma;
    this.emailService = deps.emailService;
  }

  /**
   * Realiza login no painel da InfraCode ou de um tenant especifico.
   */
  public async login(input: LoginInput, requestMeta: RequestMeta) {
    const user = await this.platformPrisma.user.findUnique({
      where: {
        email: input.email.toLowerCase()
      }
    });

    if (!user?.passwordHash || !user.isActive || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Credenciais invalidas");
    }

    await this.validateSecondFactor(user, input.totpCode, input.backupCode);

    if (input.tenantSlug) {
      const tenant = await this.requireActiveTenantBySlug(input.tenantSlug);
      const membership = await this.platformPrisma.tenantMembership.findFirst({
        where: {
          tenantId: tenant.id,
          userId: user.id
        }
      });

      if (!membership || !isTenantRole(membership.role)) {
        throw new ApiError(403, "TENANT_ACCESS_DENIED", "Usuario sem acesso a este tenant");
      }

      return this.createSession({
        requestMeta,
        tenantId: tenant.id,
        tenantRole: membership.role,
        userId: user.id
      });
    }

    if (!isPlatformRole(user.platformRole)) {
      throw new ApiError(
        400,
        "TENANT_SLUG_REQUIRED",
        "Informe o tenant ou utilize o subdominio do cliente para login no painel do tenant"
      );
    }

    return this.createSession({
      platformRole: user.platformRole,
      requestMeta,
      userId: user.id
    });
  }

  /**
   * Aceita um convite pendente, cria/atualiza o usuario e inicia uma sessao autenticada.
   */
  public async acceptInvitation(input: AcceptInvitationInput, requestMeta: RequestMeta) {
    const invitation = await this.platformPrisma.invitation.findUnique({
      where: {
        tokenHash: sha256(input.token)
      },
      include: {
        tenant: true
      }
    });

    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
      throw new ApiError(400, "INVITATION_INVALID", "Convite invalido ou expirado");
    }

    if (!isTenantRole(invitation.role)) {
      throw new ApiError(500, "INVITATION_ROLE_INVALID", "Role de convite invalida");
    }

    const passwordHash = await hashPassword(input.password);
    const existingUser = await this.platformPrisma.user.findUnique({
      where: {
        email: invitation.email.toLowerCase()
      }
    });

    const user =
      existingUser ??
      (await this.platformPrisma.user.create({
        data: {
          email: invitation.email.toLowerCase(),
          name: input.name,
          passwordHash,
          isActive: true
        }
      }));

    if (existingUser) {
      await this.platformPrisma.user.update({
        where: {
          id: user.id
        },
        data: {
          isActive: true,
          name: input.name,
          passwordHash
        }
      });
    }

    await this.platformPrisma.tenantMembership.upsert({
      where: {
        tenantId_userId: {
          tenantId: invitation.tenantId,
          userId: user.id
        }
      },
      update: {
        role: invitation.role
      },
      create: {
        tenantId: invitation.tenantId,
        userId: user.id,
        role: invitation.role
      }
    });

    await this.platformPrisma.invitation.update({
      where: {
        id: invitation.id
      },
      data: {
        acceptedAt: new Date()
      }
    });

    const session = await this.createSession({
      requestMeta,
      tenantId: invitation.tenantId,
      tenantRole: invitation.role,
      userId: user.id
    });

    await this.platformPrisma.tenant.update({
      where: {
        id: invitation.tenantId
      },
      data: {
        onboardingStep: "PASSWORD_DEFINED"
      }
    });

    return {
      ...session,
      tenantId: invitation.tenantId,
      tenantSlug: invitation.tenant.slug
    };
  }

  /**
   * Rotaciona um refresh token valido e emite um novo par de tokens.
   */
  public async refresh(refreshToken: string, requestMeta: RequestMeta) {
    const session = await this.platformPrisma.refreshSession.findUnique({
      where: {
        tokenHash: sha256(refreshToken)
      },
      include: {
        user: true
      }
    });

    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new ApiError(401, "REFRESH_TOKEN_INVALID", "Refresh token invalido ou expirado");
    }

    const user = session.user;

    if (!user.isActive) {
      throw new ApiError(403, "USER_DISABLED", "Usuario inativo");
    }

    let tenantRole: TenantRole | undefined;
    let platformRole: PlatformRole | undefined;

    if (session.tenantId) {
      const tenant = await this.requireActiveTenant(session.tenantId);

      if (session.impersonatedByUserId) {
        tenantRole = "ADMIN";
        platformRole = isPlatformRole(user.platformRole) ? user.platformRole : undefined;
        await this.ensureImpersonationIsActive(session.impersonatedByUserId, tenant.id);
      } else {
        const membership = await this.platformPrisma.tenantMembership.findFirst({
          where: {
            tenantId: tenant.id,
            userId: user.id
          }
        });

        if (!membership || !isTenantRole(membership.role)) {
          throw new ApiError(403, "TENANT_ACCESS_DENIED", "Sessao sem acesso ao tenant");
        }

        tenantRole = membership.role;
      }
    } else if (isPlatformRole(user.platformRole)) {
      platformRole = user.platformRole;
    } else {
      throw new ApiError(403, "PLATFORM_ACCESS_DENIED", "Sessao sem permissao de plataforma");
    }

    await this.platformPrisma.refreshSession.update({
      where: {
        id: session.id
      },
      data: {
        revokedAt: new Date()
      }
    });

    return this.createSession({
      impersonatedByUserId: session.impersonatedByUserId ?? undefined,
      platformRole,
      requestMeta,
      tenantId: session.tenantId ?? undefined,
      tenantRole,
      userId: user.id
    });
  }

  /**
   * Revoga explicitamente um refresh token emitido anteriormente.
   */
  public async logout(refreshToken: string): Promise<void> {
    const tokenHash = sha256(refreshToken);
    const session = await this.platformPrisma.refreshSession.findUnique({
      where: {
        tokenHash
      }
    });

    if (!session || session.revokedAt) {
      return;
    }

    await this.platformPrisma.refreshSession.update({
      where: {
        id: session.id
      },
      data: {
        revokedAt: new Date()
      }
    });
  }

  /**
   * Gera token de redefinicao de senha e envia uma notificacao transacional.
   */
  public async forgotPassword(email: string): Promise<void> {
    const user = await this.platformPrisma.user.findUnique({
      where: {
        email: email.toLowerCase()
      }
    });

    if (!user) {
      return;
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + this.config.PASSWORD_RESET_TTL_HOURS * 60 * 60 * 1000);

    await this.platformPrisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt
      }
    });

    await this.emailService.sendTemplate({
      subject: "InfraCode | Redefinicao de senha",
      template: "password-reset",
      to: user.email,
      variables: {
        expiresAt: expiresAt.toISOString(),
        resetUrl: `https://${this.config.ADMIN_SUBDOMAIN}.${this.config.ROOT_DOMAIN}/redefinir-senha?token=${token}`,
        userName: user.name
      }
    });
  }

  /**
   * Consome um token de redefinicao de senha e atualiza a credencial do usuario.
   */
  public async resetPassword(token: string, password: string): Promise<void> {
    const passwordResetToken = await this.platformPrisma.passwordResetToken.findUnique({
      where: {
        tokenHash: sha256(token)
      }
    });

    if (!passwordResetToken || passwordResetToken.consumedAt || passwordResetToken.expiresAt <= new Date()) {
      throw new ApiError(400, "PASSWORD_RESET_INVALID", "Token de redefinicao invalido ou expirado");
    }

    const passwordHash = await hashPassword(password);

    await this.platformPrisma.$transaction([
      this.platformPrisma.user.update({
        where: {
          id: passwordResetToken.userId
        },
        data: {
          passwordHash
        }
      }),
      this.platformPrisma.passwordResetToken.update({
        where: {
          id: passwordResetToken.id
        },
        data: {
          consumedAt: new Date()
        }
      })
    ]);
  }

  /**
   * Prepara um novo segredo TOTP para vinculacao ao usuario atual.
   */
  public async setupTotp(userId: string, email: string) {
    const secret = createTotpSecret(email, "InfraCode");

    await this.platformPrisma.user.update({
      where: {
        id: userId
      },
      data: {
        pendingTotpSecret: secret.base32
      }
    });

    return {
      secret: secret.base32,
      uri: secret.uri
    };
  }

  /**
   * Ativa ou valida o TOTP do usuario autenticado.
   */
  public async verifyTotp(userId: string, code: string) {
    const user = await this.platformPrisma.user.findUnique({
      where: {
        id: userId
      }
    });

    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "Usuario nao encontrado");
    }

    const secret = user.pendingTotpSecret ?? user.totpSecret;

    if (!secret || !verifyTotpCode(secret, code)) {
      throw new ApiError(400, "TOTP_CODE_INVALID", "Codigo TOTP invalido");
    }

    if (!user.pendingTotpSecret) {
      return {
        enabled: true
      };
    }

    const backupCodes = Array.from({ length: 8 }, () => randomBytes(5).toString("hex"));

    await this.platformPrisma.user.update({
      where: {
        id: userId
      },
      data: {
        backupCodes: backupCodes.map((value) => sha256(value)),
        pendingTotpSecret: null,
        totpSecret: secret,
        twoFactorEnabled: true
      }
    });

    return {
      enabled: true,
      backupCodes
    };
  }

  /**
   * Carrega um resumo do ator autenticado para o frontend.
   */
  public async getMe(auth: AuthContext) {
    const tenant = auth.tenantId
      ? await this.platformPrisma.tenant.findUnique({
          where: {
            id: auth.tenantId
          }
        })
      : null;

    if (auth.actorType === "API_KEY") {
      return {
        actorId: auth.actorId ?? null,
        actorType: auth.actorType,
        impersonatedBy: auth.impersonatedBy ?? null,
        platformRole: auth.platformRole ?? null,
        scopes: auth.scopes,
        tenant: tenant
          ? {
              id: tenant.id,
              name: tenant.name,
              slug: tenant.slug,
              status: tenant.status
            }
          : null,
        tenantId: auth.tenantId ?? null,
        tenantRole: auth.tenantRole ?? null,
        tenantSlug: auth.tenantSlug ?? null,
        user: null
      };
    }

    if (!auth.userId) {
      throw new ApiError(401, "UNAUTHENTICATED", "Sessao invalida");
    }

    const user = await this.platformPrisma.user.findUnique({
      where: {
        id: auth.userId
      }
    });

    if (!user) {
      throw new ApiError(401, "UNAUTHENTICATED", "Sessao invalida");
    }

    return {
      actorId: auth.actorId ?? null,
      actorType: auth.actorType,
      impersonatedBy: auth.impersonatedBy ?? null,
      platformRole: auth.platformRole ?? null,
      scopes: auth.scopes,
      tenant: tenant
        ? {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            status: tenant.status
          }
        : null,
      tenantId: auth.tenantId ?? null,
      tenantRole: auth.tenantRole ?? null,
      tenantSlug: auth.tenantSlug ?? null,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        twoFactorEnabled: user.twoFactorEnabled
      }
    };
  }

  /**
   * Emite uma sessao de impersonation do super admin para um tenant.
   */
  public async createImpersonationSession(platformUserId: string, tenantId: string, reason: string, requestMeta: RequestMeta) {
    const user = await this.platformPrisma.user.findUnique({
      where: {
        id: platformUserId
      }
    });

    if (!user || !isPlatformRole(user.platformRole)) {
      throw new ApiError(403, "PLATFORM_ACCESS_DENIED", "Somente usuarios da InfraCode podem impersonar tenants");
    }

    await this.requireActiveTenant(tenantId);
    const expiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    const opaque = createRefreshToken();

    await this.platformPrisma.impersonationSession.create({
      data: {
        platformUserId,
        tenantId,
        sessionTokenHash: opaque.hash,
        reason,
        expiresAt
      }
    });

    return this.createSession({
      impersonatedByUserId: platformUserId,
      platformRole: user.platformRole,
      requestMeta,
      tenantId,
      tenantRole: "ADMIN",
      userId: user.id
    });
  }

  private async createSession(input: {
    userId: string;
    tenantId?: string;
    tenantRole?: TenantRole;
    platformRole?: PlatformRole;
    requestMeta: RequestMeta;
    impersonatedByUserId?: string;
  }) {
    const refreshToken = createRefreshToken();
    const expiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    const accessToken = await signAccessToken(this.config, {
      actorId: input.userId,
      actorType: input.tenantId ? "TENANT_USER" : "PLATFORM_USER",
      impersonatedBy: input.impersonatedByUserId,
      platformRole: input.platformRole,
      tenantId: input.tenantId,
      tenantRole: input.tenantRole
    });

    await this.platformPrisma.refreshSession.create({
      data: {
        expiresAt,
        impersonatedByUserId: input.impersonatedByUserId ?? null,
        ipAddress: input.requestMeta.ipAddress,
        tenantId: input.tenantId ?? null,
        tokenHash: refreshToken.hash,
        userAgent: input.requestMeta.userAgent,
        userId: input.userId
      }
    });

    await this.platformPrisma.user.update({
      where: {
        id: input.userId
      },
      data: {
        lastLoginAt: new Date()
      }
    });

    return {
      accessToken,
      expiresInSeconds: this.config.ACCESS_TOKEN_TTL_MINUTES * 60,
      refreshToken: refreshToken.value,
      scopes: dedupeScopes([
        ...(input.platformRole ? getScopesForPlatformRole(input.platformRole) : []),
        ...(input.tenantRole ? getScopesForTenantRole(input.tenantRole) : [])
      ])
    };
  }

  private async requireActiveTenantBySlug(slug: string) {
    const tenant = await this.platformPrisma.tenant.findUnique({
      where: {
        slug
      }
    });

    if (!tenant) {
      throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant nao encontrado");
    }

    if (tenant.status !== "ACTIVE" || tenant.suspendedAt || tenant.maintenanceMode) {
      throw new ApiError(403, "TENANT_SUSPENDED", "Tenant suspenso ou indisponivel");
    }

    return tenant;
  }

  private async requireActiveTenant(tenantId: string) {
    const tenant = await this.platformPrisma.tenant.findUnique({
      where: {
        id: tenantId
      }
    });

    if (!tenant) {
      throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant nao encontrado");
    }

    if (tenant.status !== "ACTIVE" || tenant.suspendedAt) {
      throw new ApiError(403, "TENANT_SUSPENDED", "Tenant suspenso ou indisponivel");
    }

    return tenant;
  }

  private async validateSecondFactor(
    user: {
      id: string;
      twoFactorEnabled: boolean;
      totpSecret: string | null;
      backupCodes: string[];
    },
    totpCode?: string,
    backupCode?: string
  ): Promise<void> {
    if (!user.twoFactorEnabled) {
      return;
    }

    if (user.totpSecret && totpCode && verifyTotpCode(user.totpSecret, totpCode)) {
      return;
    }

    if (backupCode) {
      const backupHash = sha256(backupCode);

      if (user.backupCodes.includes(backupHash)) {
        await this.platformPrisma.user.update({
          where: {
            id: user.id
          },
          data: {
            backupCodes: user.backupCodes.filter((value) => value !== backupHash)
          }
        });
        return;
      }
    }

    throw new ApiError(401, "SECOND_FACTOR_REQUIRED", "Codigo TOTP ou backup code invalido");
  }

  private async ensureImpersonationIsActive(platformUserId: string, tenantId: string): Promise<void> {
    const active = await this.platformPrisma.impersonationSession.findFirst({
      where: {
        expiresAt: {
          gt: new Date()
        },
        platformUserId,
        revokedAt: null,
        tenantId
      }
    });

    if (!active) {
      throw new ApiError(401, "IMPERSONATION_EXPIRED", "Sessao de impersonacao expirada");
    }
  }
}
