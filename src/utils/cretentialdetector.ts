export interface CredentialFinding {
  type: string;
  value: string;
  position: { start: number; end: number };
}

/**
 * Scans text for known credential patterns using a fixed set of regex rules.
 *
 * Detects: GitHub tokens, generic API keys, JWTs, passwords, PEM private keys,
 * Slack tokens, Stripe live keys, Google API keys, Azure keys, AWS access keys,
 * and Bearer tokens.
 *
 * Used by `OutputSanitizer` as the first (pattern-based) detection pass.
 * Note: the `azure_key` pattern is intentionally broad and may produce false
 * positives — consider tightening it if noise is a problem.
 */
export class CredentialDetector {
  private patterns: Record<string, RegExp> = {
    github_token: /ghp_[a-zA-Z0-9]{36}/g,
    generic_api_key: /api[_-]?key[_-]?[=:]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
    jwt_token: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    password_pattern: /password[_-]?[=:]\s*['"]?([^\s'"]{8,})['"]?/gi,
    private_key: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    slack_token: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/g,
    stripe_key: /sk_live_[a-zA-Z0-9]{24,}/g,
    google_api: /AIza[0-9A-Za-z_-]{35}/g,
    azure_key: /[a-zA-Z0-9+/]{43}=/g, // More specific patterns recommended
    // AWS access key ID (always starts AKIA/ASIA/AROA/AIDA/ANPA/ANVA/APKA)
    aws_access_key: /(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|APKA)[0-9A-Z]{16}/g,
    bearer_token: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
  };

  /** Scans `text` for all known credential patterns and returns their positions and matched values. */
  scan(text: string): CredentialFinding[] {
    const findings: CredentialFinding[] = [];

    for (const [keyType, pattern] of Object.entries(this.patterns)) {
      // Reset regex lastIndex
      pattern.lastIndex = 0;
      
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        findings.push({
          type: keyType,
          value: match[0],
          position: {
            start: match.index,
            end: match.index + match[0].length,
          },
        });
      }
    }

    return findings;
  }

  /** Replaces all pattern matches in `text` with `replacement`. */
  redact(text: string, replacement: string = '[REDACTED_CREDENTIAL]'): string {
    let redactedText = text;

    for (const pattern of Object.values(this.patterns)) {
      redactedText = redactedText.replace(pattern, replacement);
    }

    return redactedText;
  }

  hasCredentials(text: string): boolean {
    return this.scan(text).length > 0;
  }
}