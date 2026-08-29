import {
  type Env,
  json,
  now,
  isOwner,
  telegram,
  sendMessage,
  escapeHtml,
  getDestinations,
  getButtons,
  markupForButtons,
} from "./lib";
import { getSession, clearSession, claimUpdate } from "./session";
import { startComposer, handleComposerCallback, handleComposerText } from "./composer";

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    data?: string;
    message?: TelegramMessage;
  };
};

type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  entities?: Array<{ type: string; offset: number; length: number; user?: TelegramUser }>;
  date: number;
};

const ownerMenu = {
  inline_keyboard: [
    [{ text: "✍️ New Post", callback_data: "cp:new" }],
    [
      { text: "📢 Publish (legacy /publish)", callback_data: "owner:publish" },
      { text: "⏰ Schedule", callback_data: "owner:schedule" },
    ],
    [{ text: "📝 Content", callback_data: "owner:content" }, { text: "🔗 Buttons", callback_data: "owner:buttons" }],
    [{ text: "📣 Destinations", callback_data: "owner:destinations" }],
    [{ text: "👥 Access Requests", callback_data: "owner:access" }],
    [{ text: "⚙️ Settings", callback_data: "owner:settings" }],
  ],
};

function helpText() {
  return [
    "<b>TeamMarySy Bot</b>",
    "",
    "Customer assistance is available here.",
    "",
    "Owner: use /owner for the control center.",
    "To request controlled access, use /request.",
  ].join("\n");
}

async function publishPost(env: Env, postId: number) {
  const post = await env.DB.prepare(
    "SELECT id, body, button_set_id FROM posts WHERE id = ? AND status IN ('draft','scheduled')"
  )
    .bind(postId)
    .first<{ id: number; body: string; button_set_id: number | null }>();

  if (!post) throw new Error("Post not found or already published.");

  const destinations = await getDestinations(env);
  if (!destinations.length) throw new Error("No enabled destinations are configured.");

  const buttons = await getButtons(env, post.button_set_id);
  const replyMarkup = markupForButtons(buttons);
  const timestamp = now();

  for (const destination of destinations) {
    const message = await sendMessage(env, destination.chat_id, post.body, replyMarkup);
    await env.DB.prepare(
      `INSERT INTO published_messages
       (post_id, destination_id, telegram_chat_id, telegram_message_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(post.id, destination.id, destination.chat_id, message.message_id, timestamp)
      .run();
  }

  await env.DB.prepare("UPDATE posts SET status='published', published_at=? WHERE id=?").bind(timestamp, post.id).run();
}

/** Publishes a draft that has explicit post_destinations rows (created via the composer). */
async function publishSelectedDraft(env: Env, postId: number) {
  const post = await env.DB.prepare("SELECT id, body, button_set_id FROM posts WHERE id = ?")
    .bind(postId)
    .first<{ id: number; body: string; button_set_id: number | null }>();
  if (!post) throw new Error("Post not found.");

  const rows = await env.DB.prepare(
    `SELECT d.id, d.chat_id FROM post_destinations pd
     JOIN destinations d ON d.id = pd.destination_id
     WHERE pd.post_id = ? AND d.enabled = 1`
  )
    .bind(postId)
    .all();
  const destinations = rows.results as Array<{ id: number; chat_id: string }>;
  if (!destinations.length) throw new Error("No enabled destinations selected for this post.");

  const buttons = await getButtons(env, post.button_set_id);
  const replyMarkup = markupForButtons(buttons);
  const timestamp = now();

  for (const destination of destinations) {
    const message = await sendMessage(env, destination.chat_id, post.body, replyMarkup);
    await env.DB.prepare(
      `INSERT INTO published_messages (post_id, destination_id, telegram_chat_id, telegram_message_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(post.id, destination.id, destination.chat_id, message.message_id, timestamp)
      .run();
  }

  await env.DB.prepare("UPDATE posts SET status='published', published_at=? WHERE id=?").bind(timestamp, post.id).run();
}

/** Cron entrypoint: due drafts made via the composer carry post_destinations rows; legacy /schedule drafts don't. */
async function processScheduled(env: Env) {
  const due = await env.DB.prepare(
    `SELECT id FROM posts
     WHERE status='scheduled' AND scheduled_at <= ?
     ORDER BY scheduled_at ASC LIMIT 20`
  )
    .bind(now())
    .all();

  for (const row of due.results as Array<{ id: number }>) {
    try {
      const hasSelectedDestinations = await env.DB.prepare("SELECT 1 FROM post_destinations WHERE post_id = ?")
        .bind(row.id)
        .first();

      if (hasSelectedDestinations) {
        await publishSelectedDraft(env, row.id);
      } else {
        await publishPost(env, row.id);
      }
    } catch (error) {
      console.error("scheduled publish failed", row.id, error);
      await env.DB.prepare("UPDATE posts SET status='failed' WHERE id=? AND status='scheduled'").bind(row.id).run();
    }
  }
}

async function changeButtonUrl(env: Env, label: string, newUrl: string) {
  const button = await env.DB.prepare("SELECT id, button_set_id FROM buttons WHERE label = ?")
    .bind(label)
    .first<{ id: number; button_set_id: number }>();

  if (!button) throw new Error(`Button "${label}" was not found.`);

  await env.DB.prepare("UPDATE buttons SET url=? WHERE id=?").bind(newUrl, button.id).run();

  const affected = await env.DB.prepare(
    `SELECT pm.telegram_chat_id, pm.telegram_message_id, pm.post_id, p.button_set_id
     FROM published_messages pm
     JOIN posts p ON p.id = pm.post_id
     WHERE p.button_set_id = ?`
  )
    .bind(button.button_set_id)
    .all();

  const buttons = await getButtons(env, button.button_set_id);
  const replyMarkup = markupForButtons(buttons);

  for (const row of affected.results as Array<{
    telegram_chat_id: string;
    telegram_message_id: number;
  }>) {
    await telegram(env, "editMessageReplyMarkup", {
      chat_id: row.telegram_chat_id,
      message_id: row.telegram_message_id,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  }

  return affected.results.length;
}

async function ensureUser(env: Env, user: TelegramUser) {
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO users
     (telegram_id, username, first_name, last_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       username=excluded.username,
       first_name=excluded.first_name,
       last_name=excluded.last_name,
       updated_at=excluded.updated_at`
  )
    .bind(user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null, timestamp, timestamp)
    .run();
}

async function userStatus(env: Env, userId: number) {
  const row = await env.DB.prepare("SELECT status FROM users WHERE telegram_id=?").bind(userId).first<{ status: string }>();
  return row?.status ?? "unknown";
}

async function requestAccess(env: Env, user: TelegramUser) {
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO access_requests (telegram_id, status, created_at)
     VALUES (?, 'pending', ?)
     ON CONFLICT(telegram_id) DO UPDATE SET status='pending', created_at=excluded.created_at`
  )
    .bind(user.id, timestamp)
    .run();

  await sendMessage(
    env,
    env.OWNER_TELEGRAM_ID,
    `👥 <b>Access request</b>\n\nUser: ${escapeHtml(user.first_name ?? "")} ${escapeHtml(user.last_name ?? "")}\nID: <code>${user.id}</code>\nUsername: @${escapeHtml(user.username ?? "none")}`,
    {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `access:approve:${user.id}` },
          { text: "❌ Decline", callback_data: `access:decline:${user.id}` },
        ],
      ],
    }
  );
}

async function handleCallback(env: Env, callback: NonNullable<TelegramUpdate["callback_query"]>) {
  const from = callback.from;
  const data = callback.data ?? "";

  await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });

  if (data.startsWith("cp:")) {
    if (!isOwner(env, from.id) || !callback.message) return;
    await handleComposerCallback(env, from.id, callback.message.chat.id, callback.message.message_id, data);
    return;
  }

  if (data === "owner:menu") {
    if (!isOwner(env, from.id)) return;
    if (callback.message) await sendMessage(env, callback.message.chat.id, "Control Center", ownerMenu);
    return;
  }

  if (!data.startsWith("access:")) return;
  if (!isOwner(env, from.id)) return;

  const parts = data.split(":");
  const action = parts[1];
  const targetId = Number(parts[2]);
  if (!Number.isFinite(targetId)) return;

  const status = action === "approve" ? "approved" : "declined";
  await env.DB.prepare("UPDATE users SET status=?, updated_at=? WHERE telegram_id=?").bind(status, now(), targetId).run();

  await env.DB.prepare("UPDATE access_requests SET status=?, decided_at=? WHERE telegram_id=?")
    .bind(status, now(), targetId)
    .run();

  await sendMessage(
    env,
    targetId,
    status === "approved" ? "✅ Your access request has been approved." : "Your access request was declined."
  );
}

async function handleMessage(env: Env, message: TelegramMessage) {
  const user = message.from;
  if (!user) return;

  await ensureUser(env, user);
  const text = message.text ?? message.caption ?? "";

  if (isOwner(env, user.id)) {
    // A composer session in progress takes priority over everything except /cancel.
    const session = await getSession(env, user.id);
    if (session && session.step !== "idle") {
      if (text === "/cancel") {
        await clearSession(env, user.id);
        await sendMessage(env, message.chat.id, "Cancelled. Session state cleared (draft itself was left as-is).");
        return;
      }
      if (!text.startsWith("/")) {
        await handleComposerText(env, user.id, message.chat.id, session, text);
        return;
      }
    }

    if (text === "/owner" || text === "/start") {
      await sendMessage(env, message.chat.id, "Control Center", ownerMenu);
      return;
    }

    if (text === "/compose" || text === "/newpost") {
      await startComposer(env, message.chat.id, user.id);
      return;
    }

    if (text.startsWith("/publish ")) {
      const body = text.slice("/publish ".length).trim();
      if (!body) return sendMessage(env, message.chat.id, "Usage: /publish Your message");
      const result = await env.DB.prepare("INSERT INTO posts (body, status, created_at) VALUES (?, 'draft', ?)")
        .bind(body, now())
        .run();
      await publishPost(env, Number(result.meta.last_row_id));
      await sendMessage(env, message.chat.id, "Published.");
      return;
    }

    if (text.startsWith("/schedule ")) {
      const match = text.match(/^\/schedule\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s+([\s\S]+)$/);
      if (!match) {
        return sendMessage(
          env,
          message.chat.id,
          "Usage: /schedule 2026-09-01T10:00 Your message\nUse ISO local time in the configured app timezone."
        );
      }
      const scheduledAt = Math.floor(new Date(match[1] + ":00+08:00").getTime() / 1000);
      if (!Number.isFinite(scheduledAt) || scheduledAt <= now()) {
        return sendMessage(env, message.chat.id, "Schedule time must be in the future.");
      }
      await env.DB.prepare("INSERT INTO posts (body, status, scheduled_at, created_at) VALUES (?, 'scheduled', ?, ?)")
        .bind(match[2].trim(), scheduledAt, now())
        .run();
      await sendMessage(env, message.chat.id, `Scheduled for ${match[1]} (Asia/Manila).`);
      return;
    }

    if (text.startsWith("/button ")) {
      const parts = text
        .slice("/button ".length)
        .split("|")
        .map((s) => s.trim());
      if (parts.length !== 3) {
        return sendMessage(env, message.chat.id, "Usage: /button ButtonSetName | Button Label | https://example.com");
      }
      const [setName, label, url] = parts;
      if (!/^https?:\/\//i.test(url)) return sendMessage(env, message.chat.id, "Button URL must start with http:// or https://.");

      await env.DB.prepare("INSERT INTO button_sets (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING")
        .bind(setName, now())
        .run();

      const set = await env.DB.prepare("SELECT id FROM button_sets WHERE name=?").bind(setName).first<{ id: number }>();

      await env.DB.prepare("INSERT INTO buttons (button_set_id, label, url, sort_order) VALUES (?, ?, ?, 0)")
        .bind(set!.id, label, url)
        .run();

      await sendMessage(env, message.chat.id, "Button saved.");
      return;
    }

    if (text.startsWith("/changebutton ")) {
      const parts = text
        .slice("/changebutton ".length)
        .split("|")
        .map((s) => s.trim());
      if (parts.length !== 2) {
        return sendMessage(env, message.chat.id, "Usage: /changebutton Button Label | https://new-url.example");
      }
      const count = await changeButtonUrl(env, parts[0], parts[1]);
      await sendMessage(env, message.chat.id, `Updated ${count} published message(s).`);
      return;
    }

    if (text === "/destinations") {
      const destinations = await getDestinations(env);
      if (!destinations.length) return sendMessage(env, message.chat.id, "No destinations configured.");
      await sendMessage(
        env,
        message.chat.id,
        "<b>Destinations</b>\n" + destinations.map((d) => `• ${escapeHtml(d.title)} — <code>${escapeHtml(d.chat_id)}</code>`).join("\n")
      );
      return;
    }

    if (text === "/access") {
      const rows = await env.DB.prepare(
        "SELECT telegram_id, status, created_at FROM access_requests ORDER BY created_at DESC LIMIT 20"
      ).all();
      await sendMessage(
        env,
        message.chat.id,
        "<b>Access Requests</b>\n" +
          ((rows.results as any[]).length
            ? (rows.results as any[]).map((r) => `• <code>${r.telegram_id}</code> — ${r.status}`).join("\n")
            : "No requests.")
      );
      return;
    }
  }

  if (text === "/start" || text === "/help") {
    await sendMessage(env, message.chat.id, helpText());
    return;
  }

  if (text === "/request") {
    if (isOwner(env, user.id)) {
      await sendMessage(env, message.chat.id, "You are the owner.");
      return;
    }
    const status = await userStatus(env, user.id);
    if (status === "approved") {
      await sendMessage(env, message.chat.id, "Your access is already approved.");
    } else if (status === "pending") {
      await requestAccess(env, user);
      await sendMessage(env, message.chat.id, "Your access request has been sent to the owner.");
    } else {
      await requestAccess(env, user);
      await sendMessage(env, message.chat.id, "A new access request has been submitted.");
    }
    return;
  }

  // Group assistance: respond only when the bot is explicitly mentioned.
  if (
    (message.chat.type === "group" || message.chat.type === "supergroup") &&
    text.toLowerCase().includes(`@${env.BOT_USERNAME.toLowerCase()}`)
  ) {
    const question = text.replace(new RegExp(`@${env.BOT_USERNAME}`, "ig"), "").trim();
    await sendMessage(env, message.chat.id, question ? `I received your request: ${escapeHtml(question)}` : "Yes? How can I help?");
    return;
  }

  // Approved users may use the normal assistant experience.
  if ((await userStatus(env, user.id)) === "approved") {
    await sendMessage(env, message.chat.id, `Thanks, ${escapeHtml(user.first_name ?? "there")}. I received your message.`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ status: "ok" });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!secret || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const update = (await request.json()) as TelegramUpdate;

      const isNewDelivery = await claimUpdate(env, update.update_id);
      if (!isNewDelivery) {
        // Telegram retried a delivery we already handled — ack without reprocessing.
        return json({ ok: true, duplicate: true });
      }

      try {
        if (update.callback_query) await handleCallback(env, update.callback_query);
        if (update.message) await handleMessage(env, update.message);
      } catch (error) {
        console.error("update handling failed", error);
      }

      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/admin/publish") {
      return new Response("Use the Telegram owner interface.", { status: 405 });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env) {
    await processScheduled(env);
  },
};
