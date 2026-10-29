import 'dotenv/config';
import { SIMULATION_DISCLAIMER } from '@spb/shared';
import { ConfigError, loadConfig } from './config/env';
import { buildApp } from './app';
import { redactDbUrl } from './database/db';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n[config] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;
  const app = await buildApp(config, {
    startScheduler: true,
    logger: pretty
      ? { level: config.logLevel, transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
      : { level: config.logLevel },
  });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.warn(SIMULATION_DISCLAIMER);
  app.log.info(
    { provider: config.marketProvider, database: redactDbUrl(config.databaseUrl) },
    `Paper bot API listening on http://${config.host}:${config.port} (bot is STOPPED until started)`,
  );
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
