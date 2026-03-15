import type { FastifyInstance } from "fastify";
import {
  acceptInvitationBodySchema,
  authTokenResponseSchema,
  forgotPasswordBodySchema,
  forgotPasswordResponseSchema,
  invitationAcceptResponseSchema,
  loginBodySchema,
  logoutBodySchema,
  meResponseSchema,
  refreshBodySchema,
  resetPasswordBodySchema,
  totpSetupResponseSchema,
  totpVerifyBodySchema,
  totpVerifyResponseSchema
} from "./schemas.js";

/**
 * Registra rotas de autenticacao humana do painel SaaS.
 */
export const registerAuthRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post(
    "/auth/login",
    {
      config: {
        auth: false
      },
      schema: {
        tags: ["Auth"],
        summary: "Realiza login no painel super admin ou no painel do tenant",
        body: loginBodySchema,
        response: {
          200: authTokenResponseSchema
        }
      }
    },
    async (request) => {
      const body = loginBodySchema.parse(request.body);
      return app.authService.login(
        {
          ...body,
          tenantSlug: body.tenantSlug ?? request.auth.tenantSlug
        },
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"]?.toString()
        }
      );
    }
  );

  app.post(
    "/auth/logout",
    {
      config: {
        auth: false
      },
      schema: {
        tags: ["Auth"],
        summary: "Revoga um refresh token emitido anteriormente",
        body: logoutBodySchema
      }
    },
    async (request, reply) => {
      const body = logoutBodySchema.parse(request.body);
      await app.authService.logout(body.refreshToken);
      reply.code(204);
      return null;
    }
  );

  app.post(
    "/auth/refresh",
    {
      config: {
        auth: false
      },
      schema: {
        tags: ["Auth"],
        summary: "Rotaciona um refresh token e devolve novos tokens",
        body: refreshBodySchema,
        response: {
          200: authTokenResponseSchema
        }
      }
    },
    async (request) => {
      const body = refreshBodySchema.parse(request.body);
      return app.authService.refresh(body.refreshToken, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]?.toString()
      });
    }
  );

  app.post(
    "/auth/invitations/accept",
    {
      config: {
        auth: false
      },
      schema: {
        tags: ["Auth"],
        summary: "Aceita o convite de primeiro acesso do tenant",
        body: acceptInvitationBodySchema,
        response: {
          200: invitationAcceptResponseSchema
        }
      }
    },
    async (request) => {
      const body = acceptInvitationBodySchema.parse(request.body);
      return app.authService.acceptInvitation(body, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]?.toString()
      });
    }
  );

  app.post(
    "/auth/password/forgot",
    {
      config: {
        auth: false
      },
      schema: {
        tags: ["Auth"],
        summary: "Solicita o envio de token de redefinicao de senha",
        body: forgotPasswordBodySchema,
        response: {
          200: forgotPasswordResponseSchema
        }
      }
    },
    async (request) => {
      const body = forgotPasswordBodySchema.parse(request.body);
      await app.authService.forgotPassword(body.email);
      return {
        accepted: true as const
      };
    }
  );

  app.post(
    "/auth/password/reset",
    {
      config: {
        auth: false
      },
      schema: {
        tags: ["Auth"],
        summary: "Consome um token valido de redefinicao de senha",
        body: resetPasswordBodySchema
      }
    },
    async (request, reply) => {
      const body = resetPasswordBodySchema.parse(request.body);
      await app.authService.resetPassword(body.token, body.password);
      reply.code(204);
      return null;
    }
  );

  app.post(
    "/auth/totp/setup",
    {
      config: {
        auth: "any"
      },
      schema: {
        tags: ["Auth"],
        summary: "Gera o segredo TOTP pendente do usuario autenticado",
        response: {
          200: totpSetupResponseSchema
        }
      }
    },
    async (request) => {
      const me = await app.authService.getMe(request.auth);

      if (!me.user) {
        throw app.httpErrors.forbidden("Somente usuarios humanos podem ativar TOTP");
      }

      return app.authService.setupTotp(me.user.id, me.user.email);
    }
  );

  app.post(
    "/auth/totp/verify",
    {
      config: {
        auth: "any"
      },
      schema: {
        tags: ["Auth"],
        summary: "Valida e ativa o TOTP pendente do usuario autenticado",
        body: totpVerifyBodySchema,
        response: {
          200: totpVerifyResponseSchema
        }
      }
    },
    async (request) => {
      const me = await app.authService.getMe(request.auth);

      if (!me.user) {
        throw app.httpErrors.forbidden("Somente usuarios humanos podem validar TOTP");
      }

      const body = totpVerifyBodySchema.parse(request.body);
      return app.authService.verifyTotp(me.user.id, body.code);
    }
  );

  app.get(
    "/me",
    {
      config: {
        auth: "any"
      },
      schema: {
        tags: ["Auth"],
        summary: "Retorna o contexto autenticado atual",
        response: {
          200: meResponseSchema
        }
      }
    },
    async (request) => app.authService.getMe(request.auth)
  );
};
