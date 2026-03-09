import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { injectable, inject } from "tsyringe";
import { Agent } from "src/agent/agent.js";
import { ChannelManager } from "src/channels/channelmanager.js";
import { SessionManager } from "src/session/manager.js";
import { MessageBus } from "src/messagebus/queue.js";
import { Logger } from "src/utils/logger.js";

type SessionEntry = {
    key: string;
    lastChannel: string | null;
    lastTo: string | null;
    updatedAt: string;
};

type ShutdownManifest = {
    timestamp: string;
    sessions: SessionEntry[];
};

const RESUME_ACTIVE_HOURS = 24;
const CHANNEL_STOP_TIMEOUT_MS = 3000;

@injectable()
export class ShutdownService {
    private logger = new Logger(ShutdownService.name);
    private manifestPath: string;
    private shuttingDown = false;

    constructor(
        @inject(Agent) private agent: Agent,
        @inject(ChannelManager) private channelManager: ChannelManager,
        @inject(SessionManager) private sessions: SessionManager,
        @inject(MessageBus) private bus: MessageBus,
        @inject("dataPath") dataPath: string
    ) {
        this.manifestPath = join(dataPath, "shutdown.json");
    }

    register(): void {
        process.once("SIGTERM", () => void this.shutdown("SIGTERM"));
        process.once("SIGINT", () => void this.shutdown("SIGINT"));
        process.once("SIGUSR2", () => void this.shutdown("SIGUSR2"));
        this.logger.info("Shutdown handlers registered");
    }

    private async shutdown(signal: string): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        this.logger.info(`Received ${signal}, shutting down gracefully`);

        this.agent.stop();
        this.sessions.saveAll();
        this.writeManifest();

        try {
            await Promise.race([
                this.channelManager.stopAll(),
                new Promise<void>((resolve) => setTimeout(resolve, CHANNEL_STOP_TIMEOUT_MS))
            ]);
        } catch (err) {
            this.logger.warn("Error during channel shutdown", { error: String(err) });
        }

        this.logger.info("Shutdown complete");
        process.exit(0);
    }

    private writeManifest(): void {
        const sessions = this.sessions.listRecentSessions(RESUME_ACTIVE_HOURS);
        const manifest: ShutdownManifest = {
            timestamp: new Date().toISOString(),
            sessions
        };
        writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
        this.logger.info("Shutdown manifest written", { sessions: sessions.length, path: this.manifestPath });
    }

    async resumeFromLastShutdown(): Promise<void> {
        if (!existsSync(this.manifestPath)) return;

        let manifest: ShutdownManifest;
        try {
            manifest = JSON.parse(readFileSync(this.manifestPath, "utf-8")) as ShutdownManifest;
            unlinkSync(this.manifestPath);
        } catch (err) {
            this.logger.warn("Failed to read shutdown manifest", { error: String(err) });
            return;
        }

        const shutdownAt = new Date(manifest.timestamp);
        const downtimeSeconds = Math.round((Date.now() - shutdownAt.getTime()) / 1000);

        this.logger.info("Resuming from previous shutdown", {
            shutdownAt: manifest.timestamp,
            downtimeSeconds,
            sessions: manifest.sessions.length
        });

        for (const session of manifest.sessions) {
            if (!session.lastChannel || !session.lastTo) continue;
            if (session.lastChannel === "cli" || session.lastChannel === "direct") continue;
/*
            await this.bus.publishInbound({
                channel: "system",
                senderId: "system",
                chatId: `${session.lastChannel}:${session.lastTo}`,
                content: `The assistant has restarted and is back online (was down for ${formatDuration(downtimeSeconds)}). Send the user a short, friendly message letting them know you are ready to continue. One sentence only.`,
                timestamp: new Date(),
                media: [],
                metadata: {}
            });
            */
        }
    }
}

function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
    return `${Math.round(seconds / 3600)}h`;
}
