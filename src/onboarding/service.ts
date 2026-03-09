import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { VaultService } from "src/vault/credentials.js";
import type { ConfigService } from "src/config/service.js";
import { VAULT_KEY } from "src/api/constants.js";

export type OnboardingStep = "vault_key" | "webui_token" | "provider" | "complete";

/**
 * Derives the current onboarding wizard step purely from real system state.
 * Reads the live config on every call so the step advances immediately after
 * the user saves their API key — no restart needed to detect the change.
 */
export class OnboardingService {
  private readonly suggestionFile: string;

  constructor(
    private readonly dataPath: string,
    private readonly vaultService: VaultService,
    private readonly configService: ConfigService,
  ) {
    this.suggestionFile = join(dataPath, ".onboarding");
  }

  getStep(): OnboardingStep {
    if (!this.vaultService.isAvailable()) return "vault_key";

    const hasToken = !!this.vaultService.get(VAULT_KEY)
                  || !!this.configService.app.channels.webchat.uiToken;
    if (!hasToken) return "webui_token";

    // Read providers directly from the current config (which ConfigService reloads
    // on disk change) so we detect a newly saved API key without a process restart.
    const providers = this.configService.app.providers as Record<string, { apiKey?: string } | undefined>;
    const hasProvider = Object.values(providers).some(p => !!p?.apiKey);
    if (!hasProvider) return "provider";

    return "complete";
  }

  /**
   * Returns the same generated vault key suggestion on every call.
   * Persisted in {dataPath}/.onboarding so it survives HTTP requests and
   * page refreshes. Deleted automatically once vault becomes available.
   */
  getOrCreateVaultKeySuggestion(): string {
    if (existsSync(this.suggestionFile)) {
      try {
        const data = JSON.parse(readFileSync(this.suggestionFile, "utf-8")) as { vaultKey?: string };
        if (data.vaultKey) return data.vaultKey;
      } catch { /* regenerate below */ }
    }
    const key = randomBytes(32).toString("hex");
    writeFileSync(this.suggestionFile, JSON.stringify({ vaultKey: key }), "utf-8");
    return key;
  }

  /**
   * Stores the UI token in the vault. Only valid when `getStep() === "webui_token"`.
   * Returns false if the vault is not available.
   */
  setWebUiToken(token: string): boolean {
    if (!this.vaultService.isAvailable()) return false;
    this.vaultService.set(VAULT_KEY, token);
    return true;
  }

  /** Called once the vault becomes available; removes the suggestion file. */
  clearVaultKeySuggestion(): void {
    if (existsSync(this.suggestionFile)) {
      try { rmSync(this.suggestionFile); } catch { /* ignore */ }
    }
  }
}
