// Session state for the visual composer, plus a lightweight idempotency
// guard for retried Telegram webhook deliveries. Both live in KV with a
// TTL — this is workflow state, not a message archive.

interface Env {
  KV: KVNamespace;
}

export type ComposerStep = "idle" | "awaiting_body" | "awaiting_button" | "awaiting_schedule";

export interface ComposerSession {
  step: ComposerStep;
  postId: number;
}

const SESSION_TTL_SECONDS = 30 * 60; // 30 minutes of composer inactivity
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // Telegram won't retry past this

function sessionKey(ownerId: number) {
  return `composer:session:${ownerId}`;
}

export async function getSession(env: Env, ownerId: number): Promise<ComposerSession | null> {
  const raw = await env.KV.get(sessionKey(ownerId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ComposerSession;
  } catch {
    return null;
  }
}

export async function setSession(env: Env, ownerId: number, session: ComposerSession): Promise<void> {
  await env.KV.put(sessionKey(ownerId), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function clearSession(env: Env, ownerId: number): Promise<void> {
  await env.KV.delete(sessionKey(ownerId));
}

/**
 * Claims an update_id so a retried webhook delivery (Telegram resends if it
 * doesn't get a timely 200) doesn't re-run side effects like a duplicate
 * publish or a duplicate button toggle. Best-effort, not a distributed
 * lock — sufficient for a single-owner personal bot on a single Worker.
 */
export async function claimUpdate(env: Env, updateId: number): Promise<boolean> {
  const key = `idempotency:update:${updateId}`;
  const existing = await env.KV.get(key);
  if (existing) return false;
  await env.KV.put(key, "1", { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
  return true;
}
