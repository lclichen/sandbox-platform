/**
 * Pino logger. Pretty-prints in development, JSON in production.
 *
 * pino ships CJS with an ESM-style d.ts; under NodeNext the default import
 * loses its call signature. The named export keeps both the type and the
 * runtime value (cjs-module-lexer resolves `pino` on the CJS module).
 */
import { pino } from "pino";
import { loadConfig } from "../config.ts";

const config = loadConfig();

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (config.nodeEnv === "production" ? "info" : "debug"),
  ...(config.nodeEnv === "production"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
        },
      }),
});

export type Logger = typeof logger;
