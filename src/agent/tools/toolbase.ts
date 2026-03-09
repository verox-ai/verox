import { getToolDescription } from "src/prompts/loader.js";
import { RiskLevel } from "../security.js";

export type ToolSchema = {
  type: string;
  description?: string;
  properties?: Record<string, ToolSchema>;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: ToolSchema;
};

/**
 * Base class for all agent tools.
 *
 * Subclasses define their name, description, JSON-schema parameters, and an
 * `execute` implementation. The base class provides:
 * - `validateParams` — lightweight schema validation before `execute` is called
 * - `toSchema` — serialises the tool into the OpenAI function-calling wire format
 *
 * Tool descriptions can be overridden via workspace prompt files
 * (see `getToolDescription` in `src/prompts/loader.ts`).
 */
export abstract class Tool {
  private static typeMap: Record<string, (value: unknown) => boolean> = {
    string: (v) => typeof v === "string",
    integer: (v) => typeof v === "number" && Number.isInteger(v),
    number: (v) => typeof v === "number",
    boolean: (v) => typeof v === "boolean",
    array: Array.isArray,
    object: (v) => typeof v === "object" && v !== null && !Array.isArray(v)
  };

  abstract get name(): string;
  abstract get description(): string;
  /** JSON Schema (type: "object") describing the tool's input parameters. */
  abstract get parameters(): Record<string, unknown>;

  abstract execute(params: Record<string, unknown>, toolCallId?: string): Promise<string>;

  /**
   * The risk level that this tool's output adds to the context.
   * Override in subclasses that return external/attacker-controlled content.
   * Default: None (no taint).
   */
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  /**
   * When true, the tool is subject to relevance-based filtering.
   * It will only be included in a request if the user message has keyword
   * overlap with the tool's name + description. Core tools return false (always
   * included); MCP tools return true by default.
   */
  get contextual(): boolean { return false; }

  /**
   * The maximum context risk level this tool is allowed to run in.
   * Override in subclasses that perform write or execution actions.
   * Default: High (runnable from any context).
   */
  get maxRisk(): RiskLevel { return RiskLevel.High; }

  /**
   * Dynamic output risk reported after the last `execute()` call.
   * Tools that return content whose risk depends on runtime data (e.g.
   * `memory_search` may return high-risk entries) set this field during
   * execution. The LLM loop reads it after each tool call and uses the
   * higher of this value and the static `outputRisk` when updating the
   * SecurityManager. Reset to `undefined` at the start of each execute.
   */
  protected _lastExecuteRisk: RiskLevel | undefined = undefined;

  /** Returns the dynamic output risk from the last execute(), or undefined if not set. */
  getLastExecuteRisk(): RiskLevel | undefined { return this._lastExecuteRisk; }

  /**
   * Validates `params` against the tool's JSON schema.
   * Returns an array of human-readable error strings; empty means valid.
   */
  validateParams(params: Record<string, unknown>): string[] {
    const schema = this.parameters as ToolSchema;
    
    if (!schema) {
      return [];
    }

    if (schema?.type !== "object") {
      throw new Error(`Schema must be object type, got ${schema?.type ?? "unknown"}`);
    }
    return this.validateValue(params, schema, "");
  }

  /**
   * Serialises this tool into the OpenAI function-calling format expected by
   * `ProviderManager.chat()`. The description is resolved from workspace
   * prompt overrides first, falling back to `this.description`.
   */
  toSchema(): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: this.name,
        description: getToolDescription(this.name) ?? this.description,
        parameters: this.parameters
      }
    };
  }

  private validateValue(value: unknown, schema: ToolSchema, path: string): string[] {
    const label = path || "parameter";
    if (!schema) {
      return [];
    }
    if (schema.type in Tool.typeMap && !Tool.typeMap[schema.type](value)) {
      return [`${label} should be ${schema.type}`];
    }

    const errors: string[] = [];
    const typedValue = value as Record<string, unknown>;
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${label} must be one of ${JSON.stringify(schema.enum)}`);
    }
    if (typeof value === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${label} must be >= ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${label} must be <= ${schema.maximum}`);
      }
    }
    if (typeof value === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${label} must be at least ${schema.minLength} chars`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${label} must be at most ${schema.maxLength} chars`);
      }
    }
    if (schema.type === "object") {
      for (const key of schema.required ?? []) {
        if (!(key in typedValue)) {
          errors.push(`missing required ${path ? `${path}.${key}` : key}`);
        }
      }
      const properties = schema.properties ?? {};
      for (const [key, val] of Object.entries(typedValue)) {
        const propSchema = properties[key] as ToolSchema | undefined;
        if (propSchema) {
          errors.push(...this.validateValue(val, propSchema, path ? `${path}.${key}` : key));
        }
      }
    }
    if (schema.type === "array" && schema.items) {
      (value as unknown[]).forEach((item, index) => {
        errors.push(...this.validateValue(item, schema.items as ToolSchema, `${label}[${index}]`));
      });
    }
    return errors;
  }
}