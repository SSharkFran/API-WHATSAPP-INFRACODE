import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler
} from "fastify-type-provider-zod";
import type { FastifyPluginAsync } from "fastify";

/**
 * Registra OpenAPI 3.1 e UI Swagger com schemas Zod.
 */
export const swaggerPlugin: FastifyPluginAsync = fp(async (app) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: {
        title: app.config.APP_NAME,
        version: "0.1.0",
        description: "InfraCode WhatsApp API Platform"
      },
      servers: [{ url: app.config.PUBLIC_API_BASE_URL }]
    },
    transform: jsonSchemaTransform
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: false
    }
  });
});
