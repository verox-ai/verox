import { CredentialDetector } from "src/utils/cretentialdetector";
import { EntropyAnalyzer } from "src/utils/entropyanalyzer";

/**
 * Result returned by `OutputSanitizer.sanitize`.
 *
 * - `isSafe` — true when no credentials were detected (findings is empty)
 * - `sanitizedText` — the input text with all detected values replaced by
 *   `[REDACTED_CREDENTIAL]`, `[REDACTED_HIGH_ENTROPY]`, or `[REDACTED_KEYWORD]`
 * - `findings` — details of every detected credential, useful for logging
 */
export interface SanitizationResult {
  isSafe: boolean;
  sanitizedText: string;
  findings: Array<{
    type: string;
    method: 'pattern' | 'entropy' | 'keyword';
    value: string;
    severity: 'high' | 'medium' | 'low';
  }>;
}

/**
 * Scrubs credentials from text using three complementary detection strategies:
 *
 * 1. **Pattern** (`CredentialDetector`) — regex rules for known token formats
 * 2. **Entropy** (`EntropyAnalyzer`) — flags long, high-entropy strings
 * 3. **Keyword** — matches `key=value` / `key: value` patterns near sensitive
 *    keyword names (password, token, api_key, …)
 *
 * Applied to both inbound user messages (to block credential leakage into the
 * LLM context) and outbound LLM responses (to block accidental credential
 * echoing to channel users).
 */
export class OutputSanitizer {
  private credentialDetector: CredentialDetector;
  private entropyAnalyzer: EntropyAnalyzer;
  private sensitiveKeywords: string[] = [
    'password',
    'secret',
    'token',
    'api_key',
    'apikey',
    'private_key',
    'access_key',
    'auth',
    'credential',
    'passphrase',
  ];

  constructor() {
    this.credentialDetector = new CredentialDetector();
    this.entropyAnalyzer = new EntropyAnalyzer();
  }

  /**
   * Main sanitization method
   */
  sanitize(text: string): SanitizationResult {
    const findings: SanitizationResult['findings'] = [];
    let sanitizedText = text;

    // 1. Pattern-based detection
    const patternFindings = this.credentialDetector.scan(text);
    for (const finding of patternFindings) {
      findings.push({
        type: finding.type,
        method: 'pattern',
        value: finding.value,
        severity: 'high',
      });
    }

    // 2. Entropy-based detection
    const entropyFindings = this.entropyAnalyzer.detectHighEntropyStrings(text);
    for (const finding of entropyFindings) {
      findings.push({
        type: 'high_entropy_string',
        method: 'entropy',
        value: finding.string,
        severity: 'medium',
      });
    }

    // 3. Keyword-based detection
    const keywordFindings = this.detectSensitiveKeywords(text);
    findings.push(...keywordFindings);

    // Redact all findings
    if (findings.length > 0) {
      sanitizedText = this.credentialDetector.redact(text);

      // Also redact high-entropy strings
      for (const finding of entropyFindings) {
        sanitizedText = sanitizedText.replace(
          finding.string,
          '[REDACTED_HIGH_ENTROPY]'
        );
      }

      // Also redact keyword finding values
      for (const finding of keywordFindings) {
        sanitizedText = sanitizedText.replace(finding.value, '[REDACTED_KEYWORD]');
      }
    }

    return {
      isSafe: findings.length === 0,
      sanitizedText,
      findings,
    };
  }

  /**
   * Detect sensitive keywords in context
   */
  private detectSensitiveKeywords(text: string): SanitizationResult['findings'] {
    const findings: SanitizationResult['findings'] = [];
    const lowerText = text.toLowerCase();

    for (const keyword of this.sensitiveKeywords) {
      // Look for patterns like "password: value" or "password = value"
      const pattern = new RegExp(
        `${keyword}[\\s]*[:=][\\s]*['"]?([^\\s'"]{6,})['"]?`,
        'gi'
      );
      
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        findings.push({
          type: `keyword_${keyword}`,
          method: 'keyword',
          value: match[1],
          severity: 'high',
        });
      }
    }

    return findings;
  }

  /**
   * Quick check without full sanitization
   */
  containsCredentials(text: string): boolean {
    return (
      this.credentialDetector.hasCredentials(text) ||
      this.entropyAnalyzer.detectHighEntropyStrings(text).length > 0
    );
  }
}
