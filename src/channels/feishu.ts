import fs from 'fs';
import https from 'https';
import path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  StreamingToolCall,
} from '../types.js';

// Feishu post message max content size (30 KB but we stay conservative)
const POST_MAX_CHARS = 20_000;

// --- Text chunking (same pattern as WeCom) ---
function chunkText(text: string): string[] {
  if (text.length <= POST_MAX_CHARS) return [text];

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

  const splitBlock = (block: string): string[] => {
    const result: string[] = [];
    let rem = block;
    while (rem.length > POST_MAX_CHARS) {
      let at = POST_MAX_CHARS;
      const paraIdx = rem.lastIndexOf('\n\n', POST_MAX_CHARS);
      if (paraIdx > POST_MAX_CHARS * 0.3) {
        at = paraIdx + 2;
      } else {
        const lineIdx = rem.lastIndexOf('\n', POST_MAX_CHARS);
        if (lineIdx > POST_MAX_CHARS * 0.3) {
          at = lineIdx + 1;
        } else {
          const sentIdx = rem.slice(0, POST_MAX_CHARS).search(/[。！？!?.]\s/);
          if (sentIdx > POST_MAX_CHARS * 0.3) at = sentIdx + 2;
        }
      }
      result.push(rem.slice(0, at).trim());
      rem = rem.slice(at).trim();
    }
    if (rem) result.push(rem);
    return result;
  };

  const chunks: string[] = [];
  let buf = '';
  for (const section of sections) {
    const sep = buf ? '\n\n' : '';
    if ((buf + sep + section).length <= POST_MAX_CHARS) {
      buf += sep + section;
    } else {
      if (buf) { chunks.push(buf.trim()); buf = ''; }
      if (section.length <= POST_MAX_CHARS) {
        buf = section;
      } else {
        const parts = splitBlock(section);
        for (let i = 0; i < parts.length - 1; i++) chunks.push(parts[i]);
        buf = parts[parts.length - 1] ?? '';
      }
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// --- Markdown → Feishu post content ---
// Converts a markdown text block into Feishu post content elements.
// Each line becomes one or more elements in a paragraph (array of arrays).
function markdownToPostContent(text: string): Array<Array<{ tag: string; text?: string; href?: string }>> {
  const paragraphs: Array<Array<{ tag: string; text?: string; href?: string }>> = [];

  for (const line of text.split('\n')) {
    const elements: Array<{ tag: string; text?: string; href?: string }> = [];

    // Strip heading markers, keep text
    const stripped = line.replace(/^#{1,6}\s*/, '');

    if (!stripped) {
      // Empty line → empty paragraph (visual spacing)
      paragraphs.push([{ tag: 'text', text: '' }]);
      continue;
    }

    // Parse inline links [text](url) and plain text segments
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(stripped)) !== null) {
      if (match.index > lastIdx) {
        elements.push({ tag: 'text', text: stripped.slice(lastIdx, match.index) });
      }
      elements.push({ tag: 'a', text: match[1], href: match[2] });
      lastIdx = match.index + match[0].length;
    }
    if (lastIdx < stripped.length) {
      elements.push({ tag: 'text', text: stripped.slice(lastIdx) });
    }

    paragraphs.push(elements);
  }

  return paragraphs;
}

// Determine file_type for Feishu upload from file extension
function getFeishuFileType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const map: Record<string, string> = {
    mp4: 'mp4',
    opus: 'opus',
    pdf: 'pdf',
    doc: 'doc',
    docx: 'doc',
    xls: 'xls',
    xlsx: 'xls',
    ppt: 'ppt',
    pptx: 'ppt',
  };
  return map[ext] ?? 'stream';
}

/** Download a Feishu message resource (image or file) using native https. */
function downloadMessageResource(
  token: string,
  messageId: string,
  resourceKey: string,
  type: 'image' | 'file',
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${resourceKey}?type=${type}`;
    https.get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`)));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  jidPrefix?: string; // default: 'fs:'
  /** Auto-register new chats to this folder (skips manual dashboard registration) */
  defaultFolder?: string;
  /** Agent type for auto-registered groups */
  defaultAgentType?: 'claude' | 'minimax' | 'qwen';
  /** Called when a new group is auto-registered */
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
}

export class FeishuChannel implements Channel {
  name = 'feishu';
  prefixAssistantName = false;

  private appId: string;
  private appSecret: string;
  private opts: FeishuChannelOpts;
  private jidPrefix: string;
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private connected = false;
  private stopped = false;
  // per-JID send queue to prevent chunk interleaving
  private sendQueues: Map<string, Promise<void>> = new Map();
  // dedup: track processed message IDs to avoid double-processing
  private processedMsgIds = new Set<string>();

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
    this.jidPrefix = opts.jidPrefix ?? 'fs:';

    this.client = new lark.Client({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });
  }

  async connect(): Promise<void> {
    this.stopped = false;

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        logger.debug({ chatId: data.message?.chat_id, chatType: data.message?.chat_type, msgType: data.message?.message_type, senderType: data.sender?.sender_type }, 'Feishu raw event received');
        await this._handleMessage(data);
      },
    });

    // WSClient.start() fires off the connection asynchronously (no await needed)
    await this.wsClient.start({ eventDispatcher: dispatcher });

    this.connected = true;
    logger.info({ appId: this.appId }, 'Feishu WebSocket long-connection started');
  }

  isConnected(): boolean {
    return this.connected && !this.stopped;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    try {
      this.wsClient.close({ force: true });
    } catch (_) { /* ignore */ }
    logger.info('Feishu channel disconnected');
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(this.jidPrefix);
  }

  // --- Inbound message handling ---
  private async _handleMessage(data: {
    sender: { sender_id?: { open_id?: string }; sender_type: string };
    message: {
      message_id: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
    };
  }): Promise<void> {
    const { sender, message } = data;

    // Skip bot's own messages
    if (sender.sender_type === 'app') return;

    // Dedup
    if (this.processedMsgIds.has(message.message_id)) return;
    this.processedMsgIds.add(message.message_id);
    // Keep set bounded
    if (this.processedMsgIds.size > 500) {
      const first = this.processedMsgIds.values().next().value;
      if (first) this.processedMsgIds.delete(first);
    }

    const msgType = message.message_type;
    if (!['text', 'image', 'file', 'audio'].includes(msgType)) return;

    const jid = `${this.jidPrefix}${message.chat_id}`;
    const senderId = sender.sender_id?.open_id ?? 'unknown';
    const timestamp = new Date().toISOString();

    // Parse content based on message type
    let text = '';
    let attachmentNote = '';

    if (msgType === 'text') {
      try {
        const parsed = JSON.parse(message.content) as { text?: string };
        text = parsed.text ?? '';
      } catch {
        logger.warn({ content: message.content }, 'Feishu: failed to parse text content');
        return;
      }
    } else {
      // image / file / audio — download and save to group folder, then add a note
      try {
        const parsed = JSON.parse(message.content) as Record<string, string>;
        const groups = this.opts.registeredGroups();
        const group = groups[jid];
        const groupFolder = group?.folder;

        if (groupFolder) {
          const groupDir = path.join(GROUPS_DIR, groupFolder);
          fs.mkdirSync(groupDir, { recursive: true });

          const token = await (this.client as any).tokenManager.getTenantAccessToken();

          if (msgType === 'image') {
            const imageKey = parsed.image_key;
            if (imageKey) {
              const filename = `feishu-img-${message.message_id.slice(-8)}.jpg`;
              const dest = path.join(groupDir, filename);
              try {
                const buf = await downloadMessageResource(token, message.message_id, imageKey, 'image');
                fs.writeFileSync(dest, buf);
                attachmentNote = `[用户发送了图片: ${filename}]`;
                logger.info({ jid, filename }, 'Feishu: image saved');
              } catch (e) {
                logger.warn({ err: e, imageKey }, 'Feishu: failed to download image');
                attachmentNote = '[用户发送了图片，下载失败]';
              }
            }
          } else if (msgType === 'file' || msgType === 'audio') {
            const fileKey = parsed.file_key ?? parsed.audio_key;
            const fileName = parsed.file_name ?? `feishu-${msgType}-${message.message_id.slice(-8)}`;
            if (fileKey) {
              const dest = path.join(groupDir, fileName);
              try {
                const buf = await downloadMessageResource(token, message.message_id, fileKey, 'file');
                fs.writeFileSync(dest, buf);
                attachmentNote = `[用户发送了文件: ${fileName}]`;
                logger.info({ jid, fileName }, 'Feishu: file saved');
              } catch (e) {
                logger.warn({ err: e, fileKey }, 'Feishu: failed to download file');
                attachmentNote = `[用户发送了文件: ${fileName}，下载失败]`;
              }
            }
          }
        } else {
          // Group not yet registered — still want to trigger agent after registration
          if (msgType === 'image') attachmentNote = '[用户发送了图片]';
          else attachmentNote = '[用户发送了文件]';
        }
      } catch (e) {
        logger.warn({ err: e }, 'Feishu: failed to handle attachment');
        return;
      }
      text = attachmentNote;
    }

    // Strip @mention tokens from text (works for both group and p2p)
    if (msgType === 'text') {
      text = text.replace(/@[^\s]+/g, '').trim();
    }

    if (!text) return;

    logger.info({ jid, senderId, chatType: message.chat_type, msgType, textLen: text.length }, 'Feishu message received');

    // Auto-register unrecognised chats when defaultFolder is configured
    if (this.opts.defaultFolder && this.opts.onRegisterGroup) {
      const known = this.opts.registeredGroups();
      if (!known[jid]) {
        const chatType = message.chat_type as 'p2p' | 'group';
        const autoGroup: RegisteredGroup = {
          name: jid,
          folder: this.opts.defaultFolder,
          trigger: TRIGGER_PATTERN.source,
          added_at: timestamp,
          agentType: this.opts.defaultAgentType,
          // p2p chats don't need a trigger word; group chats respond to all messages
          requiresTrigger: false,
        };
        this.opts.onRegisterGroup(jid, autoGroup);
        logger.info({ jid, folder: this.opts.defaultFolder, chatType }, 'Feishu: auto-registered new chat');
      }
    }

    // Register chat metadata
    this.opts.onChatMetadata(jid, timestamp);

    // Deliver message to orchestrator
    this.opts.onMessage(jid, {
      id: message.message_id,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderId,
      content: text,
      timestamp,
    });
  }

  // --- Outbound: text ---
  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.slice(this.jidPrefix.length);
    const chunks = chunkText(text);

    // Queue per JID to prevent chunk interleaving
    const prev = this.sendQueues.get(jid) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (const chunk of chunks) {
        await this._sendPost(chatId, chunk);
        if (chunks.length > 1) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    });
    this.sendQueues.set(jid, next.catch(() => { /* swallow so queue keeps going */ }));
    return next;
  }

  // Send a single text chunk as Feishu post (rich text) — preserves markdown formatting
  private async _sendPost(chatId: string, text: string): Promise<void> {
    const content = markdownToPostContent(text);

    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify({ zh_cn: { title: '', content } }),
        },
      });
      if (res.code !== 0) {
        logger.error({ chatId, code: res.code, msg: res.msg }, 'Feishu sendMessage failed');
      }
    } catch (err) {
      logger.error({ err, chatId }, 'Feishu sendMessage error');
    }
  }

  // --- Outbound: image ---
  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    const chatId = jid.slice(this.jidPrefix.length);

    try {
      // 1. Upload image
      const imageBuffer = fs.createReadStream(imagePath);
      const uploadRes = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: imageBuffer,
        },
      }) as any;

      const imageKey: string | undefined = uploadRes?.image_key ?? uploadRes?.data?.image_key;
      if (!imageKey) {
        logger.error({ uploadRes }, 'Feishu image upload failed — no image_key');
        return;
      }

      // 2. Send image message
      const sendRes = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });

      if (sendRes.code !== 0) {
        logger.error({ chatId, code: sendRes.code }, 'Feishu sendImage failed');
      }

      // 3. Send caption if provided
      if (caption) {
        await this.sendMessage(jid, caption);
      }

      logger.info({ chatId, imageKey }, 'Feishu image sent');
    } catch (err) {
      logger.error({ err, chatId, imagePath }, 'Feishu sendImage error');
    }
  }

  // --- Outbound: file ---
  async sendFile(jid: string, filePath: string): Promise<void> {
    const chatId = jid.slice(this.jidPrefix.length);
    const fileName = path.basename(filePath);
    const fileType = getFeishuFileType(filePath);

    try {
      // 1. Upload file
      const fileStream = fs.createReadStream(filePath);
      const uploadRes = await this.client.im.file.create({
        data: {
          file_type: fileType as any,
          file_name: fileName,
          file: fileStream,
        },
      }) as any;

      const fileKey: string | undefined = uploadRes?.file_key ?? uploadRes?.data?.file_key;
      if (!fileKey) {
        logger.error({ uploadRes }, 'Feishu file upload failed — no file_key');
        return;
      }

      // 2. Send file message
      const sendRes = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      if (sendRes.code !== 0) {
        logger.error({ chatId, code: sendRes.code }, 'Feishu sendFile failed');
      }

      logger.info({ chatId, fileKey, fileName }, 'Feishu file sent');
    } catch (err) {
      logger.error({ err, chatId, filePath }, 'Feishu sendFile error');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu doesn't support typing indicators via bot API
  }

  // --- Streaming card helpers ---

  /** Build tool status lines for card display */
  private _buildToolStatusText(toolCalls?: StreamingToolCall[]): string {
    if (!toolCalls?.length) return '';
    const lines = toolCalls.map(t => {
      const icon = t.status === 'running' ? '🔄' : t.status === 'complete' ? '✅' : '❌';
      // Show friendly tool name (strip mcp__bioclaw__ prefix)
      const name = t.tool.replace(/^mcp__bioclaw__/, '').replace(/_/g, ' ');
      return `${icon} ${name}`;
    });
    return '\n\n---\n' + lines.join('\n');
  }

  /** Build card elements array with text + optional tool status */
  private _buildCardElements(text: string, toolCalls?: StreamingToolCall[], elapsedMs?: number): any[] {
    const elements: any[] = [
      {
        tag: 'markdown',
        content: text,
        element_id: 'streaming_content',
        text_size: 'normal',
      },
    ];

    // Tool status section
    if (toolCalls?.length) {
      const toolText = toolCalls.map(t => {
        const icon = t.status === 'running' ? '🔄' : t.status === 'complete' ? '✅' : '❌';
        const name = t.tool.replace(/^mcp__bioclaw__/, '').replace(/_/g, ' ');
        return `${icon} ${name}`;
      }).join('\n');
      elements.push({
        tag: 'markdown',
        content: toolText,
        element_id: 'tool_status',
        text_size: 'notation',
      });
    }

    // Elapsed time footer
    if (elapsedMs !== undefined) {
      const secs = (elapsedMs / 1000).toFixed(1);
      elements.push({
        tag: 'markdown',
        content: `⏱ ${secs}s`,
        element_id: 'footer',
        text_size: 'notation',
      });
    }

    return elements;
  }

  // --- Streaming card support via CardKit 2.0 ---

  async createStreamingCard(jid: string): Promise<string | null> {
    const chatId = jid.slice(this.jidPrefix.length);

    try {
      // 1. Build Card JSON 2.0 with a streaming markdown element
      const cardData = {
        schema: '2.0',
        body: {
          elements: [
            {
              tag: 'markdown',
              content: '思考中...',
              element_id: 'streaming_content',
              text_size: 'normal',
            },
          ],
        },
        header: {
          title: { tag: 'plain_text', content: 'Bio' },
          template: 'blue',
        },
        config: {
          update_multi: true,
        },
      };

      // 2. Create card entity
      const createRes = await this.client.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(cardData),
        },
      }) as any;

      const cardId: string | undefined = createRes?.data?.card_id;
      if (!cardId) {
        logger.error({ code: createRes?.code, msg: createRes?.msg, data: createRes?.data }, 'Feishu CardKit create failed — no card_id');
        return null;
      }

      // 3. Enable streaming mode
      await this.client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: true }),
          sequence: 1,
        },
      });

      // 4. Send card message to chat
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        },
      });

      logger.info({ chatId, cardId }, 'Feishu streaming card created');
      return cardId;
    } catch (err) {
      logger.error({ err, chatId }, 'Feishu createStreamingCard error');
      return null;
    }
  }

  async updateStreamingCard(cardId: string, text: string, sequence: number): Promise<void> {
    try {
      await this.client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: 'streaming_content' },
        data: {
          content: text,
          sequence,
        },
      });
    } catch (err) {
      logger.error({ err, cardId, sequence }, 'Feishu updateStreamingCard error');
    }
  }

  async finalizeStreamingCard(cardId: string, text: string, sequence: number): Promise<void> {
    try {
      // 1. Final card update with complete content
      const finalCard = {
        schema: '2.0',
        body: {
          elements: [
            {
              tag: 'markdown',
              content: text,
              element_id: 'streaming_content',
              text_size: 'normal',
            },
          ],
        },
        header: {
          title: { tag: 'plain_text', content: 'Bio' },
          template: 'blue',
        },
        config: {
          update_multi: true,
        },
      };

      await this.client.cardkit.v1.card.update({
        path: { card_id: cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(finalCard),
          },
          sequence,
        },
      });

      // 2. Disable streaming mode
      await this.client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: false }),
          sequence: sequence + 1,
        },
      });

      logger.info({ cardId }, 'Feishu streaming card finalized');
    } catch (err) {
      logger.error({ err, cardId }, 'Feishu finalizeStreamingCard error');
    }
  }
}
