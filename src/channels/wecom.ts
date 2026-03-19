import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

import { ASSISTANT_NAME, TRIGGER_PATTERN, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const WS_ENDPOINT = 'wss://openws.work.weixin.qq.com';
const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;
const MSG_MAX_CHARS = 2000; // WeCom markdown message character limit

// --- Text chunking ---
// Split text into sections by markdown headings, then pack sections into chunks
// that fit within MSG_MAX_CHARS. A section that exceeds the limit on its own
// is split further at paragraph → sentence boundaries.
function chunkText(text: string): string[] {
  if (text.length <= MSG_MAX_CHARS) return [text];

  // Split into logical sections at heading lines (##, ###, etc.)
  const sections: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line) && current.trim()) {
      sections.push(current.trimEnd());
      current = line + '\n';
    } else {
      current += line + '\n';
    }
  }
  if (current.trim()) sections.push(current.trimEnd());

  // Helper: split a single oversized block at paragraph / sentence boundary
  const splitBlock = (block: string): string[] => {
    const result: string[] = [];
    let rem = block;
    while (rem.length > MSG_MAX_CHARS) {
      let at = MSG_MAX_CHARS;
      const paraIdx = rem.lastIndexOf('\n\n', MSG_MAX_CHARS);
      if (paraIdx > MSG_MAX_CHARS * 0.3) {
        at = paraIdx + 2;
      } else {
        const lineIdx = rem.lastIndexOf('\n', MSG_MAX_CHARS);
        if (lineIdx > MSG_MAX_CHARS * 0.3) {
          at = lineIdx + 1;
        } else {
          const sentIdx = rem.slice(0, MSG_MAX_CHARS).search(/[。！？!?.]\s/);
          if (sentIdx > MSG_MAX_CHARS * 0.3) at = sentIdx + 2;
        }
      }
      result.push(rem.slice(0, at).trim());
      rem = rem.slice(at).trim();
    }
    if (rem) result.push(rem);
    return result;
  };

  // Pack sections greedily into chunks
  const chunks: string[] = [];
  let buf = '';
  for (const section of sections) {
    const sep = buf ? '\n\n' : '';
    if ((buf + sep + section).length <= MSG_MAX_CHARS) {
      buf += sep + section;
    } else {
      if (buf) { chunks.push(buf.trim()); buf = ''; }
      if (section.length <= MSG_MAX_CHARS) {
        buf = section;
      } else {
        // Section itself is too long — split it
        const parts = splitBlock(section);
        for (let i = 0; i < parts.length - 1; i++) chunks.push(parts[i]);
        buf = parts[parts.length - 1] ?? '';
      }
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// --- WhatsApp → WeCom markdown conversion ---
// WeCom uses **bold**, WhatsApp uses *bold*
function convertMarkdown(text: string): string {
  // Convert *bold* → **bold** (skip already-doubled **)
  return text.replace(/(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, '**$1**');
}

// --- <think> block formatting ---
// Converts <think>...</think> blocks to WeCom markdown blockquote style
function formatThinkBlocks(text: string): string {
  return text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, content) => {
    const trimmed = content.trim();
    if (!trimmed) return '';
    const quoted = trimmed.split('\n').map((l: string) => `> ${l}`).join('\n');
    return `> 💭 **思考过程**\n${quoted}\n`;
  });
}

// --- Quota tracker (passive replies: 30/day per JID) ---
class QuotaTracker {
  private counts = new Map<string, { date: string; passive: number }>();

  private today(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  }

  record(jid: string): void {
    const today = this.today();
    const entry = this.counts.get(jid);
    if (!entry || entry.date !== today) {
      this.counts.set(jid, { date: today, passive: 1 });
      return;
    }
    entry.passive++;
    if (entry.passive >= 25) {
      logger.warn({ jid, passive: entry.passive }, 'WeCom passive reply quota nearly exhausted (limit: 30/day)');
    }
  }

  count(jid: string): number {
    const today = this.today();
    const entry = this.counts.get(jid);
    return entry?.date === today ? entry.passive : 0;
  }
}

// --- WeCom Corp API (for file/image sending) ---
interface AccessTokenCache {
  token: string;
  expiresAt: number;
}

let _accessTokenCache: AccessTokenCache | null = null;

async function getAccessToken(corpId: string, corpSecret: string): Promise<string> {
  if (_accessTokenCache && Date.now() < _accessTokenCache.expiresAt) {
    return _accessTokenCache.token;
  }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`;
  const res = await fetch(url);
  const data = await res.json() as any;
  if (data.errcode !== 0) throw new Error(`WeCom gettoken failed: ${data.errmsg}`);
  _accessTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  return data.access_token;
}

async function uploadMedia(accessToken: string, filePath: string, filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('curl', [
      '-s', '-X', 'POST',
      `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${accessToken}&type=file`,
      '-F', `media=@${filePath};filename=${filename}`,
    ], (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout) as any;
        if (data.errcode !== 0 && data.errcode !== undefined) return reject(new Error(`WeCom upload failed: ${data.errmsg}`));
        resolve(data.media_id);
      } catch (e) { reject(e); }
    });
  });
}

export interface WeComChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  jidPrefix?: string;
  corpId?: string;
  corpSecret?: string;
  agentId?: number;
}

export class WeComChannel implements Channel {
  name = 'wecom';
  prefixAssistantName = false;

  private botId: string;
  private secret: string;
  private opts: WeComChannelOpts;
  private jidPrefix: string;
  private corpId: string;
  private corpSecret: string;
  private agentId: number;
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private quota = new QuotaTracker();
  private reconnectDelay = 5_000;
  private readonly maxReconnectDelay = 300_000;

  // response_url per JID (from aibot_msg_callback, used for HTTP reply)
  private responseUrls: Map<string, string> = new Map();
  // chattype per JID: 'single' | 'group'
  private chatTypes: Map<string, string> = new Map();
  // last msgid per JID
  private lastMsgIds: Map<string, string> = new Map();
  // last req_id from incoming message headers (required for aibot_respond_msg)
  private lastReqIds: Map<string, string> = new Map();
  // last sender userid per JID (used for file delivery to individual in group chats)
  private lastSenders: Map<string, string> = new Map();
  // path to persist req_ids across restarts
  private readonly reqIdStorePath: string;
  // per-JID send queue to prevent chunk interleaving across concurrent sendMessage calls
  private sendQueues: Map<string, Promise<void>> = new Map();
  // pending WebSocket messages awaiting ack, keyed by req_id (for 846604 retry)
  private pendingWsMessages: Map<string, { jid: string; text: string; ts: number }> = new Map();

  constructor(botId: string, secret: string, opts: WeComChannelOpts) {
    this.botId = botId;
    this.secret = secret;
    this.opts = opts;
    this.jidPrefix = opts.jidPrefix ?? 'wc:';
    this.corpId = opts.corpId ?? '';
    this.corpSecret = opts.corpSecret ?? '';
    this.agentId = opts.agentId ?? 0;
    this.reqIdStorePath = path.join(STORE_DIR, `wecom-reqids-${botId.slice(-8)}.json`);
    this._loadReqIds();
  }

  private _loadReqIds(): void {
    try {
      if (fs.existsSync(this.reqIdStorePath)) {
        const data = JSON.parse(fs.readFileSync(this.reqIdStorePath, 'utf-8'));
        for (const [jid, reqId] of Object.entries(data)) {
          this.lastReqIds.set(jid, reqId as string);
        }
        logger.debug({ count: this.lastReqIds.size }, 'WeCom req_ids loaded from disk');
      }
    } catch (err) {
      logger.warn({ err }, 'WeCom: failed to load persisted req_ids');
    }
  }

  private _saveReqIds(): void {
    try {
      const data: Record<string, string> = {};
      for (const [jid, reqId] of this.lastReqIds) data[jid] = reqId;
      fs.writeFileSync(this.reqIdStorePath, JSON.stringify(data));
    } catch (err) {
      logger.warn({ err }, 'WeCom: failed to persist req_ids');
    }
  }

  async connect(): Promise<void> {
    this.stopped = false;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_ENDPOINT);
      this.ws = ws;
      let resolved = false;

      const done = (err?: Error) => {
        if (resolved) return;
        resolved = true;
        if (err) reject(err);
        else resolve();
      };

      ws.on('open', () => {
        logger.info('WeCom WebSocket connected, subscribing bot');
        this._send({
          cmd: 'aibot_subscribe',
          headers: { req_id: randomUUID() },
          body: { bot_id: this.botId, secret: this.secret },
        });
        done();
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          logger.warn({ raw: raw.toString() }, 'WeCom: failed to parse message');
          return;
        }
        this._handleMessage(msg);
      });

      ws.on('close', (code, reason) => {
        this._stopPing();
        logger.warn({ code, reason: reason.toString() }, 'WeCom WebSocket closed');
        if (!this.stopped) {
          this.reconnectTimer = setTimeout(() => this._reconnect(), this.reconnectDelay);
        }
      });

      ws.on('error', (err) => {
        logger.error({ err }, 'WeCom WebSocket error');
        done(err);
      });
    });
  }

  private _reconnect(): void {
    const ws = new WebSocket(WS_ENDPOINT);
    this.ws = ws;

    ws.on('open', () => {
      logger.info('WeCom WebSocket reconnected, re-subscribing bot');
      this._send({
        cmd: 'aibot_subscribe',
        headers: { req_id: randomUUID() },
        body: { bot_id: this.botId, secret: this.secret },
      });
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this._handleMessage(msg);
    });

    ws.on('close', (code, reason) => {
      this._stopPing();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      logger.warn({ code, reason: reason.toString(), nextDelayMs: this.reconnectDelay }, 'WeCom WebSocket closed, will retry');
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this._reconnect(), this.reconnectDelay);
      }
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WeCom WebSocket reconnect error');
    });
  }

  private _handleMessage(msg: any): void {
    // Error response (no cmd, errcode non-zero)
    if (msg.errcode !== undefined && msg.errcode !== 0) {
      logger.error({ errcode: msg.errcode, errmsg: msg.errmsg }, 'WeCom server error');
      console.error(`\n  WeCom error ${msg.errcode}: ${msg.errmsg}\n`);
      // 846604 = websocket request expired — retry via proactive Corp API
      if (msg.errcode === 846604) {
        const reqId: string | undefined = msg.headers?.req_id;
        if (reqId) {
          const pending = this.pendingWsMessages.get(reqId);
          if (pending) {
            this.pendingWsMessages.delete(reqId);
            logger.info({ jid: pending.jid }, 'WeCom 846604: retrying via proactive send');
            this._sendProactive(pending.jid, pending.text).catch(err => {
              logger.error({ err }, 'WeCom proactive retry after 846604 failed');
            });
          }
        }
      }
      return;
    }

    const cmd: string = msg.cmd || '';

    if (cmd === 'aibot_msg_callback') {
      this._handleInboundMsg(msg);
      return;
    }

    if (cmd === 'aibot_event_callback') {
      logger.debug({ body: msg.body }, 'WeCom event callback (ignored)');
      return;
    }

    // Subscription/ping ack: {headers, errcode: 0, errmsg: "ok"} or {headers, errcode: 0}
    if (!cmd && msg.headers) {
      if (!this.pingTimer) {
        // First ack = subscription confirmed; reset backoff
        this.reconnectDelay = 5_000;
        logger.info('WeCom bot subscribed successfully');
        console.log(`\n  WeCom bot connected (bot_id: ${this.botId})\n`);
        this._startPing();
      }
      return;
    }

    logger.debug({ cmd }, 'WeCom: unhandled message');
  }

  private _handleInboundMsg(msg: any): void {
    const body = msg.body || {};
    const fromUser: string = body.from?.userid || body.from_user || body.sender || '';
    const chattype: string = body.chattype || 'single';
    // For group chats, body.chat_id is the group id; for single chats there may be no chat_id
    const chatId: string = body.chat_id || body.chatid || fromUser;
    const msgId: string = body.msgid || body.msg_id || randomUUID();
    const msgType: string = body.msgtype || 'text';
    const timestamp = new Date(body.create_time ? body.create_time * 1000 : Date.now()).toISOString();
    const chatJid = `${this.jidPrefix}${chatId}`;

    if (body.response_url) this.responseUrls.set(chatJid, body.response_url);
    this.chatTypes.set(chatJid, chattype);
    this.lastMsgIds.set(chatJid, msgId);
    const reqId: string = msg.headers?.req_id || '';
    if (reqId) {
      this.lastReqIds.set(chatJid, reqId);
      this._saveReqIds();
    }
    if (fromUser) this.lastSenders.set(chatJid, fromUser);

    this.opts.onChatMetadata(chatJid, timestamp, chattype === 'single' ? fromUser : chatId);

    let content: string;
    if (msgType === 'text') {
      content = body.text?.content || body.content || '';
    } else if (msgType === 'image') {
      content = '[Image]';
    } else if (msgType === 'file') {
      content = `[File: ${body.file?.filename || 'file'}]`;
    } else if (msgType === 'voice') {
      content = '[Voice message]';
    } else if (msgType === 'video') {
      content = '[Video]';
    } else {
      content = `[${msgType}]`;
    }

    // Single chat: always prepend trigger (no @mention needed, it's a direct conversation)
    if (chattype === 'single' && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    } else {
      // Group chat: translate @bot mentions into trigger pattern
      const botIdLower = this.botId.toLowerCase();
      if (content.toLowerCase().includes(`@${botIdLower}`) && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.info({ chatJid, chattype, from: fromUser, chat_id: body.chat_id || body.chatid }, 'Message from unregistered WeCom chat — register this JID to enable replies');
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: fromUser,
      sender_name: fromUser,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: fromUser }, 'WeCom message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prev = this.sendQueues.get(jid) ?? Promise.resolve();
    const next = prev.then(async () => {
      const formatted = formatThinkBlocks(text);
      const chunks = chunkText(formatted);
      for (let i = 0; i < chunks.length; i++) {
        // Add delay between chunks to ensure WeCom delivers them in order
        // (WebSocket sends are fire-and-forget, rapid succession can reorder)
        if (i > 0) await new Promise(r => setTimeout(r, 500));
        await this._sendChunk(jid, chunks[i]);
      }
    });
    this.sendQueues.set(jid, next.catch(() => {}));
    await next;
  }

  private async _sendChunk(jid: string, text: string): Promise<void> {
    const responseUrl = this.responseUrls.get(jid);
    const reqId = this.lastReqIds.get(jid);

    // response_url is single-use: one shot, then discard
    if (responseUrl) {
      this.responseUrls.delete(jid);
      try {
        const resBody = await this._httpsPost(responseUrl, { msgtype: 'markdown', markdown: { content: text } });
        logger.info({ jid, resBody }, 'WeCom response_url reply result');
        this.quota.record(jid);
        return;
      } catch (err) {
        logger.warn({ jid, err }, 'WeCom response_url failed, falling back to WebSocket');
        // fall through to WebSocket
      }
    }

    // WebSocket path
    if (reqId) {
      this._sendViaWebSocket(jid, text, reqId);
      this.quota.record(jid);
      return;
    }

    // No passive reply context — fall back to proactive Corp API send
    await this._sendProactive(jid, text);
  }

  private async _sendProactive(jid: string, text: string): Promise<void> {
    if (!this.corpId || !this.corpSecret || !this.agentId) {
      logger.warn({ jid }, 'WeCom proactive send: corp credentials not configured, message dropped');
      return;
    }
    try {
      const token = await getAccessToken(this.corpId, this.corpSecret);
      const rawId = jid.slice(this.jidPrefix.length);
      const chatType = this.chatTypes.get(jid) || 'single';
      const toUser = chatType === 'group'
        ? (this.lastSenders.get(jid) ?? this.opts.registeredGroups()[jid]?.notifyUser)
        : rawId;
      if (!toUser) {
        logger.warn({ jid }, 'WeCom proactive send: no known user id for group, message dropped');
        return;
      }
      const formatted = convertMarkdown(text);
      const resBody = await this._httpsPost(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        { touser: toUser, msgtype: 'markdown', agentid: this.agentId, markdown: { content: formatted } },
      );
      logger.info({ jid, chatType, toUser, length: text.length, resBody }, 'WeCom proactive message sent');
    } catch (err) {
      logger.error({ jid, err }, 'WeCom proactive send failed');
    }
  }

  private _sendViaWebSocket(jid: string, text: string, reqId: string | undefined): void {
    if (!reqId) {
      logger.warn({ jid }, 'WeCom WebSocket fallback: no req_id, message dropped');
      return;
    }
    // Store for retry on 846604; clean up stale entries (>5 min) to prevent leak
    const now = Date.now();
    for (const [id, entry] of this.pendingWsMessages) {
      if (now - entry.ts > 300_000) this.pendingWsMessages.delete(id);
    }
    this.pendingWsMessages.set(reqId, { jid, text, ts: now });
    this._send({
      cmd: 'aibot_respond_msg',
      headers: { req_id: reqId },
      body: { msgtype: 'markdown', markdown: { content: text } },
    });
    logger.info({ jid, reqId, length: text.length }, 'WeCom WebSocket fallback sent');
  }

  async sendFile(jid: string, filePath: string, filename?: string): Promise<void> {
    await this._sendMedia(jid, filePath, filename || path.basename(filePath), 'file');
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    await this._sendMedia(jid, imagePath, path.basename(imagePath), 'image');
    if (caption) await this.sendMessage(jid, caption);
  }

  private async _sendMedia(jid: string, filePath: string, filename: string, type: 'file' | 'image'): Promise<void> {
    if (!this.corpId || !this.corpSecret || !this.agentId) {
      logger.warn({ jid }, 'WeCom file send: corp credentials not configured');
      return;
    }
    if (!fs.existsSync(filePath)) {
      logger.warn({ jid, filePath }, 'WeCom file send: file not found');
      return;
    }
    try {
      const token = await getAccessToken(this.corpId, this.corpSecret);
      const mediaId = await uploadMedia(token, filePath, filename);
      // Extract raw ID from JID (strip prefix)
      const rawId = jid.slice(this.jidPrefix.length);
      const chatType = this.chatTypes.get(jid) || 'single';
      // For group chats, send to the last sender's userid (appchat/send only works for API-created groups)
      const toUser = chatType === 'group'
        ? (this.lastSenders.get(jid) ?? this.opts.registeredGroups()[jid]?.notifyUser ?? rawId)
        : rawId;
      const resBody = await this._httpsPost(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        { touser: toUser, msgtype: type, agentid: this.agentId, [type]: { media_id: mediaId } },
      );
      logger.info({ jid, filename, type, resBody }, 'WeCom file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'WeCom file send failed');
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(this.jidPrefix);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this._stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('WeCom bot stopped');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // WeCom Bot API does not expose a typing indicator
  }

  private _startPing(): void {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this._send({ cmd: 'ping', headers: { req_id: randomUUID() } });
      }
    }, PING_INTERVAL_MS);
  }

  private _stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private _httpsPost(url: string, payload: object): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('curl', [
        '-s', '--ipv4', '-X', 'POST', url,
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify(payload),
        '--max-time', '30',
      ], (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  private _send(payload: object): void {
    this.ws?.send(JSON.stringify(payload));
  }
}
