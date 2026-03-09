/**
 * Splits plain text into overlapping chunks suitable for embedding.
 *
 * Strategy:
 *  1. Split on double-newlines (paragraph boundaries).
 *  2. Accumulate paragraphs until the chunk would exceed `size` chars.
 *  3. When a paragraph is too long on its own, split it at sentence boundaries.
 *  4. Each chunk carries `overlap` trailing characters from the previous chunk
 *     as a prefix so the model has some cross-boundary context.
 */
export function chunkText(text: string, size: number, overlap: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const chunk = current.trim();
    if (chunk) chunks.push(chunk);
  };

  for (const para of paragraphs) {
    // If the paragraph fits, accumulate it.
    if (current.length + para.length + 2 <= size) {
      current += (current ? "\n\n" : "") + para;
      continue;
    }

    // Flush what we have before handling the long paragraph.
    if (current) { flush(); current = ""; }

    if (para.length <= size) {
      current = para;
    } else {
      // Paragraph is longer than one chunk — split at sentence boundaries.
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (current.length + sentence.length + 1 <= size) {
          current += (current ? " " : "") + sentence;
        } else {
          flush();
          // Start next chunk with overlap from the end of the previous one.
          const tail = current.slice(-overlap);
          current = tail ? tail + " " + sentence : sentence;
        }
      }
    }
  }
  flush();

  // Apply overlap between consecutive chunks.
  if (overlap > 0 && chunks.length > 1) {
    const overlapped: string[] = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1].slice(-overlap);
      overlapped.push(tail + "\n\n" + chunks[i]);
    }
    return overlapped;
  }

  return chunks;
}
