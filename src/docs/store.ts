import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import OpenAI from "openai";
import * as sqliteVec from "sqlite-vec";
import { Logger } from "src/utils/logger.js";
import { extractText, SUPPORTED_EXTENSIONS, UnsupportedFileTypeError } from "./extractor.js";
import { chunkText } from "./chunker.js";

export type EmbedFn = (texts: string[], model: string) => Promise<number[][]>;

/**
 * Builds an EmbedFn that calls the OpenAI-compatible /embeddings endpoint.
 *
 * If the docs config includes `embeddingApiBase` / `embeddingApiKey` overrides
 * those are used directly (useful when the chat provider doesn't support embeddings,
 * e.g. OpenRouter). Otherwise falls back to the `fallback` function (active provider).
 */
export function buildEmbedFn(
  config: { embeddingApiBase?: string; embeddingApiKey?: string },
  fallback: EmbedFn
): EmbedFn {
  if (config.embeddingApiBase || config.embeddingApiKey) {
    const client = new OpenAI({
      apiKey: config.embeddingApiKey ?? "no-key",
      baseURL: config.embeddingApiBase,
    });
    return async (texts, model) => {
      const res = await client.embeddings.create({ model, input: texts });
      return res.data.map(d => d.embedding);
    };
  }
  return fallback;
}

export type DocStorePath = {
  name: string;
  path: string;
}

export type DocStoreConfig = {
  paths: DocStorePath[];
  embeddingModel: string;
  embeddingDims: number;
  chunkSize: number;
  chunkOverlap: number;
  maxResults: number;
};

export type IndexResult = {
  path: string;
  status: "indexed" | "skipped" | "error";
  chunks?: number;
  error?: string;
};

export type SearchResult = {
  path: string;
  chunkIndex: number;
  content: string;
  score: number;
  fileName: string | undefined;
  pathObject: DocStorePath | undefined;
};

export type DocFile = {
  path: string;
  fileHash: string;
  chunks: number;
  indexedAt: string;
  fileName: string | undefined;
  pathObject: DocStorePath | undefined;
};

const EMBED_BATCH_SIZE = 20;

/**
 * Find the DocStorePath entry whose directory contains the given absolute file path.
 * Uses startsWith(dir + "/") so "/mnt/data" never matches "/mnt/data_extra/...".
 */
function findPathEntry(paths: DocStorePath[], filePath: string): DocStorePath | undefined {
  return paths.find(p => {
    const base = resolve(p.path);
    return filePath === base || filePath.startsWith(base + "/");
  });
}

/** Serialise a float array to a Buffer (float32 little-endian). */
function encodeEmbedding(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

/** Deserialise a Buffer back to a number array. */
function decodeEmbedding(buf: Buffer): number[] {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

/**
 * Normalise a vector to unit length and return as Float32Array.
 * sqlite-vec accepts Float32Array directly for MATCH and INSERT.
 * Storing unit vectors means L2 distance equals cosine distance.
 */
function normalizeVec(vec: number[]): Float32Array {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  const f32 = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) f32[i] = norm > 0 ? vec[i] / norm : vec[i];
  return f32;
}

/**
 * Convert an L2 distance (between two unit vectors) to a cosine similarity score [0, 1].
 * For unit vectors: cosine = 1 - L2² / 2.
 */
function l2DistToScore(d: number): number {
  return Math.max(0, 1 - (d * d) / 2);
}

/**
 * SQLite-backed document store for local RAG.
 *
 * Documents are chunked, embedded via the active LLM provider's `/embeddings`
 * endpoint, and stored in a sqlite-vec virtual table. KNN search runs entirely
 * inside SQLite's C engine — no embedding data is loaded into Node.js memory.
 *
 * Existing databases (pre sqlite-vec) are automatically migrated on first open.
 */
export class DocStore {
  private db: Database.Database;
  private logger = new Logger(DocStore.name);

  constructor(
    workspace: string,
    private readonly embed: EmbedFn,
    private readonly config: DocStoreConfig
  ) {
    
    this.logger.debug(`Doc Store Init ${JSON.stringify(this.config)}`)
    const memoryDir = join(workspace, "memory");
    this.db = new Database(join(memoryDir, "docs.db"));
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
    this.migrateToVec();

  }

  private initSchema(): void {
    const dims = this.config.embeddingDims;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS doc_files (
        path       TEXT PRIMARY KEY,
        file_hash  TEXT NOT NULL,
        chunks     INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS doc_chunks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path        TEXT NOT NULL REFERENCES doc_files(path) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content     TEXT NOT NULL,
        embedding   BLOB NOT NULL,
        UNIQUE (path, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS doc_chunks_path ON doc_chunks(path);
    `);

    // Detect old schema (chunk_id named column) — drop so migrateToVec() rebuilds it.
    const vecSql = (
      this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks'").get() as
      | { sql: string }
      | undefined
    )?.sql ?? "";
    if (vecSql.includes("chunk_id")) {
      this.logger.info("Detected old vec_chunks schema — dropping for migration to rowid-based table.");
      this.db.exec("DROP TABLE vec_chunks");
    }

    // If embeddingDims changed since the vec table was created, drop and recreate.
    const storedDims = (
      this.db.prepare("SELECT value FROM doc_meta WHERE key = 'embedding_dims'").get() as
      | { value: string }
      | undefined
    )?.value;

    if (storedDims && parseInt(storedDims) !== dims) {
      this.logger.warn(
        `Embedding dimensions changed (${storedDims} → ${dims}). ` +
        `Dropping vector index — run docs_index --force to rebuild.`
      );
      this.db.exec("DROP TABLE IF EXISTS vec_chunks");
    }

    this.db.prepare("INSERT OR REPLACE INTO doc_meta(key, value) VALUES ('embedding_dims', ?)").run(String(dims));

    // sqlite-vec virtual table — rowid maps to doc_chunks.id, no named PK column.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        embedding float[${dims}]
      )
    `);
  }

  /**
   * Auto-migrate existing databases: if doc_chunks has rows with embeddings but
   * vec_chunks is empty, populate vec_chunks from the stored embedding BLOBs.
   * This lets users upgrade without a full re-index.
   */
  private migrateToVec(): void {
    const vecCount = (this.db.prepare("SELECT COUNT(*) as n FROM vec_chunks").get() as { n: number }).n;
    if (vecCount > 0) return;

    const chunks = this.db
      .prepare("SELECT id, embedding FROM doc_chunks WHERE embedding IS NOT NULL")
      .all() as { id: number; embedding: Buffer }[];

    if (chunks.length === 0) return;

    this.logger.info(`Migrating ${chunks.length} chunks to sqlite-vec index...`);
    const insertVec = this.db.prepare("INSERT OR IGNORE INTO vec_chunks(rowid, embedding) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const chunk of chunks) {
        insertVec.run(BigInt(chunk.id), normalizeVec(decodeEmbedding(chunk.embedding)));
      }
    })();
    this.logger.info("Vector index migration complete.");
  }

  // ── Indexing ───────────────────────────────────────────────────────────────

  /** Index a single file. Skips if file hash is unchanged unless force=true. */
  async indexFile(filePath: string, force = false): Promise<IndexResult> {
    const absPath = resolve(filePath);

    try { await stat(absPath); }
    catch { return { path: absPath, status: "error", error: "File not found" }; }

    const rawBuf = await readFile(absPath);
    const fileHash = createHash("sha256").update(rawBuf).digest("hex");

    if (!force) {
      const row = this.db.prepare("SELECT file_hash FROM doc_files WHERE path = ?")
        .get(absPath) as { file_hash: string } | undefined;
      if (row?.file_hash === fileHash) {
        return { path: absPath, status: "skipped" };
      }
    }

    let text: string;
    try {
      text = await extractText(absPath);
    } catch (err) {
      if (err instanceof UnsupportedFileTypeError) {
        return { path: absPath, status: "error", error: err.message };
      }
      return { path: absPath, status: "error", error: String(err) };
    }

    const chunks = chunkText(text, this.config.chunkSize, this.config.chunkOverlap);
    if (chunks.length === 0) {
      return { path: absPath, status: "error", error: "No text content extracted" };
    }

    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const vecs = await this.embed(batch, this.config.embeddingModel);
      embeddings.push(...vecs);
    }

    const upsertFile = this.db.prepare(`
      INSERT INTO doc_files (path, file_hash, chunks, indexed_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(path) DO UPDATE SET
        file_hash  = excluded.file_hash,
        chunks     = excluded.chunks,
        indexed_at = excluded.indexed_at
    `);
    const getOldIds = this.db.prepare("SELECT id FROM doc_chunks WHERE path = ?");
    const deleteChunks = this.db.prepare("DELETE FROM doc_chunks WHERE path = ?");
    const insertChunk = this.db.prepare(
      "INSERT INTO doc_chunks (path, chunk_index, content, embedding) VALUES (?, ?, ?, ?)"
    );
    const insertVec = this.db.prepare(
      "INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)"
    );

    this.db.transaction(() => {
      upsertFile.run(absPath, fileHash, chunks.length);

      // Delete old vec entries before cascading chunk delete.
      const oldIds = (getOldIds.all(absPath) as { id: number }[]).map(r => r.id);
      if (oldIds.length > 0) {
        this.db.prepare(
          `DELETE FROM vec_chunks WHERE rowid IN (${oldIds.map(() => "?").join(",")})`
        ).run(...oldIds);
      }
      deleteChunks.run(absPath);

      for (let i = 0; i < chunks.length; i++) {
        const { lastInsertRowid } = insertChunk.run(absPath, i, chunks[i], encodeEmbedding(embeddings[i]));
        insertVec.run(BigInt(lastInsertRowid), normalizeVec(embeddings[i]));
      }
    })();

    this.logger.debug(`Indexed ${absPath}: ${chunks.length} chunks`);
    return { path: absPath, status: "indexed", chunks: chunks.length };
  }

  /** Recursively walk configured paths and index all supported files. */
  async indexAll(force = false): Promise<{ indexed: number; skipped: number; errors: string[] }> {
    const pathList = this.config.paths.map(docPath => docPath.path);
    const files = await this.collectFiles(pathList);
    let indexed = 0, skipped = 0;
    const errors: string[] = [];

    for (const file of files) {
      const result = await this.indexFile(file, force);
      if (result.status === "indexed") indexed++;
      else if (result.status === "skipped") skipped++;
      else errors.push(`${result.path}: ${result.error}`);
    }

    const pruned = this.pruneDeleted(files);
    if (pruned > 0) this.logger.debug(`Pruned ${pruned} deleted files from index`);

    return { indexed, skipped, errors };
  }

  /** Remove index entries for files that are no longer on disk. */
  pruneDeleted(currentFiles?: string[]): number {
    const existing = (currentFiles ?? []).map(f => resolve(f));
    const stored = (this.db.prepare("SELECT path FROM doc_files").all() as { path: string }[])
      .map(r => r.path);
    const toDelete = stored.filter(p => !existing.includes(p));

    for (const p of toDelete) {
      // Must delete from vec_chunks before doc_files cascades to doc_chunks.
      const ids = (this.db.prepare("SELECT id FROM doc_chunks WHERE path = ?").all(p) as { id: number }[])
        .map(r => r.id);
      if (ids.length > 0) {
        this.db.prepare(
          `DELETE FROM vec_chunks WHERE rowid IN (${ids.map(() => "?").join(",")})`
        ).run(...ids);
      }
      this.db.prepare("DELETE FROM doc_files WHERE path = ?").run(p);
    }

    return toDelete.length;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  /**
   * Semantic search using sqlite-vec KNN.
   *
   * sqlite-vec runs the entire vector comparison in SQLite's C engine — no
   * embedding data is loaded into Node.js memory. Only the top-N chunk IDs
   * and distances are returned, then a second query fetches just the text
   * for those N rows.
   *
   * Vectors are stored normalised to unit length so that L2 distance is
   * equivalent to cosine distance (no extra distance-metric config needed).
   */
  async search(query: string, topN?: number): Promise<SearchResult[]> {
    const n = topN ?? this.config.maxResults;
    const [queryVec] = await this.embed([query], this.config.embeddingModel);

    // KNN query — entirely inside SQLite, zero Node.js heap allocation for embeddings.
    const hits = this.db.prepare(`
      SELECT rowid, distance
      FROM vec_chunks
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(normalizeVec(queryVec), n) as { rowid: number | bigint; distance: number }[];

    if (hits.length === 0) return [];

    // Fetch content for only the matched chunk IDs (rowid == doc_chunks.id).
    const chunkIds = hits.map(r => Number(r.rowid));
    const placeholders = chunkIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT id, path, chunk_index, content FROM doc_chunks WHERE id IN (${placeholders})`
    ).all(...chunkIds) as
      { id: number; path: string; chunk_index: number; content: string }[];

    const infoById = new Map(rows.map(r => [r.id, r]));
    this.logger.debug(`Document Hits ${hits.length}`);
    this.logger.debug(JSON.stringify(this.config.paths));
    return hits.map(r => {
      const info = infoById.get(Number(r.rowid))!;
      const pathObject = findPathEntry(this.config.paths, info.path);
      this.logger.debug(`Path Object ${JSON.stringify(pathObject)}`);
      return {
        path: info.path,
        pathObject,
        chunkIndex: info.chunk_index,
        content: info.content,
        fileName:basename(info.path),
        score: l2DistToScore(r.distance),
      };
    });
  }

  // ── Listing ────────────────────────────────────────────────────────────────

  listFiles(): DocFile[] {
    return (this.db.prepare(
      "SELECT path, file_hash, chunks, indexed_at FROM doc_files ORDER BY indexed_at DESC"
    ).all() as { path: string; file_hash: string; chunks: number; indexed_at: string }[])
      .map(r => ({ path: r.path, fileHash: r.file_hash, chunks: r.chunks, indexedAt: r.indexed_at, pathObject: findPathEntry(this.config.paths, r.path), fileName: basename(r.path) }));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async collectFiles(paths: string[]): Promise<string[]> {
    const result: string[] = [];
    for (const p of paths) {
      await this.walkDir(resolve(p), result);
    }
    return result;
  }

  private async walkDir(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      this.logger.warn(`Cannot read directory: ${dir}`);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await this.walkDir(full, out);
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) out.push(full);
      }
    }
  }
}
