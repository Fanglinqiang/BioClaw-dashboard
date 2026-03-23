# Messaging channels

BioClaw can connect to one or more chat platforms. Configure each channel with environment variables in `.env` at the project root.

For **Windows** and **browser-only (local web)** workflows, see also [WINDOWS.zh-CN.md](WINDOWS.zh-CN.md) (Chinese; covers WSL2 + local web) — the local web env vars are the same on all platforms.

---

## WhatsApp (default)

No API keys required. On first run, a QR code is printed in the terminal — scan it with WhatsApp. Auth state is stored under `store/auth/`.

To turn WhatsApp off while using other channels:

```bash
DISABLE_WHATSAPP=1
```

Or:

```bash
ENABLE_WHATSAPP=false
```

---

## WeCom (Enterprise WeChat)

1. Log in to the [WeCom Admin Console](https://work.weixin.qq.com/wework_admin/frame).
2. Go to **Apps & Mini Programs** → **Smart Robots** → **Create**.
3. Choose **API mode** with **Long Connection** (not callback URL).
4. Copy **Bot ID** and **Secret** into `.env`:

   ```bash
   WECOM_BOT_ID=your-bot-id
   WECOM_SECRET=your-secret
   ```

5. Add the bot to a WeCom group and `@` it to chat.

**Images (optional):** Create a self-built app in the admin console and set:

```bash
WECOM_CORP_ID=your-corp-id
WECOM_AGENT_ID=your-agent-id
WECOM_CORP_SECRET=your-corp-secret
```

The server IP must be on that app’s trusted IP whitelist.

---

## Feishu (Lark)

BioClaw currently supports **text receive/reply** for Feishu bots. Start with **WebSocket mode** if possible; use webhook mode only when your deployment requires inbound HTTP callbacks.

1. Create a bot app in the [Feishu Open Platform](https://open.feishu.cn/).
2. Enable the **message receive** event for your bot and grant the permissions needed to read and send IM messages.
3. Add to `.env`:

   ```bash
   FEISHU_APP_ID=cli_xxx
   FEISHU_APP_SECRET=your-app-secret
   FEISHU_CONNECTION_MODE=websocket
   ```

4. If you use **webhook** mode, also configure:

   ```bash
   FEISHU_CONNECTION_MODE=webhook
   FEISHU_VERIFICATION_TOKEN=your-verification-token
   FEISHU_ENCRYPT_KEY=your-encrypt-key
   FEISHU_HOST=0.0.0.0
   FEISHU_PORT=8080
   FEISHU_PATH=/feishu/events
   ```

5. Invite the bot into a Feishu chat or group and send the first message. BioClaw auto-registers the conversation and can reply in text.

Current limitations: image/file sending is not implemented yet.

---

## Discord

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. **New Application** → **Bot** → **Add Bot**.
3. Under **Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT**.
4. Add to `.env`:

   ```bash
   DISCORD_BOT_TOKEN=your-bot-token
   ```

5. **OAuth2** → **URL Generator**: scope `bot`; permissions e.g. Send Messages, Attach Files, Read Message History.
6. Open the generated URL to invite the bot to a server.
7. Send a message in a channel — the bot auto-registers and can reply.

---

## Slack (Socket Mode)

BioClaw connects with **[Socket Mode](https://api.slack.com/apis/socket-mode)** so you do **not** need a public HTTPS URL for Event Subscriptions.

1. Create an app at **[api.slack.com/apps](https://api.slack.com/apps)** → **Create New App**.
2. **Socket Mode** → turn **On** → **Generate an app-level token** with scope **`connections:write`** → copy the token (`xapp-...`).
3. **OAuth & Permissions** → **Bot Token Scopes** (add at least):
   - `channels:history`, `groups:history`, `im:history`, `mpim:history` — read messages
   - `chat:write` — reply in channels / DMs
   - `files:write` — send images from the agent (optional but recommended)
   - `users:read` — resolve display names
   - `channels:read` — channel metadata (optional; helps conversation titles)
4. **Install to Workspace** and copy **Bot User OAuth Token** (`xoxb-...`).
5. **Event Subscriptions** → enable events → subscribe to **`message`** (or the granular `message.channels`, `message.groups`, `message.im`, `message.mpim` events, depending on your app UI).
6. Invite the app to a channel (`/invite @YourApp`) or open a DM with it.
7. Add to `.env`:

   ```bash
   SLACK_BOT_TOKEN=xoxb-your-bot-token
   SLACK_APP_TOKEN=xapp-your-app-token
   ```

Restart BioClaw. The first message in a conversation auto-registers that workspace like Discord.

---

## Local web UI (browser chat)

Useful when you want a **local HTTP chat** without WhatsApp (e.g. on Windows or for quick testing).

1. Optional: in `.env` set `ENABLE_WHATSAPP=false` if you only want the browser channel (see `config-examples/.env.local-web.example` for other vars).

2. **Start the server with the web UI in one command:**

   ```bash
   npm run web
   ```

   This runs BioClaw with **`ENABLE_LOCAL_WEB=true`** — **chat and lab trace on the same page** at **`/`** (tabs or split layout: **trace / workflow on the left**, **chat on the right** when wide). It still loads the rest of your `.env` (model keys, other channels, etc.).

3. Open **`http://localhost:3000/`** (or your `LOCAL_WEB_HOST` / `LOCAL_WEB_PORT`).

To free the web port: **`npm run stop:web`**. Optional: **`npm run open:web`** only opens the browser (does not start the server).

The built-in page is a **lab-style UI** with **SSE** for messages (`/api/events`) and **lab trace** on the same URL (`/`) with **`/api/trace/*`** and **`/api/workspace/*`**. Open **Settings** (gear) for **English / 中文** and theme (`localStorage`). See [DASHBOARD.md](DASHBOARD.md).

Optional: `LOCAL_WEB_SECRET` to require a shared secret on the webhook.

### Chat messages vs lab trace (data shape)

- **Chat (`messages` table, `/api/messages`)** — Each row is a normal message: `content` is **plain text** (what the user and assistant see). There is **no required JSON envelope** for syncing chat; the UI may render Markdown in the browser. Special multi-line blocks (e.g. upload cards) use **plain-text prefixes** like `Uploaded file:` / `Workspace path:` / `Preview URL:` parsed by the web UI.
- **Lab trace (`agent_trace_events`, `/api/trace/list`)** — Rows are **typed events** with a `type` string (`run_start`, `stream_output`, `run_end`, `run_error`, `container_spawn`, `ipc_send`, …) and a **`payload` JSON object** (stored as JSON text). That format is for **observability**, not for user chat. The merged page defaults to **`compact=1`**, which hides noisy `stream_output` rows unless you enable “stream chunks” in the UI.

---

## WeChat Personal Account

1. Add to `.env`:

   ```bash
   ENABLE_WECHAT=true
   ```

2. Run BioClaw in a **foreground terminal** (the QR code must be visible):

   ```bash
   npm start
   ```

3. Scan the QR code with your WeChat app to log in. Auth state is **not** persisted — you will need to scan again on each restart.

4. Send a message in any WeChat conversation. BioClaw auto-registers the conversation and can reply with text and images.

**Limitations:**
- No proactive messages — the SDK can only respond to inbound messages (request-response pattern).
- Multiple outputs (text + image) are buffered and sent as a single reply.
- Voice messages, file sharing, and group @ mentions are not supported.
- Based on Tencent's OpenClaw WeChat channel (`@tencent-weixin/openclaw-weixin`), community-wrapped by [weixin-agent-sdk](https://github.com/wong2/weixin-agent-sdk). Not officially supported — API may change without notice.

---

## Disabling channels

- **WhatsApp only off:** `DISABLE_WHATSAPP=1` or `ENABLE_WHATSAPP=false` (other channels can still run if configured).
- **Feishu / WeCom / Discord / Slack:** Remove or leave empty their token variables if you do not use them.

See `.env.example` for all channel-related variables.
