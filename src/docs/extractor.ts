import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { PDFParse } from "pdf-parse";
 

export class UnsupportedFileTypeError extends Error {
  constructor(ext: string) {
    super(`Unsupported file type: ${ext}`);
    this.name = "UnsupportedFileTypeError";
  }
}

/** File extensions this extractor can handle. */
export const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".html", ".htm", ".pdf"]);

/**
 * Extracts plain text from a file.
 * Supports: .md / .txt (raw), .html / .htm (tag-stripped), .pdf (pdf-parse).
 */
export async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new UnsupportedFileTypeError(ext || "(no extension)");
  }

  const buf = await readFile(filePath);

  if (ext === ".pdf") {
    // Use createRequire to load the CJS module reliably from ESM context.
    const parser = new PDFParse({ data: buf });
  	const result = await parser.getText();
    await parser.destroy();
    return result.text;
  }

  const text = buf.toString("utf8");

  if (ext === ".html" || ext === ".htm") {
    return stripHtml(text);
  }

  // .md and .txt — return as-is (markdown syntax is readable as plain text).
  return text;
}

/** Minimal HTML tag stripper — good enough for indexing purposes. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}
