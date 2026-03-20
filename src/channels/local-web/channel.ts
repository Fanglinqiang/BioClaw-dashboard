import fs from 'fs';
import http, { IncomingMessage, ServerResponse } from 'http';
import path from 'path';

import {
  ASSISTANT_NAME,
  DASHBOARD_TOKEN,
  ENABLE_DASHBOARD,
  GROUPS_DIR,
  LOCAL_WEB_GROUP_FOLDER,
  LOCAL_WEB_GROUP_JID,
  LOCAL_WEB_HOST,
  LOCAL_WEB_PORT,
  LOCAL_WEB_SECRET,
} from '../../config.js';
import { handleDashboardRoutes, initDashboardTraceBroadcast, shutdownDashboardTraceBroadcast } from '../../dashboard/server.js';
import { renderUnifiedWebPage } from './html-template.js';
import {
  getWebVendorScripts,
  WEB_VENDOR_MARKED_PATH,
  WEB_VENDOR_PURIFY_PATH,
} from './vendor-scripts.js';
import { getRecentMessages, storeChatMetadata, storeMessageDirect } from '../../db/index.js';
import { logger } from '../../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../../types.js';

interface LocalWebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

interface IncomingPayload {
  text?: string;
  sender?: string;
  senderName?: string;
  chatJid?: string;
}

const MAX_UPLOAD_BYTES = Math.max(
  1,
  parseInt(process.env.LOCAL_WEB_MAX_UPLOAD_MB || '200', 10) * 1024 * 1024,
);

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      size += buffer.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeFileName(filename: string): string {
  const basename = path.basename(filename).replace(/[^\w.\-]/g, '_');
  return basename || 'upload.bin';
}

function ensureUploadDir(): string {
  const uploadDir = path.join(GROUPS_DIR, LOCAL_WEB_GROUP_FOLDER, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  return uploadDir;
}

function buildUploadPaths(filename: string): { relativePath: string; absolutePath: string; publicPath: string } {
  const safeName = sanitizeFileName(filename);
  const storedName = `${Date.now()}-${safeName}`;
  const relativePath = path.posix.join('uploads', storedName);
  return {
    relativePath,
    absolutePath: path.join(ensureUploadDir(), storedName),
    publicPath: `/files/${relativePath}`,
  };
}

function isSafeRelativePath(relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath).replace(/^\/+/, '');
  return normalized.length > 0 && !normalized.startsWith('..');
}

function renderPage(chatJid: string, showDashboardLink: boolean): string {
  const dashQs = DASHBOARD_TOKEN ? `?token=${encodeURIComponent(DASHBOARD_TOKEN)}` : '';
  const dashboardSettingsRow = showDashboardLink
    ? `<div class="drawer-section"><a class="dash-link" id="dashLink" href="/dashboard${dashQs}"></a></div>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BioClaw · Local Lab</title>
  <style>
    :root {
      --bg: #07090d;
      --surface: #0b0e14;
      --surface-raised: #11161e;
      --border: rgba(255, 255, 255, 0.065);
      --ink: #f0f3f8;
      --muted: #7c8a9e;
      --accent: #3ecf8e;
      --accent-muted: rgba(62, 207, 142, 0.12);
      --user: #5b9cf5;
      --user-muted: rgba(91, 156, 245, 0.14);
      --warn: #e8a849;
      --radius: 12px;
      --radius-sm: 8px;
      --font: ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      --mono: ui-monospace, "SFMono-Regular", Consolas, monospace;
      --header-h: 52px;
    }
    :root[data-theme="light"] {
      --bg: #f4f6f9;
      --surface: #ffffff;
      --surface-raised: #f8fafc;
      --border: rgba(15, 23, 42, 0.1);
      --ink: #0f172a;
      --muted: #64748b;
      --accent: #059669;
      --accent-muted: rgba(5, 150, 105, 0.1);
      --user: #2563eb;
      --user-muted: rgba(37, 99, 235, 0.1);
      --warn: #d97706;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; overflow: hidden; }
    body {
      font-family: var(--font);
      color: var(--ink);
      background: var(--bg);
      background-image: radial-gradient(ellipse 120% 70% at 50% -25%, rgba(62, 207, 142, 0.055), transparent);
      -webkit-font-smoothing: antialiased;
    }
    :root[data-theme="light"] body {
      background-image: radial-gradient(ellipse 120% 70% at 50% -25%, rgba(5, 150, 105, 0.04), transparent);
    }
    .app {
      width: 100%;
      max-width: none;
      box-sizing: border-box;
      margin: 0;
      height: 100%;
      max-height: 100dvh;
      display: flex;
      flex-direction: column;
      padding: 0 clamp(14px, 2.5vw, 28px) 12px;
      overflow: hidden;
    }
    .app-header {
      flex-shrink: 0;
      z-index: 20;
      min-height: var(--header-h);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px 16px;
      flex-wrap: wrap;
      padding: 8px 0;
      margin-bottom: 2px;
      background: color-mix(in srgb, var(--bg) 92%, transparent);
      backdrop-filter: blur(12px) saturate(1.2);
      border-bottom: 1px solid var(--border);
    }
    .brand-lockup {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 0 1 auto;
    }
    .logo {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 650;
      font-size: 15px;
      letter-spacing: -0.035em;
      color: var(--ink);
      line-height: 1;
    }
    .logo-mark {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      flex-shrink: 0;
      box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 45%, transparent);
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 10px;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.02em;
      color: var(--muted);
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface);
      white-space: nowrap;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--muted);
      flex-shrink: 0;
      opacity: 0.85;
    }
    .dot.live {
      background: var(--accent);
      opacity: 1;
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
    }
    .dot.poll { background: var(--warn); opacity: 1; }
    .icon-btn {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .icon-btn:hover {
      color: var(--ink);
      border-color: color-mix(in srgb, var(--muted) 35%, var(--border));
      background: var(--surface-raised);
    }
    .icon-btn svg { width: 18px; height: 18px; stroke-width: 1.75; }
    .chat-hero {
      flex-shrink: 0;
      padding: 14px 0 6px;
    }
    .chat-hero h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.03em;
      line-height: 1.25;
    }
    .chat-hero .subtitle {
      margin: 6px 0 0;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.5;
      max-width: 44ch;
    }
    .messages {
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 12px 0 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      -webkit-overflow-scrolling: touch;
    }
    .bubble {
      max-width: min(92%, min(720px, 100%));
      border-radius: var(--radius-sm);
      padding: 11px 14px;
      border: 1px solid var(--border);
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.06);
      animation: rise 0.22s ease-out;
    }
    :root[data-theme="light"] .bubble { box-shadow: 0 1px 8px rgba(15, 23, 42, 0.06); }
    .bubble.user {
      align-self: flex-end;
      background: var(--user-muted);
      border-color: color-mix(in srgb, var(--user) 35%, var(--border));
    }
    .bubble.bot {
      align-self: flex-start;
      background: var(--accent-muted);
      border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
    }
    .meta {
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 6px;
      background: var(--surface);
      border: 1px solid var(--border);
    }
    .content {
      font-size: 14px;
      line-height: 1.55;
      white-space: normal;
      word-break: break-word;
      overflow-x: auto;
      max-width: 100%;
    }
    .content a { color: var(--accent); }
    .content p { margin: 0 0 0.65em; }
    .content p:last-child { margin-bottom: 0; }
    .content pre {
      margin: 0.5em 0;
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      background: var(--bg);
      border: 1px solid var(--border);
      overflow-x: auto;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.45;
    }
    .content code {
      font-family: var(--mono);
      font-size: 0.9em;
      padding: 0.12em 0.35em;
      border-radius: 4px;
      background: var(--surface-raised);
      border: 1px solid var(--border);
    }
    .content pre code { padding: 0; border: none; background: transparent; font-size: inherit; }
    .content ul, .content ol { margin: 0.35em 0 0.65em; padding-left: 1.25em; }
    .content li { margin: 0.22em 0; }
    .content blockquote {
      margin: 0.5em 0;
      padding-left: 12px;
      border-left: 3px solid var(--border);
      color: var(--muted);
    }
    .content h1, .content h2, .content h3, .content h4 {
      margin: 0.65em 0 0.35em;
      font-size: 1.05em;
      font-weight: 650;
      line-height: 1.3;
    }
    .content h1:first-child, .content h2:first-child, .content h3:first-child, .content h4:first-child {
      margin-top: 0;
    }
    .content table { border-collapse: collapse; margin: 0.5em 0; font-size: 13px; width: 100%; }
    .content th, .content td {
      border: 1px solid var(--border);
      padding: 6px 10px;
      text-align: left;
      vertical-align: top;
    }
    .content th { background: var(--surface-raised); font-weight: 600; }
    .content hr { border: none; border-top: 1px solid var(--border); margin: 0.75em 0; }
    .content img { max-width: 100%; height: auto; border-radius: var(--radius-sm); }
    .composer-card {
      flex-shrink: 0;
      margin-top: 0;
      padding: 14px 0 0;
      border-radius: 0;
      border: none;
      border-top: 1px solid var(--border);
      background: transparent;
      box-shadow: none;
    }
    :root[data-theme="light"] .composer-card { box-shadow: none; }
    textarea {
      width: 100%;
      min-height: 96px;
      max-height: min(280px, 38vh);
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      font: inherit;
      background: var(--bg);
      color: var(--ink);
    }
    textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-muted);
    }
    .row {
      display: flex;
      gap: 12px;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .hint { color: var(--muted); font-size: 12px; max-width: 46ch; line-height: 1.45; }
    .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .upload {
      position: relative;
      overflow: hidden;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: var(--radius-sm);
      padding: 9px 13px;
      border: 1px solid var(--border);
      background: var(--surface-raised);
      cursor: pointer;
      font-size: 13px;
    }
    .upload input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .filename { color: var(--muted); font-size: 12px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { min-height: 18px; color: var(--muted); font-size: 12px; margin-top: 8px; }
    button.primary {
      border: 0;
      border-radius: var(--radius-sm);
      padding: 10px 20px;
      font: inherit;
      font-weight: 600;
      background: linear-gradient(135deg, var(--accent), #2a9d6a);
      color: #04120c;
      cursor: pointer;
    }
    button.primary:disabled { opacity: 0.5; cursor: wait; }
    .file-card {
      display: grid;
      gap: 10px;
      padding: 14px;
      border-radius: var(--radius-sm);
      background: var(--surface-raised);
      border: 1px solid var(--border);
    }
    .file-title { font-weight: 600; font-size: 14px; }
    .file-path { font-family: var(--mono); font-size: 12px; color: var(--muted); word-break: break-all; }
    .file-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .file-button {
      display: inline-flex;
      align-items: center;
      min-height: 36px;
      padding: 0 14px;
      border-radius: var(--radius-sm);
      text-decoration: none;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--ink);
      font-size: 13px;
    }
    .preview {
      max-width: min(100%, 400px);
      max-height: 220px;
      border-radius: var(--radius-sm);
      object-fit: cover;
      border: 1px solid var(--border);
    }
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      z-index: 100;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.2s, visibility 0.2s;
    }
    .drawer-backdrop.is-open { opacity: 1; visibility: visible; }
    .drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: min(100%, 380px);
      height: 100%;
      z-index: 101;
      background: var(--surface);
      border-left: 1px solid var(--border);
      box-shadow: -16px 0 48px rgba(0, 0, 0, 0.35);
      transform: translateX(100%);
      transition: transform 0.25s ease;
      display: flex;
      flex-direction: column;
    }
    .drawer.is-open { transform: translateX(0); }
    .drawer-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 20px;
      border-bottom: 1px solid var(--border);
    }
    .drawer-head h2 { margin: 0; font-size: 17px; font-weight: 650; }
    .drawer-body { padding: 16px 20px 24px; overflow-y: auto; flex: 1; }
    .drawer-section { margin-bottom: 22px; }
    .drawer-section h3 {
      margin: 0 0 10px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }
    .setting-row:last-of-type { border-bottom: 0; }
    .setting-label { font-size: 14px; color: var(--ink); }
    .setting-value { font-size: 13px; color: var(--muted); }
    .btn-setting {
      border: 1px solid var(--border);
      background: var(--surface-raised);
      color: var(--ink);
      border-radius: var(--radius-sm);
      padding: 8px 14px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .btn-setting:hover { border-color: var(--accent); color: var(--accent); }
    .jid-box {
      display: block;
      margin-top: 8px;
      padding: 10px 12px;
      font-family: var(--mono);
      font-size: 11px;
      word-break: break-all;
      color: var(--muted);
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
    }
    .dash-link {
      display: block;
      text-align: center;
      padding: 12px 16px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--surface-raised);
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
    }
    .dash-link:hover { border-color: var(--accent); }
    @keyframes rise {
      from { transform: translateY(8px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="app-header">
      <div class="brand-lockup">
        <span class="logo"><span class="logo-mark" aria-hidden="true"></span>BioClaw</span>
      </div>
      <div class="header-actions">
        <div class="pill" id="connPill" title="">
          <span class="dot" id="connDot"></span>
          <span id="connLabel"></span>
        </div>
        <button type="button" class="icon-btn" id="openSettings" aria-label="Settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
            <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
            <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>
          </svg>
        </button>
      </div>
    </header>
    <div class="chat-hero">
      <h1 id="chatTitle"></h1>
      <p class="subtitle" id="chatHint"></p>
    </div>
    <section id="messages" class="messages" aria-live="polite"></section>
    <div class="composer-card">
      <form id="composer">
        <textarea id="text" rows="4"></textarea>
        <div class="row">
          <div class="hint" id="uploadHint"></div>
          <div class="toolbar">
            <label class="upload">
              <span id="uploadLabel"></span>
              <input id="file" type="file">
            </label>
            <span id="filename" class="filename"></span>
            <button class="primary" id="send" type="submit"></button>
          </div>
        </div>
        <div id="status" class="status"></div>
      </form>
    </div>
  </div>
  <div class="drawer-backdrop" id="settingsBackdrop" aria-hidden="true"></div>
  <aside class="drawer" id="settingsDrawer" aria-hidden="true" aria-labelledby="settingsHeading">
    <div class="drawer-head">
      <h2 id="settingsHeading"></h2>
      <button type="button" class="icon-btn" id="closeSettings" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="drawer-body">
      <div class="drawer-section">
        <h3 id="secDisplay"></h3>
        <div class="setting-row">
          <span class="setting-label" id="lblLang"></span>
          <button type="button" class="btn-setting" id="langBtn"></button>
        </div>
        <div class="setting-row">
          <span class="setting-label" id="lblTheme"></span>
          <button type="button" class="btn-setting" id="themeBtn"></button>
        </div>
      </div>
      <div class="drawer-section">
        <h3 id="secConnection"></h3>
        <div class="setting-row">
          <span class="setting-label" id="lblConn"></span>
          <span class="setting-value" id="settingsConnValue"></span>
        </div>
        <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <span class="setting-label" id="lblSession"></span>
          <code class="jid-box">${escapeHtml(chatJid)}</code>
        </div>
      </div>
      ${dashboardSettingsRow}
    </div>
  </aside>
  <script src="${WEB_VENDOR_MARKED_PATH}"></script>
  <script src="${WEB_VENDOR_PURIFY_PATH}"></script>
  <script>
    const chatJid = ${JSON.stringify(chatJid)};
    const assistantName = ${JSON.stringify(ASSISTANT_NAME)};
    const LANG_KEY = 'bioclaw-local-web-lang';
    const messagesEl = document.getElementById('messages');
    const form = document.getElementById('composer');
    const input = document.getElementById('text');
    const fileInput = document.getElementById('file');
    const fileNameEl = document.getElementById('filename');
    const sendBtn = document.getElementById('send');
    const statusEl = document.getElementById('status');
    const connDot = document.getElementById('connDot');
    const connLabel = document.getElementById('connLabel');
    const connPill = document.getElementById('connPill');
    const themeBtn = document.getElementById('themeBtn');
    const langBtn = document.getElementById('langBtn');
    const settingsBackdrop = document.getElementById('settingsBackdrop');
    const settingsDrawer = document.getElementById('settingsDrawer');
    const openSettingsBtn = document.getElementById('openSettings');
    const closeSettingsBtn = document.getElementById('closeSettings');
    const settingsConnValue = document.getElementById('settingsConnValue');
    let lastSignature = '';
    let pollTimer = null;
    let es = null;
    /** null = UI not yet connected (show "connecting" copy) */
    let lastConnMode = null;
    var lang = 'zh';

    var I18N = {
      zh: {
        pageTitle: 'BioClaw · 本地实验室',
        connPillTitle: '新消息',
        connConnecting: '连接中…',
        settingsTitle: '设置',
        settingsAria: '打开设置',
        closeSettingsAria: '关闭',
        secDisplay: '显示',
        secConnection: '连接',
        lblLang: '界面语言',
        lblTheme: '外观',
        lblConn: '对话列表',
        lblSession: '会话 ID',
        langToggle: 'English',
        themeToggle: '切换浅色 / 深色',
        chatTitle: '对话',
        chatHintTpl: 'Enter 发送 · Shift+Enter 换行 · 默认无需 @{name}',
        placeholder: '例如：用 BioPython 读取 FASTA 并统计 GC 含量…',
        uploadHint: '上传文件会写入群组工作区，Agent 可通过路径访问。',
        uploadLabel: '上传文件',
        noFile: '未选择',
        send: '发送',
        sseLive: '实时更新',
        poll2s: '约 2 秒刷新',
        offline: '离线',
        roleAssistant: '助手',
        roleYou: '你',
        userFallback: '用户',
        uploadedPrefix: '已上传 · ',
        openFile: '打开',
        download: '下载',
        uploading: '正在上传…',
        uploadFail: '上传失败',
        sendFail: '发送失败',
        dashLink: '打开实验追踪',
      },
      en: {
        pageTitle: 'BioClaw · Local Lab',
        connPillTitle: 'Messages',
        connConnecting: 'Connecting…',
        settingsTitle: 'Settings',
        settingsAria: 'Open settings',
        closeSettingsAria: 'Close',
        secDisplay: 'Display',
        secConnection: 'Connection',
        lblLang: 'Language',
        lblTheme: 'Appearance',
        lblConn: 'Chat list',
        lblSession: 'Session ID',
        langToggle: '中文',
        themeToggle: 'Light / dark theme',
        chatTitle: 'Chat',
        chatHintTpl: 'Enter to send · Shift+Enter for newline · @{name} optional by default',
        placeholder: 'e.g. Read a FASTA with BioPython and report GC content…',
        uploadHint: 'Uploads go to the group workspace; the agent can read them by path.',
        uploadLabel: 'Upload file',
        noFile: 'No file chosen',
        send: 'Send',
        sseLive: 'Live',
        poll2s: '~2s refresh',
        offline: 'Offline',
        roleAssistant: 'Assistant',
        roleYou: 'You',
        userFallback: 'User',
        uploadedPrefix: 'Uploaded · ',
        openFile: 'Open',
        download: 'Download',
        uploading: 'Uploading…',
        uploadFail: 'Upload failed',
        sendFail: 'Send failed',
        dashLink: 'Open lab trace',
      },
    };

    function T() {
      return I18N[lang];
    }

    function applyLang(next) {
      lang = next === 'en' ? 'en' : 'zh';
      try {
        localStorage.setItem(LANG_KEY, lang);
      } catch (e) { /* ignore */ }
      const t = T();
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      document.title = t.pageTitle;
      connPill.title = t.connPillTitle;
      document.getElementById('settingsHeading').textContent = t.settingsTitle;
      openSettingsBtn.setAttribute('aria-label', t.settingsAria);
      closeSettingsBtn.setAttribute('aria-label', t.closeSettingsAria);
      document.getElementById('secDisplay').textContent = t.secDisplay;
      document.getElementById('secConnection').textContent = t.secConnection;
      document.getElementById('lblLang').textContent = t.lblLang;
      document.getElementById('lblTheme').textContent = t.lblTheme;
      document.getElementById('lblConn').textContent = t.lblConn;
      document.getElementById('lblSession').textContent = t.lblSession;
      langBtn.textContent = t.langToggle;
      langBtn.title = lang === 'zh' ? 'Switch to English' : '切换到中文';
      themeBtn.textContent = t.themeToggle;
      document.getElementById('chatTitle').textContent = t.chatTitle;
      document.getElementById('chatHint').textContent = t.chatHintTpl.replace('{name}', assistantName);
      input.placeholder = t.placeholder;
      document.getElementById('uploadHint').textContent = t.uploadHint;
      document.getElementById('uploadLabel').textContent = t.uploadLabel;
      sendBtn.textContent = t.send;
      var dash = document.getElementById('dashLink');
      if (dash) dash.textContent = t.dashLink;
      var hasFile = fileInput.files && fileInput.files[0];
      fileNameEl.textContent = hasFile ? fileInput.files[0].name : t.noFile;
      if (lastConnMode === null) {
        connDot.classList.remove('live', 'poll');
        connLabel.textContent = t.connConnecting;
        settingsConnValue.textContent = t.connConnecting;
      } else {
        setConn(lastConnMode);
      }
    }

    (function initLang() {
      var saved = null;
      try {
        saved = localStorage.getItem(LANG_KEY);
      } catch (e) { /* ignore */ }
      applyLang(saved === 'en' ? 'en' : 'zh');
    })();

    langBtn.addEventListener('click', function () {
      applyLang(lang === 'zh' ? 'en' : 'zh');
      lastSignature = '';
      refresh();
    });

    function setConn(mode) {
      lastConnMode = mode;
      const t = T();
      connDot.classList.remove('live', 'poll');
      var label = t.offline;
      if (mode === 'sse') {
        connDot.classList.add('live');
        label = t.sseLive;
      } else if (mode === 'poll') {
        connDot.classList.add('poll');
        label = t.poll2s;
      }
      connLabel.textContent = label;
      settingsConnValue.textContent = label;
    }

    function loadTheme() {
      const t = localStorage.getItem('bioclaw-theme');
      if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
      else document.documentElement.removeAttribute('data-theme');
    }
    loadTheme();
    themeBtn.addEventListener('click', () => {
      if (document.documentElement.getAttribute('data-theme') === 'light') {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('bioclaw-theme', 'dark');
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('bioclaw-theme', 'light');
      }
    });

    function setSettingsOpen(open) {
      settingsBackdrop.classList.toggle('is-open', open);
      settingsDrawer.classList.toggle('is-open', open);
      settingsBackdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
      settingsDrawer.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) closeSettingsBtn.focus();
    }
    openSettingsBtn.addEventListener('click', function () {
      setSettingsOpen(true);
    });
    closeSettingsBtn.addEventListener('click', function () {
      setSettingsOpen(false);
    });
    settingsBackdrop.addEventListener('click', function () {
      setSettingsOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && settingsDrawer.classList.contains('is-open')) {
        setSettingsOpen(false);
      }
    });

    function render(messages) {
      const signature = JSON.stringify(messages.map(m => [m.id, m.timestamp, m.content]));
      if (signature === lastSignature) return;
      lastSignature = signature;
      const t = T();
      messagesEl.innerHTML = messages.map((msg) => {
        const kind = msg.is_from_me ? 'bot' : 'user';
        const name = msg.is_from_me ? assistantName : (msg.sender_name || t.userFallback);
        const role = msg.is_from_me ? t.roleAssistant : t.roleYou;
        return '<article class="bubble ' + kind + '">' +
          '<div class="meta"><span class="badge">' + escapeHtml(role) + '</span>' +
          escapeHtml(name) + ' · ' + escapeHtml(msg.timestamp) + '</div>' +
          '<div class="content">' + renderBody(msg.content) + '</div>' +
        '</article>';
      }).join('');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderBody(text) {
      const upload = parseUploadMessage(text);
      if (upload) return renderUploadCard(upload);
      return markdownToSafeHtml(String(text));
    }

    function parseUploadMessage(text) {
      const lines = String(text).split('\\n');
      const fileLine = lines.find((line) => line.startsWith('Uploaded file: '));
      const workspaceLine = lines.find((line) => line.startsWith('Workspace path: '));
      const previewLine = lines.find((line) => line.startsWith('Preview URL: '));
      if (!fileLine || !workspaceLine || !previewLine) return null;
      return {
        filename: fileLine.slice('Uploaded file: '.length),
        workspacePath: workspaceLine.slice('Workspace path: '.length),
        previewUrl: previewLine.slice('Preview URL: '.length),
      };
    }

    function renderUploadCard(file) {
      const t = T();
      const escapedName = escapeHtml(file.filename);
      const escapedPath = escapeHtml(file.workspacePath);
      const escapedPreview = escapeHtml(file.previewUrl);
      const isImage = /\\.(png|jpe?g|gif|webp|svg)$/i.test(file.filename);
      const preview = isImage
        ? '<img class="preview" src="' + escapedPreview + '" alt="' + escapedName + '">'
        : '';
      return [
        '<section class="file-card">',
        '<div class="file-title">' + escapeHtml(t.uploadedPrefix) + escapedName + '</div>',
        '<div class="file-path">' + escapedPath + '</div>',
        preview,
        '<div class="file-actions">',
        '<a class="file-button" href="' + escapedPreview + '" target="_blank" rel="noreferrer">' + escapeHtml(t.openFile) + '</a>',
        '<a class="file-button" href="' + escapedPreview + '" download>' + escapeHtml(t.download) + '</a>',
        '</div>',
        '</section>',
      ].join('');
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    (function setupMarkdownSanitize() {
      if (typeof DOMPurify !== 'undefined' && !globalThis.__bioclawDpHook) {
        globalThis.__bioclawDpHook = true;
        DOMPurify.addHook('afterSanitizeAttributes', function (node) {
          if (node.tagName === 'A' && node.hasAttribute('href')) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noreferrer noopener');
          }
        });
      }
    })();

    function linkifyBareFilePaths(t) {
      return String(t).replace(/(^|\s|[>\u00a0])(\/files\/[\w./%-]+)/g, function (_, sep, p) {
        return sep + '[' + p + '](' + p + ')';
      });
    }

    function markdownToSafeHtml(raw) {
      if (typeof marked === 'undefined' || typeof marked.parse !== 'function' || typeof DOMPurify === 'undefined') {
        return escapeHtml(raw)
          .replace(/(\/files\/[\w./%-]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
          .replace(/\n/g, '<br>');
      }
      try {
        if (typeof marked.setOptions === 'function') marked.setOptions({ gfm: true, breaks: true });
        const linked = linkifyBareFilePaths(raw);
        const html = marked.parse(linked, { async: false });
        return DOMPurify.sanitize(html, {
          ALLOWED_TAGS: [
            'p', 'br', 'strong', 'em', 'b', 'i', 'code', 'pre', 'ul', 'ol', 'li',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'a', 'hr', 'del', 'ins',
            'sub', 'sup', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
          ],
          ALLOWED_ATTR: ['href', 'title', 'class', 'colspan', 'rowspan', 'align', 'src', 'alt', 'width', 'height', 'loading'],
          ALLOW_DATA_ATTR: false,
        });
      } catch (e2) {
        return escapeHtml(raw).replace(/\n/g, '<br>');
      }
    }

    function setStatus(text) { statusEl.textContent = text || ''; }

    async function refresh() {
      try {
        const res = await fetch('/api/messages?chatJid=' + encodeURIComponent(chatJid));
        if (!res.ok) return;
        const data = await res.json();
        render(data.messages || []);
      } catch (e) { /* ignore */ }
    }

    function startPolling() {
      if (pollTimer) return;
      setConn('poll');
      pollTimer = setInterval(refresh, 2000);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function connectSse() {
      try {
        es = new EventSource('/api/events?chatJid=' + encodeURIComponent(chatJid));
        es.onopen = function () {
          setConn('sse');
          stopPolling();
        };
        es.onmessage = function () {
          refresh();
        };
        es.onerror = function () {
          if (es) { es.close(); es = null; }
          setConn('poll');
          startPolling();
        };
      } catch (e) {
        startPolling();
      }
    }

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileNameEl.textContent = file ? file.name : T().noFile;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    async function uploadSelectedFile() {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return null;
      setStatus(T().uploading);
      const res = await fetch('/api/upload?chatJid=' + encodeURIComponent(chatJid), {
        method: 'POST',
        headers: {
          'x-file-name': encodeURIComponent(file.name),
          'content-type': file.type || 'application/octet-stream'
        },
        body: file
      });
      if (!res.ok) throw new Error('UPLOAD_FAIL');
      const data = await res.json();
      fileInput.value = '';
      fileNameEl.textContent = T().noFile;
      return data;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      const file = fileInput.files && fileInput.files[0];
      if (!text && !file) return;
      sendBtn.disabled = true;
      try {
        if (file) await uploadSelectedFile();
        if (text) {
          const res = await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatJid, text })
          });
          if (!res.ok) throw new Error('SEND_FAIL');
          input.value = '';
        }
        setStatus('');
        await refresh();
      } catch (e) {
        const msg = e && e.message;
        if (msg === 'UPLOAD_FAIL') setStatus(T().uploadFail);
        else if (msg === 'SEND_FAIL') setStatus(T().sendFail);
        else setStatus(String(msg || ''));
      } finally {
        sendBtn.disabled = false;
      }
    });

    refresh();
    connectSse();
  </script>
</body>
</html>`;
}

export class LocalWebChannel implements Channel {
  name = 'local-web';
  prefixAssistantName = true;

  private server?: http.Server;
  private connected = false;
  private opts: LocalWebChannelOpts;
  /** SSE subscribers for instant UI refresh */
  private readonly sseClients = new Set<ServerResponse>();

  constructor(opts: LocalWebChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        logger.error({ err }, 'Local web request failed');
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(LOCAL_WEB_PORT, LOCAL_WEB_HOST, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });

    this.connected = true;
    if (ENABLE_DASHBOARD) {
      initDashboardTraceBroadcast();
      logger.info(
        { paths: ['/', '/api/trace/*', '/api/workspace/*'] },
        'Unified web UI (chat + trace) on local web port; /dashboard redirects to /?tab=trace',
      );
    }
    logger.info(
      { host: LOCAL_WEB_HOST, port: LOCAL_WEB_PORT, jid: LOCAL_WEB_GROUP_JID },
      'Local web channel listening',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@local.web');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (ENABLE_DASHBOARD) {
      shutdownDashboardTraceBroadcast();
    }
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = undefined;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const now = new Date().toISOString();
    storeChatMetadata(jid, now, jid);
    storeMessageDirect({
      id: `local-web-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: jid,
      sender: 'bioclaw@local.web',
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp: now,
      is_from_me: true,
    });
    this.notifySse(jid);
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    const filename = path.basename(imagePath);
    // Copy image to group dir so it can be served via /files/
    const imagesDir = path.join(GROUPS_DIR, LOCAL_WEB_GROUP_FOLDER, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const destPath = path.join(imagesDir, `${Date.now()}-${filename}`);
    fs.copyFileSync(imagePath, destPath);
    const webPath = `/files/images/${path.basename(destPath)}`;
    const content = caption
      ? `${caption}\n\n![${caption}](${webPath})`
      : `![image](${webPath})`;
    await this.sendMessage(jid, content);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (ENABLE_DASHBOARD) {
      const handled = await handleDashboardRoutes(req, res, url, 'merged');
      if (handled) return;
    }

    if (req.method === 'GET' && url.pathname === WEB_VENDOR_MARKED_PATH) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(getWebVendorScripts().marked);
      return;
    }
    if (req.method === 'GET' && url.pathname === WEB_VENDOR_PURIFY_PATH) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(getWebVendorScripts().purify);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        ENABLE_DASHBOARD
          ? renderUnifiedWebPage(LOCAL_WEB_GROUP_JID, ASSISTANT_NAME)
          : renderPage(LOCAL_WEB_GROUP_JID, false),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const chatJid = url.searchParams.get('chatJid') || LOCAL_WEB_GROUP_JID;
      this.wireSse(res, chatJid);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const chatJid = url.searchParams.get('chatJid') || LOCAL_WEB_GROUP_JID;
      sendJson(res, 200, { messages: getRecentMessages(chatJid, 100) });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const relativePath = url.pathname.slice('/files/'.length);
      if (!isSafeRelativePath(relativePath)) {
        sendJson(res, 400, { error: 'Invalid file path' });
        return;
      }
      const absolutePath = path.join(GROUPS_DIR, LOCAL_WEB_GROUP_FOLDER, relativePath);
      if (!absolutePath.startsWith(path.join(GROUPS_DIR, LOCAL_WEB_GROUP_FOLDER))) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }
      if (!fs.existsSync(absolutePath)) {
        sendJson(res, 404, { error: 'File not found' });
        return;
      }
      const ext = path.extname(absolutePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
      };
      res.statusCode = 200;
      res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      res.end(fs.readFileSync(absolutePath));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/messages') {
      const body = (await readBody(req)).toString('utf-8');
      const payload = JSON.parse(body || '{}') as IncomingPayload;
      await this.acceptInbound(payload.chatJid || LOCAL_WEB_GROUP_JID, payload.text || '', 'web-user@local.web', 'Web User');
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const chatJid = url.searchParams.get('chatJid') || LOCAL_WEB_GROUP_JID;
      const fileNameHeader = req.headers['x-file-name'];
      const originalName = typeof fileNameHeader === 'string'
        ? decodeURIComponent(fileNameHeader)
        : 'upload.bin';
      const body = await readBody(req, MAX_UPLOAD_BYTES);
      if (body.length === 0) {
        sendJson(res, 400, { error: 'Empty file upload' });
        return;
      }
      const paths = buildUploadPaths(originalName);
      fs.writeFileSync(paths.absolutePath, body);
      await this.acceptInbound(
        chatJid,
        [
          `Uploaded file: ${originalName}`,
          `Workspace path: ${paths.relativePath}`,
          `Preview URL: ${paths.publicPath}`,
        ].join('\n'),
        'web-user@local.web',
        'Web User',
      );
      sendJson(res, 200, {
        ok: true,
        filename: originalName,
        workspacePath: paths.relativePath,
        publicPath: paths.publicPath,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
      if (LOCAL_WEB_SECRET) {
        const supplied = req.headers['x-bioclaw-secret'];
        if (supplied !== LOCAL_WEB_SECRET) {
          sendJson(res, 403, { error: 'Forbidden' });
          return;
        }
      }
      const body = (await readBody(req)).toString('utf-8');
      const payload = JSON.parse(body || '{}') as IncomingPayload;
      await this.acceptInbound(
        payload.chatJid || LOCAL_WEB_GROUP_JID,
        payload.text || '',
        payload.sender || 'webhook-user@local.web',
        payload.senderName || 'Webhook User',
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  private async acceptInbound(
    chatJid: string,
    text: string,
    sender: string,
    senderName: string,
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const now = new Date().toISOString();
    this.opts.onChatMetadata(chatJid, now, 'Local Web Chat');
    this.opts.onMessage(chatJid, {
      id: `local-web-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: trimmed,
      timestamp: now,
      is_from_me: false,
    });
    this.notifySse(chatJid);
  }

  private wireSse(res: ServerResponse, chatJid: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello', chatJid })}\n\n`);

    this.sseClients.add(res);
    const hb = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(hb);
      }
    }, 25_000);
    res.on('close', () => {
      clearInterval(hb);
      this.sseClients.delete(res);
    });
  }

  private notifySse(chatJid: string): void {
    const line = `data: ${JSON.stringify({ type: 'messages', chatJid })}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(line);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}
