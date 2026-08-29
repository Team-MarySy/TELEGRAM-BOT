# TeamMarySy Bot — Cloudflare Deployment

This is a deployment-ready baseline for the TeamMarySy Telegram automation concept.

## Architecture

Telegram → Cloudflare Worker → D1 database → Telegram

Cloudflare Worker responsibilities:
- Telegram webhook (with idempotency: retried deliveries are deduplicated by `update_id` via KV, so a Telegram retry can't double-publish or double-toggle a button)
- owner authorization
- visual, button-driven post composer
- user access requests
- publishing
- destination management
- scheduled publishing
- button URL updates
- mention-based group assistance

Cloudflare D1 stores only the information needed to operate those workflows. Cloudflare KV stores only short-lived composer session state (30-minute TTL) and webhook idempotency markers (24-hour TTL) — never message content or user history.

## Important limitation

This project is a functional baseline, not a finished business-specific AI assistant. The customer-response logic is intentionally simple. Product catalog, CRM, AI/RAG, analytics, media uploads, and advanced permissions can be added later.

## Visual composer

The owner can build and publish a post entirely with buttons, without typing any commands other than `/compose` (or tapping "✍️ New Post" from `/owner`):

1. `/compose` creates a draft and shows the composer screen.
2. **Set Text** — the next message you send becomes the post body.
3. Tap each destination to toggle it on/off (✅ / ⬜).
4. **Add Button** — send `Label | https://example.com` to attach an inline URL button; tap **🗑 Remove** on any existing button to drop it.
5. **Preview** shows exactly what will be sent, with a **Back to editor** button.
6. **Publish Now** sends immediately to the selected destinations. **Schedule** asks for a `YYYY-MM-DDTHH:MM` time (interpreted in `APP_TIMEZONE`) and lets Cron publish it later.
7. **Cancel Draft** deletes the draft, its dedicated button set, and its destination selections.

Composer state (which step you're on, which draft) lives in KV with a 30-minute TTL — if you go quiet mid-flow, it just expires; the draft itself stays in D1 until you finish or cancel it. Sending `/cancel` at any time clears a stuck session without touching the draft.

The original one-shot commands (`/publish`, `/schedule`, `/button`, `/changebutton`) still work unchanged and remain useful for scripting from Termux.

## 1. Create the Cloudflare Worker

Install Node.js, then:

```bash
npm install
npx wrangler login
```

Create the D1 database:

```bash
npx wrangler d1 create teammarysy
```

Copy the returned database ID into `wrangler.toml`.

Create the KV namespace (used for composer session state and webhook idempotency — no message content is ever stored here):

```bash
npx wrangler kv namespace create KV
```

Copy the returned `id` into the `[[kv_namespaces]]` block in `wrangler.toml`.

Apply the schema (now split across `0001_initial.sql` and `0002_composer.sql`):

```bash
npm run db:migrate:remote
```

## 2. Configure secrets

Create a `.dev.vars` file for local development based on `.dev.vars.example`.

For production, use Wrangler secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put OWNER_TELEGRAM_ID
```

Do not commit tokens or `.dev.vars`.

## 3. Deploy

```bash
npm run deploy
```

Cloudflare will provide a Worker URL such as:

`https://teammarysy-bot.<subdomain>.workers.dev`

## 4. Connect Telegram

Set the webhook using Telegram's Bot API. The webhook URL should be:

`https://YOUR-WORKER-DOMAIN/telegram/webhook`

Use the same secret value stored as `TELEGRAM_WEBHOOK_SECRET`.

Example:

```bash
curl -X POST \
  "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR-WORKER-DOMAIN/telegram/webhook" \
  -d "secret_token=YOUR_WEBHOOK_SECRET"
```

## 5. Configure destinations

Add destinations directly in D1, or add an owner command/UI for this.

Example:

```sql
INSERT INTO destinations (chat_id, title, type, enabled, created_at)
VALUES ('-1001234567890', 'Main Channel', 'channel', 1, strftime('%s','now'));
```

The bot must have permission to post in every configured channel/group.

## 6. Owner setup

Set `OWNER_TELEGRAM_ID` to the Telegram numeric user ID of the owner.

The owner can then use `/owner`.

Current owner commands:

- `/compose` (or `/newpost`) — open the visual composer (recommended)
- `/publish Your message`
- `/schedule 2026-09-01T10:00 Your message`
- `/button ButtonSet | Label | https://example.com`
- `/changebutton Label | https://new.example.com`
- `/destinations`
- `/access`

The inline control center is included as the starting UI.

## Scheduling

The Worker has a one-minute Cron Trigger. Cloudflare Cron Triggers run in UTC; the application stores schedule timestamps as Unix time and interprets the provided `/schedule` command as Asia/Manila in this baseline.

For a production-grade scheduler, validate timezone handling more strictly and add a dedicated schedule editor.

## Privacy

The schema intentionally does not create a permanent transcript table. User records, access decisions, destinations, posts, published-message mappings, and schedules are retained because they are required for the system's functions.

If additional conversation history is introduced later, define a retention period and deletion mechanism before enabling it.

## Security checklist

Before production:
- Set a strong webhook secret.
- Keep the Telegram bot token only in Cloudflare Secrets.
- Restrict all owner actions to OWNER_TELEGRAM_ID.
- Keep the D1 database ID in configuration, not as a secret.
- Add rate limiting before exposing high-volume user-facing features.
- Validate every URL supplied for inline buttons.
- Add audit logging for owner actions if the business requires it.
- Add error/retry handling for Telegram API failures.
- Add media/file handling separately if posts will contain photos, videos, or documents.
- Add a proper admin workflow for adding/removing destinations.

## Developer note

“TeamMarySy” is treated here as the project/bot name. It is not modeled as a third-party service, external setup, or required integration.
