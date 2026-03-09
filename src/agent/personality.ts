import fs from "fs";
import path from "path";
import { ConfigService } from "src/config/service";
import { ProviderManager } from "src/provider/manager";
import { Config } from "src/types/schemas/schema";
import { Logger } from "src/utils/logger";
import { injectable, inject } from "tsyringe";

export const DEFAULT_PERSONALITY = "- Warmth: 0.35\n- Humor: 0.10\n- Verbosity: 0.40\n- Curiosity: 0.25";

interface Descriptor {
  level: number; // 0–1
  text: string;
}

// ------------------------
// Trait descriptor definitions
// ------------------------
const warmthDescriptors: Descriptor[] = [
  { level: 0.0, text: "emotionally neutral and reserved" },
  { level: 0.4, text: "polite and mildly warm" },
  { level: 0.7, text: "noticeably warm and empathetic" },
  { level: 1.0, text: "deeply empathetic and emotionally expressive" }
];

const humorDescriptors: Descriptor[] = [
  { level: 0.0, text: "serious and dry" },
  { level: 0.4, text: "occasionally lighthearted" },
  { level: 0.7, text: "playful and witty" },
  { level: 1.0, text: "frequently humorous and cheeky" }
];

const verbosityDescriptors: Descriptor[] = [
  { level: 0.0, text: "concise and minimal" },
  { level: 0.4, text: "somewhat detailed" },
  { level: 0.7, text: "expressive and descriptive" },
  { level: 1.0, text: "very detailed and elaborate" }
];

const curiosityDescriptors: Descriptor[] = [
  { level: 0.0, text: "focused and reserved" },
  { level: 0.4, text: "moderately curious" },
  { level: 0.7, text: "actively inquisitive" },
  { level: 1.0, text: "highly exploratory and probing" }
];

const assertivenessDescriptors: Descriptor[] = [
  { level: 0.0, text: "tentative and cautious" },
  { level: 0.4, text: "moderately confident" },
  { level: 0.7, text: "direct and decisive" },
  { level: 1.0, text: "very assertive and authoritative" }
];

const snarkDescriptors: Descriptor[] = [
  { level: 0.0, text: "no snark, very straightforward" },
  { level: 0.25, text: "occasionally wry comments" },
  { level: 0.5, text: "mildly cheeky and playful" },
  { level: 0.75, text: "noticeably sassy and ironic" },
  { level: 1.0, text: "frequently snarky, witty, and teasing" }
];

export interface PersonalityState {
  warmth: number;
  humor: number;
  verbosity: number;
  curiosity: number;
  assertiveness: number;
  snarkiness: number;
}


export interface PersonalityConfig {
  evolutionEnabled: boolean;
  evolutionRate: number;        // multiplier
  maxDeltaPerCompaction: number; // e.g. 0.05
  personalityFile?: string;      // path to json file
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

@injectable()
export class PersonalityService {
  private config: Config["agents"]["personality"];
  private filePath: string;
  private state: PersonalityState;
  private providerManager: ProviderManager;
  private logger = new Logger(PersonalityService.name);

  constructor(
    @inject(ConfigService) private configService: ConfigService,
    @inject("workspace") _workspace: string,
    @inject(ProviderManager) providerManager: ProviderManager,
  ) {

    this.config = configService.app.agents.personality;
    this.filePath = path.join(_workspace, "./personality.json");
    this.providerManager = providerManager;
    // load or initialize
    if (fs.existsSync(this.filePath)) {
      this.state = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } else {
      this.state = {
        warmth: 0.6,
        humor: 0.25,
        verbosity: 0.5,
        curiosity: 0.5,
        assertiveness: 0.6,
        snarkiness: 0.2
      };
      this.saveState();
    }
  }

  // ------------------------
  // Get current personality
  // ------------------------
  getPersonality(): PersonalityState {
    return { ...this.state };
  }

  describeTrait(value: number, descriptors: Descriptor[]): string {
    const sorted = descriptors.sort((a, b) => a.level - b.level);

    for (let i = 0; i < sorted.length - 1; i++) {
      const lower = sorted[i];
      const upper = sorted[i + 1];

      if (value >= lower.level && value <= upper.level) {
        const t = (value - lower.level) / (upper.level - lower.level);

        if (t < 0.33) return lower.text;
        if (t < 0.66) return `somewhat ${upper.text}`;
        return upper.text;
      }
    }

    return sorted[sorted.length - 1].text;
  }

  buildPersonalityPrompt() {
    return this.decodePersonality(this.getPersonality());
  }
  
  decodePersonality(p: PersonalityState): string {
    return `
Your current personality tendencies:

- Warmth: ${this.describeTrait(p.warmth, warmthDescriptors)}
- Humor: ${this.describeTrait(p.humor, humorDescriptors)}
- Verbosity: ${this.describeTrait(p.verbosity, verbosityDescriptors)}
- Curiosity: ${this.describeTrait(p.curiosity, curiosityDescriptors)}
- Assertiveness: ${this.describeTrait(p.assertiveness, assertivenessDescriptors)}
- Snarkiness: ${this.describeTrait(p.snarkiness, snarkDescriptors)}

These traits influence tone and phrasing subtly.
They must never override accuracy, safety, or clarity.
`;
  }


  stripCodeBlock(content: string): string {
    return content.replace(/^```(?:json)?\n/, "").replace(/```$/, "").trim();
  }

  // ------------------------
  // Reset to baseline
  // ------------------------
  resetPersonality() {
    this.state = {
      warmth: 0.6,
      humor: 0.25,
      verbosity: 0.5,
      curiosity: 0.5,
      assertiveness: 0.6,
      snarkiness: 0.2
    };
    this.saveState();
  }

  // ------------------------
  // Persist to JSON
  // ------------------------
  private saveState() {
    this.logger.debug(`saveState ${JSON.stringify(this.state, null, 2)}`);
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  // ------------------------
  // Evolve personality
  // conversation: array of strings
  // llmCall: async function(prompt: string) => Promise<string>
  // ------------------------
  async processConversation(conversation: string[]) {
    if (!this.config.evolutionEnabled) return;

    // --- Prepare messages for LLM ---
    const personalityMessage: Array<{ role: string; content: string }> = [
      {
        role: "system",
        content: `
You are a personal AI assistant. Analyze the following conversation segment and suggest tiny adjustments (delta) to your personality traits:

Traits:
- warmth
- humor
- verbosity
- curiosity
- assertiveness
- snarkiness

Rules:
1. Only suggest tiny deltas between -0.05 and 0.05.
2. Return all traits even if delta is 0.0.
3. Respond strictly in JSON, no extra text.
4. Base your suggestions only on the content of the conversation.

Important: Respond strictly as JSON. Do NOT use Markdown code blocks or any other formatting.
`
      },
      {
        role: "user",
        content: conversation.join("\n")
      }
    ];

    try {
      const llmResponse = await this.providerManager.get().chat({
        messages: personalityMessage,
        model: this.providerManager.getUtilityModel()
      });

      const raw = llmResponse.content ?? "";
      const clean = this.stripCodeBlock(raw);

      // --- Parse safely ---
      let suggestedDelta: Partial<PersonalityState> = {};
      try {
        suggestedDelta = JSON.parse(clean ?? "{}");

      } catch (e) {
        this.logger.warn(`LLM returned invalid JSON for personality delta ${llmResponse.content}`);
      }

      // --- Ensure all traits exist ---
      const sanitizeDelta = (delta: Partial<PersonalityState>): PersonalityState => ({
        warmth: clamp(delta.warmth ?? 0),
        humor: clamp(delta.humor ?? 0),
        verbosity: clamp(delta.verbosity ?? 0),
        curiosity: clamp(delta.curiosity ?? 0),
        assertiveness: clamp(delta.assertiveness ?? 0),
        snarkiness: clamp(delta.snarkiness ?? 0),
      });

      suggestedDelta = sanitizeDelta(suggestedDelta);
      this.logger.debug(`Back from DrFreud: ${suggestedDelta}`);
      // --- Calculate richness ---
      const lengthFactor = Math.min(1, conversation.length / 10);
      const uniqueFactor = Math.min(1, new Set(conversation).size / 5);
      const richness = clamp(lengthFactor * 0.5 + uniqueFactor * 0.5);

      // --- Apply deltas ---
      for (const trait of Object.keys(this.state) as (keyof PersonalityState)[]) {
        const delta = suggestedDelta[trait] ?? 0;
        const boundedDelta = Math.sign(delta) * Math.min(Math.abs(delta), this.config.maxDeltaPerCompaction);
        this.state[trait] = clamp(this.state[trait] + boundedDelta * richness * this.config.evolutionRate);

      }

      this.saveState();
    } catch (e) {
      console.error("Error processing conversation for personality evolution:", e);
    }
  }
}