import {
  type Env,
  sendMessage,
  editMessageText,
  escapeHtml,
  now,
  getDestinations,
  getButtons,
  markupForButtons,
} from "./lib";
import { getSession, setSession, clearSession, type ComposerSession } from "./session";

type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };

interface DraftPost {
  id: number;
  body: string;
  button_set_id: number | null;
  status: string;
}

async function getDraft(env: Env, postId: number): Promise<DraftPost | null> {
  return env.DB.prepare("SELECT id, body, button_set_id, status FROM posts WHERE id = ?")
    .bind(postId)
    .first<DraftPost>();
}

async function getSelectedDestinationIds(env: Env, postId: number): Promise<Set<number>> {
  const rows = await env.DB.prepare("SELECT destination_id FROM post_destinations WHERE post_id = ?")
    .bind(postId)
    .all();
  return new Set((rows.results as Array<{ destination_id: number }>).map((r) => r.destination_id));
}

async function ensureButtonSet(env: Env, post: DraftPost): Promise<number> {
  if (post.button_set_id) return post.button_set_id;
  const name = `post-${post.id}`;
  await env.DB.prepare("INSERT INTO button_sets (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING")
    .bind(name, now())
    .run();
  const set = await env.DB.prepare("SELECT id FROM button_sets WHERE name = ?").bind(name).first<{ id: number }>();
  await env.DB.prepare("UPDATE posts SET button_set_id = ? WHERE id = ?").bind(set!.id, post.id).run();
  return set!.id;
}

/** Builds the composer screen (text + keyboard) for the given draft. */
async function renderComposer(env: Env, postId: number): Promise<{ text: string; keyboard: Keyboard }> {
  const post = await getDraft(env, postId);
  if (!post) return { text: "This draft no longer exists.", keyboard: { inline_keyboard: [] } };

  const destinations = await getDestinations(env);
  const selected = await getSelectedDestinationIds(env, postId);
  const buttons = await getButtons(env, post.button_set_id);

  const bodyPreview = post.body ? escapeHtml(post.body) : "<i>(empty — tap “Set Text”)</i>";
  const destSummary = destinations.length
    ? `${selected.size}/${destinations.length} selected`
    : "none configured (use /destinations first)";

  const text = [
    `✍️ <b>Composing Post #${post.id}</b>`,
    "",
    bodyPreview,
    "",
    `📣 Destinations: ${destSummary}`,
    `🔗 Buttons: ${buttons.length}`,
  ].join("\n");

  const keyboard: Keyboard = { inline_keyboard: [] };
  keyboard.inline_keyboard.push([{ text: "📝 Set Text", callback_data: `cp:${post.id}:text` }]);

  for (const d of destinations) {
    const mark = selected.has(d.id) ? "✅" : "⬜";
    keyboard.inline_keyboard.push([{ text: `${mark} ${d.title}`, callback_data: `cp:${post.id}:dest:${d.id}` }]);
  }

  keyboard.inline_keyboard.push([{ text: "➕ Add Button", callback_data: `cp:${post.id}:addbtn` }]);
  for (const b of buttons) {
    keyboard.inline_keyboard.push([
      { text: `🗑 Remove: ${b.label}`, callback_data: `cp:${post.id}:rmbtn:${b.id}` },
    ]);
  }

  keyboard.inline_keyboard.push([{ text: "👀 Preview", callback_data: `cp:${post.id}:preview` }]);
  keyboard.inline_keyboard.push([
    { text: "✅ Publish Now", callback_data: `cp:${post.id}:publish` },
    { text: "⏰ Schedule", callback_data: `cp:${post.id}:schedule` },
  ]);
  keyboard.inline_keyboard.push([{ text: "❌ Cancel Draft", callback_data: `cp:${post.id}:cancel` }]);

  return { text, keyboard };
}

async function showComposer(env: Env, chatId: number, postId: number, messageId?: number) {
  const { text, keyboard } = await renderComposer(env, postId);
  if (messageId) {
    await editMessageText(env, chatId, messageId, text, keyboard);
  } else {
    await sendMessage(env, chatId, text, keyboard);
  }
}

export async function startComposer(env: Env, chatId: number, ownerId: number): Promise<void> {
  const result = await env.DB.prepare("INSERT INTO posts (body, status, created_at) VALUES ('', 'composing', ?)")
    .bind(now())
    .run();
  const postId = Number(result.meta.last_row_id);
  await setSession(env, ownerId, { step: "idle", postId });
  await showComposer(env, chatId, postId);
}

async function deleteDraft(env: Env, post: DraftPost): Promise<void> {
  if (post.button_set_id) {
    await env.DB.prepare("DELETE FROM buttons WHERE button_set_id = ?").bind(post.button_set_id).run();
    await env.DB.prepare("DELETE FROM button_sets WHERE id = ?").bind(post.button_set_id).run();
  }
  await env.DB.prepare("DELETE FROM post_destinations WHERE post_id = ?").bind(post.id).run();
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(post.id).run();
}

async function publishDraft(env: Env, post: DraftPost): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  if (!post.body.trim()) return { ok: false, error: "The post has no text yet. Tap “Set Text” first." };

  const selectedRows = await env.DB.prepare(
    `SELECT d.id, d.chat_id, d.title FROM post_destinations pd
     JOIN destinations d ON d.id = pd.destination_id
     WHERE pd.post_id = ? AND d.enabled = 1`
  )
    .bind(post.id)
    .all();
  const destinations = selectedRows.results as Array<{ id: number; chat_id: string; title: string }>;
  if (!destinations.length) return { ok: false, error: "No destinations selected. Tap a destination to select it." };

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
  return { ok: true, count: destinations.length };
}

export async function handleComposerCallback(
  env: Env,
  ownerId: number,
  chatId: number,
  messageId: number,
  data: string
): Promise<void> {
  if (data === "cp:new") {
    await startComposer(env, chatId, ownerId);
    return;
  }

  const parts = data.split(":");
  const postId = Number(parts[1]);
  const action = parts[2];
  const post = await getDraft(env, postId);
  if (!post) {
    await editMessageText(env, chatId, messageId, "This draft no longer exists.");
    await clearSession(env, ownerId);
    return;
  }

  switch (action) {
    case "text": {
      await setSession(env, ownerId, { step: "awaiting_body", postId });
      await sendMessage(env, chatId, "Send the post text now (it will replace the current draft text).");
      return;
    }

    case "dest": {
      const destId = Number(parts[3]);
      const already = await env.DB.prepare(
        "SELECT 1 FROM post_destinations WHERE post_id = ? AND destination_id = ?"
      )
        .bind(postId, destId)
        .first();
      if (already) {
        await env.DB.prepare("DELETE FROM post_destinations WHERE post_id = ? AND destination_id = ?")
          .bind(postId, destId)
          .run();
      } else {
        await env.DB.prepare("INSERT INTO post_destinations (post_id, destination_id) VALUES (?, ?)")
          .bind(postId, destId)
          .run();
      }
      await showComposer(env, chatId, postId, messageId);
      return;
    }

    case "addbtn": {
      await ensureButtonSet(env, post);
      await setSession(env, ownerId, { step: "awaiting_button", postId });
      await sendMessage(env, chatId, "Send the button as: Label | https://example.com");
      return;
    }

    case "rmbtn": {
      const buttonId = Number(parts[3]);
      await env.DB.prepare("DELETE FROM buttons WHERE id = ? AND button_set_id = ?")
        .bind(buttonId, post.button_set_id)
        .run();
      await showComposer(env, chatId, postId, messageId);
      return;
    }

    case "preview": {
      const buttons = await getButtons(env, post.button_set_id);
      const replyMarkup = markupForButtons(buttons) ?? { inline_keyboard: [] };
      const previewKeyboard: Keyboard = {
        inline_keyboard: [
          ...replyMarkup.inline_keyboard,
          [{ text: "⬅️ Back to editor", callback_data: `cp:${postId}:back` }],
        ],
      };
      const previewText = post.body
        ? escapeHtml(post.body)
        : "<i>(empty — tap “Set Text” from the editor)</i>";
      await editMessageText(env, chatId, messageId, `👀 <b>Preview</b>\n\n${previewText}`, previewKeyboard);
      return;
    }

    case "back": {
      await showComposer(env, chatId, postId, messageId);
      return;
    }

    case "publish": {
      const result = await publishDraft(env, post);
      if (result.ok) {
        await clearSession(env, ownerId);
        await editMessageText(env, chatId, messageId, `✅ Published to ${result.count} destination(s).`);
      } else {
        await sendMessage(env, chatId, `⚠️ ${result.error}`);
      }
      return;
    }

    case "schedule": {
      await setSession(env, ownerId, { step: "awaiting_schedule", postId });
      await sendMessage(
        env,
        chatId,
        `Send the schedule time as YYYY-MM-DDTHH:MM in ${env.APP_TIMEZONE}, e.g. 2026-09-01T10:00`
      );
      return;
    }

    case "cancel": {
      await deleteDraft(env, post);
      await clearSession(env, ownerId);
      await editMessageText(env, chatId, messageId, "Draft cancelled.");
      return;
    }

    default:
      return;
  }
}

export async function handleComposerText(
  env: Env,
  ownerId: number,
  chatId: number,
  session: ComposerSession,
  text: string
): Promise<void> {
  const post = await getDraft(env, session.postId);
  if (!post) {
    await clearSession(env, ownerId);
    await sendMessage(env, chatId, "That draft no longer exists.");
    return;
  }

  if (session.step === "awaiting_body") {
    await env.DB.prepare("UPDATE posts SET body = ? WHERE id = ?").bind(text, post.id).run();
    await setSession(env, ownerId, { step: "idle", postId: post.id });
    await showComposer(env, chatId, post.id);
    return;
  }

  if (session.step === "awaiting_button") {
    const [label, url] = text.split("|").map((s) => s.trim());
    if (!label || !url || !/^https?:\/\//i.test(url)) {
      await sendMessage(env, chatId, "Format must be: Label | https://example.com — try again.");
      return;
    }
    const buttonSetId = await ensureButtonSet(env, post);
    await env.DB.prepare("INSERT INTO buttons (button_set_id, label, url, sort_order) VALUES (?, ?, ?, 0)")
      .bind(buttonSetId, label, url)
      .run();
    await setSession(env, ownerId, { step: "idle", postId: post.id });
    await showComposer(env, chatId, post.id);
    return;
  }

  if (session.step === "awaiting_schedule") {
    const match = text.trim().match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/);
    if (!match) {
      await sendMessage(env, chatId, "Use the format YYYY-MM-DDTHH:MM, e.g. 2026-09-01T10:00. Try again.");
      return;
    }
    // NOTE: fixed UTC+8 offset to match this project's APP_TIMEZONE (Asia/Manila).
    // If APP_TIMEZONE changes, update this offset accordingly.
    const scheduledAt = Math.floor(new Date(`${match[1]}:00+08:00`).getTime() / 1000);
    if (!Number.isFinite(scheduledAt) || scheduledAt <= now()) {
      await sendMessage(env, chatId, "That time is in the past. Try again.");
      return;
    }
    const destCount = await env.DB.prepare("SELECT COUNT(*) as c FROM post_destinations WHERE post_id = ?")
      .bind(post.id)
      .first<{ c: number }>();
    if (!destCount || destCount.c === 0) {
      await sendMessage(env, chatId, "Select at least one destination before scheduling.");
      return;
    }
    await env.DB.prepare("UPDATE posts SET status='scheduled', scheduled_at=? WHERE id=?")
      .bind(scheduledAt, post.id)
      .run();
    await clearSession(env, ownerId);
    await sendMessage(env, chatId, `⏰ Scheduled for ${match[1]} (${env.APP_TIMEZONE}).`);
    return;
  }
}
