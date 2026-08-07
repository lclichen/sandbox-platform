/**
 * Pino logger. Pretty-prints in development, JSON in production.
 */
import pino from "pino";
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
