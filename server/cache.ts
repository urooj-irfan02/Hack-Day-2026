import crypto from "crypto";
import fs from "fs";
import path from "path";

const CACHE_DIR = path.resolve(process.cwd(), "cache");

export function isReplayMode(): boolean {
  return process.env.REPLAY === "1";
}

export function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

export function computeCacheKey(model: string, prompt: string, input: string): string {
  const payload = `${model}|${prompt}|${input}`;
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

export function getCachedResponse(key: string): string | null {
  ensureCacheDir();
  const filePath = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : (parsed.response ?? raw);
  } catch (err) {
    console.error(`[Cache] Error reading cache file for key ${key}:`, err);
    return null;
  }
}

export function saveCachedResponse(
  key: string,
  model: string,
  prompt: string,
  input: string,
  response: string
): void {
  ensureCacheDir();
  const filePath = path.join(CACHE_DIR, `${key}.json`);
  const record = {
    key,
    model,
    prompt,
    input,
    response,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
}
