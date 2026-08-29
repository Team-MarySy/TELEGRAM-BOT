export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_TELEGRAM_ID: string;
  BOT_USERNAME: string;
  APP_TIMEZONE: string;
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export const now = () => Math.floor(Date.now() / 1000);

export function isOwner(env: Env, userId?: number) {
  return !!userId && String(userId) === String(env.OWNER_TELEGRAM_ID);
}

export async function telegram(env: Env, method: string, payload: Record<string, unknown>) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as { ok: boolean; result?: any; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? "unknown error"}`);
  return data.result;
}

export async function sendMessage(env: Env, chatId: number | string, text: string, replyMarkup?: unknown) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function editMessageText(
  env: Env,
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: unknown
) {
  return telegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : { reply_markup: { inline_keyboard: [] } }),
  });
}

export function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export async function getDestinations(env: Env) {
  const result = await env.DB.prepare(
    "SELECT id, chat_id, title, type, enabled FROM destinations WHERE enabled = 1 ORDER BY id"
  ).all();
  return result.results as Array<{ id: number; chat_id: string; title: string; type: string; enabled: number }>;
}

export async function getButtons(env: Env, buttonSetId: number | null) {
  if (!buttonSetId) return [];
  const result = await env.DB.prepare("SELECT id, label, url FROM buttons WHERE button_set_id = ? ORDER BY sort_order, id")
    .bind(buttonSetId)
    .all();
  return result.results as Array<{ id: number; label: string; url: string }>;
}

export function markupForButtons(buttons: Array<{ label: string; url: string }>) {
  if (!buttons.length) return undefined;
  return { inline_keyboard: buttons.map((b) => [{ text: b.label, url: b.url }]) };
}
