import { buildApp } from "./app.js";

const bootstrap = async (): Promise<void> => {
  const app = await buildApp();

  try {
    try {
      await app.instanceOrchestrator.bootstrapPersistedInstances();
    } catch (error) {
      app.log.warn({ err: error }, "Falha ao bootstrapar instancias persistidas; API seguira inicializando");
    }

    await app.listen({
      host: app.config.HOST,
      port: app.config.PORT
    });

    app.log.info({ port: app.config.PORT }, "InfraCode API iniciada");
  } catch (error) {
    app.log.error({ err: error }, "Falha ao iniciar a API");
    process.exitCode = 1;
    await app.close();
  }
};

void bootstrap();
