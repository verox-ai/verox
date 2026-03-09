import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type VaultData = Record<string, string>;

export type VaultFile = {
  salt: string;
  iv: string;
  authTag: string;
  data: string;
};

/**
 * Shared AES-256-GCM encryption primitives used by both VaultService
 * (credentials) and SkillManifestService (integrity hashes).
 *
 * Each `save` generates a fresh random salt and IV so every write produces
 * a distinct ciphertext even for identical plaintext.
 *
 * Key derivation: scrypt with N=16384, r=8, p=1 (node default) → 32-byte key.
 */

export function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32) as Buffer;
}

export function encryptData(data: VaultData, password: string): VaultFile {
  const salt = randomBytes(32);
  const key = deriveKey(password, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    data: encrypted.toString("hex")
  };
}

export function decryptData(file: VaultFile, password: string): VaultData {
  const salt = Buffer.from(file.salt, "hex");
  const key = deriveKey(password, salt);
  const iv = Buffer.from(file.iv, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(file.authTag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(file.data, "hex")),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString("utf-8")) as VaultData;
}

/** Reads and decrypts a vault file. Returns `{}` when the file does not exist yet. */
export function loadEncryptedFile(filePath: string, password: string): VaultData {
  if (!existsSync(filePath)) return {};
  try {
    const file = JSON.parse(readFileSync(filePath, "utf-8")) as VaultFile;
    return decryptData(file, password);
  } catch (err) {
    throw new Error(`Failed to decrypt ${filePath}: ${String(err)}`);
  }
}

/** Encrypts `data` and writes it to `filePath`, creating parent directories as needed. */
export function saveEncryptedFile(filePath: string, data: VaultData, password: string): void {
  const file = encryptData(data, password);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(file, null, 2), "utf-8");
}
