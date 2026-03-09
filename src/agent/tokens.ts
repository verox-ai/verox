/** Token the LLM emits in heartbeat responses to signal a successful run. */
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";

/**
 * Token the LLM appends when it detects the incoming message is a clear topic
 * change relative to the previous conversation. Triggers a force-compaction so
 * the next turn starts with a lean context instead of the full old history.
 */
export const TOPIC_SHIFT_TOKEN = "[[TOPIC_SHIFT]]";

/**
 * Strips [[TOPIC_SHIFT]] from the response text (wherever it appears) and
 * returns the cleaned text plus a flag indicating whether it was present.
 */
export function extractTopicShift(text: string): { content: string; topicShift: boolean } {
  const token = TOPIC_SHIFT_TOKEN.replace(/[[\]]/g, (c) => `\\${c}`);
  const re = new RegExp(`\\s*${token}\\s*`, "gi");
  const topicShift = re.test(text);
  return { content: text.replace(re, "").trim(), topicShift };
}

/**
 * Token the LLM emits when it has processed a message but does not want to
 * send any reply to the user (e.g. after a background cron task that needs
 * no acknowledgement). The agent checks for this before publishing to the bus.
 */
export const NO_REPLY_TOKEN = "NO_REPLY";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Returns true when the LLM response text consists solely of the silent
 * token (optionally surrounded by whitespace or punctuation).
 * Matches both leading (`"NO_REPLY some text"`) and trailing (`"done NO_REPLY"`)
 * positions so minor model verbosity doesn't break the detection.
 */
export function isSilentReplyText(text: string | null, token: string = NO_REPLY_TOKEN): boolean {
  if (!text) {
    return false;
  }
  const escaped = escapeRegExp(token);
  const prefix = new RegExp(`^\\s*${escaped}(?=$|\\W)`);
  if (prefix.test(text)) {
    return true;
  }
  const suffix = new RegExp(`\\b${escaped}\\b\\W*$`);
  return suffix.test(text);
}