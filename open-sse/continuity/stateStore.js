/** Bounded local continuity state. Stores no API tokens or transport credentials.
 * Persistence is OFF by default: user messages and work notes may be private.
 * Files use opaque SHA256 names, restrictive permissions, atomic replacement,
 * and TTL validation. A failed disk operation falls back to process memory.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { continuitySettings } from "./config.js";

const records = new Map();
const MAX_ENTRIES = 2000;
const TTL = 2 * 60 * 60 * 1000;
const MAX_BYTES = 48 * 1024;
function digest(key) { return crypto.createHash("sha256").update(String(key)).digest("hex"); }
function storageDir() {
  return path.join(process.env.DATA_DIR || path.join(os.homedir(), ".9router"), "continuity-v1");
}
function fileFor(key) { return path.join(storageDir(), `${digest(key)}.json`); }
function usable(record) {
  return record && record.version === 1 && typeof record.expires === "number" &&
    record.expires > Date.now() && record.expires < Date.now() + TTL + 60_000 &&
    record.data && typeof record.data === "object" && !Array.isArray(record.data);
}
function trimRecords() {
  for (const [key, record] of records) if (!usable(record)) records.delete(key);
  while (records.size > MAX_ENTRIES) records.delete(records.keys().next().value);
}
export function readContinuityState(key) {
  if (!key) return null;
  trimRecords();
  const cached = records.get(digest(key));
  if (usable(cached)) return structuredClone(cached.data);
  if (!continuitySettings().persist) return null;
  try {
    const file = fileFor(key);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || (process.platform !== "win32" && (stat.mode & 0o077))) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!usable(record)) return null;
    records.set(digest(key), record);
    return structuredClone(record.data);
  } catch { return null; }
}
export function writeContinuityState(key, data) {
  if (!key || !data || typeof data !== "object") return false;
  const record = { version: 1, expires: Date.now() + TTL, data: structuredClone(data) };
  const bytes = JSON.stringify(record);
  if (Buffer.byteLength(bytes, "utf8") > MAX_BYTES) return false;
  records.set(digest(key), record);
  trimRecords();
  if (!continuitySettings().persist) return true;
  let tmp;
  try {
    const dir = storageDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Do not create an insecure world-readable directory on a shared machine.
    if (process.platform !== "win32") {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) return false;
    }
    tmp = path.join(dir, `.${digest(key)}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, fileFor(key));
    return true;
  } catch { return false; }
  finally { if (tmp) { try { fs.unlinkSync(tmp); } catch {} } }
}
export function clearContinuityStateForTests() { records.clear(); }
