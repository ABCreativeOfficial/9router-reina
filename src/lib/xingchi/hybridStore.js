import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAdapter } from "@/lib/db/driver.js";
import { DB_DIR, ensureDirs } from "@/lib/db/paths.js";

const SCOPE = "xingchi-hybrid-v1";
const KEY_FILE = path.join(DB_DIR, "xingchi-hybrid.key");
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,253}$/;

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : "";
}

function encryptionKey() {
  const supplied = process.env.XINGCHI_BRIDGE_ENCRYPTION_KEY?.trim();
  if (supplied) {
    const key = /^[0-9a-f]{64}$/i.test(supplied)
      ? Buffer.from(supplied, "hex") : Buffer.from(supplied, "base64");
    if (key.length !== 32) throw new Error("XINGCHI_BRIDGE_ENCRYPTION_KEY must be 32 bytes (hex or base64).");
    return key;
  }
  ensureDirs();
  try { fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const key = fs.readFileSync(KEY_FILE);
  if (key.length !== 32) throw new Error("Invalid Xingchi encryption key file.");
  return key;
}

export function sealTokens(accountId, tokens) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(accountId));
  const data = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function unsealTokens(accountId, sealed) {
  if (sealed?.version !== 1) return null;
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(accountId));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8"));
}

function parseRow(row) {
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export async function listAccounts() {
  const db = await getAdapter();
  return db.all("SELECT key, value FROM kv WHERE scope = ? ORDER BY key", [SCOPE])
    .map(parseRow).filter(Boolean);
}

export async function getAccount(id) {
  const db = await getAdapter();
  return parseRow(db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, id]));
}

export async function saveAccount(account) {
  const db = await getAdapter();
  const updatedAt = new Date().toISOString();
  const merged = { ...account, updatedAt };
  db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [SCOPE, merged.id, JSON.stringify(merged)]);
  return merged;
}

export async function ensureAccount(email) {
  const valid = normalizeEmail(email);
  if (!valid) throw new Error("Invalid email address.");
  const existing = (await listAccounts()).find((account) => account.email === valid);
  if (existing) return existing;
  return saveAccount({ id: crypto.randomUUID(), email: valid, autoCheckin: false, status: "not_paired", createdAt: new Date().toISOString() });
}

export async function deleteAccount(id) {
  const db = await getAdapter();
  db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [SCOPE, id]);
}

export function publicAccount(account) {
  const { sealed, ...safe } = account;
  return { ...safe, paired: !!sealed };
}
