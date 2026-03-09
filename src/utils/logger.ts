import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { resolve } from "path";
import { getDataPath } from "./util.js";

const LOG_LEVEL = process.env.LOG_LEVEL ?? "debug";
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS ?? "7", 10);

const logDir = resolve(getDataPath(), "logs");

const consoleFormat = winston.format.combine(
    winston.format.colorize({ level: true }),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message, className, ...meta }) => {
        const classPart = className ? ` [${String(className)}]` : "";
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
        return `${String(timestamp)}${classPart} ${level}: ${String(message)}${metaStr}`;
    })
);

const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

const winstonLogger = winston.createLogger({
    level: LOG_LEVEL,
    transports: [
        new winston.transports.Console({ format: consoleFormat }),
        new DailyRotateFile({
            dirname: logDir,
            filename: "verox-%DATE%.log",
            datePattern: "YYYY-MM-DD",
            maxFiles: `${LOG_RETENTION_DAYS}d`,
            zippedArchive: true,
            format: fileFormat,
            level: "debug"
        })
    ]
});

export class Logger {
    constructor(private readonly className: string) {}

    debug(message: string, meta?: Record<string, unknown>): void {
        winstonLogger.debug(message, { className: this.className, ...meta });
    }

    info(message: string, meta?: Record<string, unknown>): void {
        winstonLogger.info(message, { className: this.className, ...meta });
    }

    warn(message: string, meta?: Record<string, unknown>): void {
        winstonLogger.warn(message, { className: this.className, ...meta });
    }

    error(message: string, meta?: Record<string, unknown>): void {
        winstonLogger.error(message, { className: this.className, ...meta });
    }
}
