/** Matches a known file extension immediately after the token (e.g. `.pdf`, `.docx`). */
const FILENAME_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|json|xml|zip|tar|gz|png|jpe?g|gif|svg|mp[34]|mov|avi|mkv|eml|msg|odt|ods|odp|md|html?|log|sh|py|js|ts|yaml|yml|toml|ini|conf)(\b|$)/i;

/** Matches tokens that look like filesystem path segments (contain a slash or start with common path chars). */
const FILEPATH_RE = /^[/~.]|[/\\]/;

/**
 * Detects potential secrets by measuring Shannon entropy of substrings.
 *
 * Long strings with high character diversity (entropy ≥ 4.5 bits/char) are
 * characteristic of random tokens, passwords, and cryptographic keys.
 * Used by `OutputSanitizer` as the second (entropy-based) detection pass after
 * the pattern-based `CredentialDetector` pass.
 */
export class EntropyAnalyzer {
  /**
   * Calculate Shannon entropy of a string
   */
  calculateEntropy(str: string): number {
    if (!str || str.length === 0) return 0;

    const charCount = new Map<string, number>();
    
    // Count character frequencies
    for (const char of str) {
      charCount.set(char, (charCount.get(char) || 0) + 1);
    }

    const length = str.length;
    let entropy = 0;

    // Calculate Shannon entropy
    for (const count of charCount.values()) {
      const probability = count / length;
      entropy -= probability * Math.log2(probability);
    }

    return entropy;
  }

  /**
   * Detect high-entropy strings that might be secrets.
   * Skips tokens that look like filenames (known file extensions) or filesystem
   * paths — these are legitimate high-entropy strings, not credentials.
   */
  detectHighEntropyStrings(
    text: string,
    minLength: number = 20,
    entropyThreshold: number = 4.5
  ): Array<{ string: string; entropy: number; length: number }> {
    const suspicious: Array<{ string: string; entropy: number; length: number }> = [];

    // Find alphanumeric strings with special chars commonly in secrets
    const wordPattern = /\b[A-Za-z0-9+/=_-]{20,}\b/g;
    const matches = text.match(wordPattern) || [];

    for (const word of matches) {
      if (word.length >= minLength) {
        // Skip if the surrounding context suggests a filename or path.
        // We check the full text around the match for a file extension.
        const idx = text.indexOf(word);
        const surrounding = text.slice(idx, idx + word.length + 10);
        if (FILENAME_EXT_RE.test(surrounding) || FILEPATH_RE.test(word)) continue;

        const entropy = this.calculateEntropy(word);

        if (entropy >= entropyThreshold) {
          suspicious.push({
            string: word,
            entropy: entropy,
            length: word.length,
          });
        }
      }
    }

    return suspicious;
  }

  /**
   * Check if a string looks like a secret based on entropy
   */
  looksLikeSecret(str: string): boolean {
    if (str.length < 16) return false;
    
    const entropy = this.calculateEntropy(str);
    
    // High entropy + reasonable length = likely a secret
    return entropy > 4.5 && str.length >= 20;
  }
}
