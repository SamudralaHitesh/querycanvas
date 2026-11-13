import { createClient, type RedisClientType } from 'redis';

export interface CachedQueryResult {
  sql: string;
  explanation: string;
  chartType: 'bar' | 'line' | 'pie' | 'kpi' | 'table';
  xAxis: string | null;
  yAxis: string | null;
  followUps: string[];
  createdAt: number;
}

const TTL_SECONDS = 60 * 30; // 30 minutes
const TTL_MS = TTL_SECONDS * 1000;
const memoryStore = new Map<string, CachedQueryResult>();

let redisClient: RedisClientType | null = null;
let redisReady = false;
let hits = 0;
let misses = 0;

export async function initCache(): Promise<void> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) return;

  try {
    redisClient = createClient({ url: redisUrl });
    redisClient.on('error', () => {
      redisReady = false;
    });
    await redisClient.connect();
    redisReady = true;
  } catch {
    redisReady = false;
    redisClient = null;
  }
}

function normalizeKey(question: string, schemaVersion: string): string {
  const cleanQ = question.trim().toLowerCase().replace(/\s+/g, ' ');
  return `qc:q:${schemaVersion}::${cleanQ}`;
}

export async function getCachedQuery(
  question: string,
  schemaVersion: string
): Promise<CachedQueryResult | null> {
  const key = normalizeKey(question, schemaVersion);

  if (redisReady && redisClient) {
    try {
      const raw = await redisClient.get(key);
      if (raw) {
        hits++;
        return JSON.parse(raw) as CachedQueryResult;
      }
      misses++;
      return null;
    } catch {
      // Fallback to in-memory store
    }
  }

  const entry = memoryStore.get(key);
  if (!entry) {
    misses++;
    return null;
  }
  if (Date.now() - entry.createdAt > TTL_MS) {
    memoryStore.delete(key);
    misses++;
    return null;
  }
  hits++;
  return entry;
}

export async function setCachedQuery(
  question: string,
  schemaVersion: string,
  value: Omit<CachedQueryResult, 'createdAt'>
): Promise<void> {
  const key = normalizeKey(question, schemaVersion);
  const payload: CachedQueryResult = { ...value, createdAt: Date.now() };

  if (redisReady && redisClient) {
    try {
      await redisClient.setEx(key, TTL_SECONDS, JSON.stringify(payload));
      return;
    } catch {
      // Fallback to in-memory store
    }
  }

  memoryStore.set(key, payload);
}

export async function clearQueryCache(): Promise<void> {
  memoryStore.clear();
  hits = 0;
  misses = 0;
  if (redisReady && redisClient) {
    try {
      const keys = await redisClient.keys('qc:q:*');
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch {
      // ignore
    }
  }
}

export function getCacheStats() {
  return {
    backend: redisReady ? 'redis' : 'memory',
    entries: memoryStore.size,
    hits,
    misses,
    hitRate: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 100) : 0,
  };
}
