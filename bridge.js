/**
 * QQ-Claude Bridge - 通过 QQ 远程操控 Claude Code
 *
 * 架构:
 *   手机QQ → NapCatQQ (反向WS) → bridge.js → claude -p (headless)
 *
 * 依赖 OneBot v11 协议，双向 WebSocket 通信
 */

'use strict';

const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');

// ── 配置加载 ──────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.yaml');

const DEFAULT_CONFIG = {
  bridge: { host: '127.0.0.1', port: 8080 },
  security: {
    allowed_users: [],
    rate_limit: { max_requests: 30, window_seconds: 60 },
  },
  claude: {
    binary: 'claude',           // claude 可执行文件路径，后台进程需用绝对路径
    max_turns: 10,
    max_budget_usd: 0.50,
    timeout_seconds: 120,
    allowed_tools: ['Read', 'Write', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  },
  features: {
    streaming_reply: true,
    session_timeout_minutes: 30,
  },
};

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const userConfig = yaml.load(raw) || {};
    return deepMerge(DEFAULT_CONFIG, userConfig);
  }
  return DEFAULT_CONFIG;
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])) {
      result[key] = deepMerge(base[key] || {}, override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

const config = loadConfig();

// ── 速率限制器 ────────────────────────────────────────────

class RateLimiter {
  constructor(maxRequests, windowSeconds) {
    this.maxRequests = maxRequests;
    this.windowSeconds = windowSeconds;
    this.requests = new Map();
  }

  allow(userId) {
    const now = Date.now();
    const windowStart = now - this.windowSeconds * 1000;
    if (!this.requests.has(userId)) {
      this.requests.set(userId, []);
    }
    const timestamps = this.requests.get(userId).filter(t => t > windowStart);
    if (timestamps.length >= this.maxRequests) {
      this.requests.set(userId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.requests.set(userId, timestamps);
    return true;
  }
}

// ── 会话管理 ──────────────────────────────────────────────

class SessionManager {
  constructor(timeoutMinutes = 30) {
    this.timeout = timeoutMinutes * 60 * 1000;
    this.sessions = new Map();
  }

  get(userId) {
    const entry = this.sessions.get(userId);
    if (entry) {
      if (Date.now() - entry.lastActive < this.timeout) {
        entry.lastActive = Date.now();
        return entry.sessionId;
      }
      this.sessions.delete(userId);
    }
    return null;
  }

  set(userId, sessionId) {
    this.sessions.set(userId, { sessionId, lastActive: Date.now() });
  }

  clear(userId) {
    this.sessions.delete(userId);
  }
}

// ── 统计 ──────────────────────────────────────────────────

const stats = {
  startTime: new Date().toISOString(),
  totalRequests: 0,
  start: Date.now(),
};

// ── OneBot v11 消息发送 (通过 WebSocket 双向通信) ────────

// 活跃的 NapCat WebSocket 连接（用于发送消息回去）
let activeConnections = [];

function addConnection(ws) {
  activeConnections.push(ws);
}

function removeConnection(ws) {
  activeConnections = activeConnections.filter(c => c !== ws);
}

let echoCounter = 0;

function sendOneBotAction(ws, action, params) {
  return new Promise((resolve, reject) => {
    const echo = String(++echoCounter);
    const payload = JSON.stringify({ action, params, echo });

    // 设置超时
    const timeout = setTimeout(() => {
      reject(new Error('action timeout'));
    }, 15000);

    // 等待响应
    const onMessage = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.echo === echo) {
          clearTimeout(timeout);
          ws.removeListener('message', onMessage);
          resolve(msg);
        }
      } catch { /* 不是 JSON，忽略 */ }
    };

    ws.on('message', onMessage);
    ws.send(payload);
  });
}

async function sendMessage(ws, type, targetId, message) {
  try {
    const action = type === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = type === 'private'
      ? { user_id: targetId, message }
      : { group_id: targetId, message };
    await sendOneBotAction(ws, action, params);
    return true;
  } catch (e) {
    console.error(`[发送失败] ${e.message}`);
    return false;
  }
}

// ── 截图功能 ──────────────────────────────────────────────

function takeScreenshot() {
  return new Promise((resolve) => {
    const imgDir = path.join(__dirname, 'images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir);
    const filename = `screen_${Date.now()}.png`;
    const filepath = path.join(imgDir, filename);

    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$w = $screen.Bounds.Width; $h = $screen.Bounds.Height
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Bounds.X, $screen.Bounds.Y, 0, 0, $bmp.Size)
$bmp.Save('${filepath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output '${filepath.replace(/\\/g, '\\\\')}'
`;

    const proc = spawn('powershell', ['-NoProfile', '-Command', psScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      windowsHide: true,
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', c => stdout += c);
    proc.stderr.on('data', c => stderr += c);

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(filepath)) {
        resolve({ success: true, path: filepath, size: fs.statSync(filepath).size });
      } else {
        resolve({ success: false, error: stderr || '截图失败' });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

async function sendImage(ws, type, targetId, imagePath, caption) {
  try {
    const action = type === 'private' ? 'send_private_msg' : 'send_group_msg';
    const msg = caption ? `${caption}\n[CQ:image,file=file:///${imagePath.replace(/\\/g, '/')}]` : `[CQ:image,file=file:///${imagePath.replace(/\\/g, '/')}]`;
    const params = type === 'private'
      ? { user_id: targetId, message: msg }
      : { group_id: targetId, message: msg };
    await sendOneBotAction(ws, action, params);
    return true;
  } catch (e) {
    console.error(`[截图发送失败] ${e.message}`);
    return false;
  }
}

// ── Claude Code 调用 ──────────────────────────────────────

const CLAUDE_BIN = config.claude.binary || 'claude';

function callClaude(prompt, sessionId) {
  return new Promise((resolve) => {
    const claudeConfig = config.claude;
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--max-turns', String(claudeConfig.max_turns),
    ];

    if (claudeConfig.max_budget_usd) {
      args.push('--max-budget-usd', String(claudeConfig.max_budget_usd));
    }
    if (claudeConfig.allowed_tools?.length) {
      args.push('--allowedTools', claudeConfig.allowed_tools.join(','));
    }
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    console.log(`[Claude] 调用: ${CLAUDE_BIN} ${args.slice(0, 3).join(' ')} ...`);

    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: claudeConfig.timeout_seconds * 1000,
      env: { ...process.env },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('error', (err) => {
      resolve({ result: '', session_id: sessionId || '', error: `无法启动 claude: ${err.message}` });
    });

    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          const data = JSON.parse(stdout);
          resolve({
            result: data.result || '',
            session_id: data.session_id || '',
            cost_usd: data.cost_usd || 0,
            num_turns: data.num_turns || 0,
            error: null,
          });
        } catch {
          resolve({ result: stdout.slice(0, 500) || '(空)', session_id: sessionId || '', error: 'JSON 解析失败' });
        }
      } else {
        resolve({ result: '', session_id: sessionId || '', error: stderr || `退出码: ${code}` });
      }
    });
  });
}

// ── 消息处理 ──────────────────────────────────────────────

function formatResponse(text, cost = 0, numTurns = 0) {
  let footer = '';
  if (cost > 0) {
    footer = `\n━━━━━━\n💰 $${cost.toFixed(4)} | 🔄 ${numTurns}轮`;
  }
  return text + footer;
}

function splitLongMessage(text, maxLen = 3500) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);

  return chunks.length > 1
    ? chunks.map((c, i) => `[${i + 1}/${chunks.length}]\n${c}`)
    : chunks;
}

class MessageHandler {
  constructor() {
    const sec = config.security;
    const feat = config.features;

    this.allowedUsers = new Set(sec.allowed_users || []);
    this.rateLimiter = new RateLimiter(
      sec.rate_limit.max_requests,
      sec.rate_limit.window_seconds
    );
    this.sessions = new SessionManager(feat.session_timeout_minutes);
    this.seenMessages = new Set();    // 去重：已处理的消息 ID
    this.recentHashes = new Set();     // 去重：最近消息内容哈希
    this.lastCleanup = Date.now();     // 上次清理时间
  }

  isAllowed(userId) {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }

  _isDuplicate(messageId) {
    // 定期清理旧 ID（每 5 分钟）
    if (Date.now() - this.lastCleanup > 300000) {
      this.seenMessages.clear();
      this.lastCleanup = Date.now();
    }
    if (this.seenMessages.has(messageId)) {
      return true;
    }
    this.seenMessages.add(messageId);
    return false;
  }

  // ws: 当前 NapCat 连接，用于回复消息
  async handleMessage(event, ws) {
    if (event.post_type !== 'message') return;

    // 去重：NapCat 多连接导致同一消息到达两次
    const messageId = event.message_id;
    const contentHash = `${event.user_id}:${(event.raw_message || '').trim()}`;
    if ((messageId && this._isDuplicate(messageId)) || this.recentHashes.has(contentHash)) {
      return;
    }
    this.recentHashes.add(contentHash);
    // 5秒后自动清除，防止相同内容的新消息被误判重复
    setTimeout(() => this.recentHashes.delete(contentHash), 5000);

    const messageType = event.message_type;
    const userId = event.user_id || 0;
    const rawMessage = (event.raw_message || '').trim();
    const groupId = event.group_id || 0;
    const targetType = messageType;
    const targetId = messageType === 'private' ? userId : groupId;

    // ── 检测并下载图片 ──────────────────────────
    let imagePaths = [];
    const messageArray = event.message || [];
    const imageUrls = [];
    for (const seg of messageArray) {
      if (seg.type === 'image' && seg.data?.url) {
        imageUrls.push(seg.data.url);
      }
    }

    if (imageUrls.length > 0) {
      const imgDir = path.join(__dirname, 'images');
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir);
      for (const url of imageUrls) {
        try {
          const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
          const ext = url.match(/\.(png|jpg|jpeg|gif|bmp)/i)?.[1] || 'png';
          const filename = `qqimg_${hash}.${ext}`;
          const filepath = path.join(imgDir, filename);
          const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
          const buffer = Buffer.from(await resp.arrayBuffer());
          fs.writeFileSync(filepath, buffer);
          imagePaths.push(filepath);
          console.log(`[图片] 已下载: ${filepath} (${buffer.length}字节)`);
        } catch (e) {
          console.error(`[图片] 下载失败: ${url} - ${e.message}`);
        }
      }
    }

    // ── 构建发给 Claude 的提示 ────────────────
    let promptText = rawMessage;
    if (imagePaths.length > 0) {
      const imgList = imagePaths.map(p => `"${p}"`).join(', ');
      const imgPrompt = `用户发来了 ${imagePaths.length} 张截图，请用 Read 工具查看图片文件: ${imgList}\n`;
      promptText = rawMessage ? imgPrompt + '用户说: ' + rawMessage : imgPrompt + '请分析截图内容';
    }

    if (!promptText) return;

    console.log(`[消息] 用户:${userId} 类型:${messageType} 内容:${promptText.slice(0, 100)}`);

    // 1. 白名单检查
    if (!this.isAllowed(userId)) {
      await sendMessage(ws, targetType, targetId, '⛔ 你没有使用权限');
      console.log(`[安全] 拒绝未授权用户 ${userId}`);
      return;
    }

    // 2. 速率限制
    if (!this.rateLimiter.allow(userId)) {
      await sendMessage(ws, targetType, targetId, '⏳ 请求太频繁，请稍后再试');
      return;
    }

    // 3. 消息包含"截屏" → 只发截图，不经过 Claude
    if (rawMessage.includes('截屏') && imagePaths.length === 0 && !rawMessage.startsWith('/')) {
      const shot = await takeScreenshot();
      if (shot.success) {
        await sendImage(ws, targetType, targetId, shot.path, '📸');
      }
      return;
    }

    // 4. 特殊命令（直接处理，不经过 Claude）
    const isCommand = rawMessage.startsWith('/');
    if (isCommand && imagePaths.length === 0) {
      await this.handleCommand(rawMessage, userId, targetType, targetId, ws);
      return;
    }

    // 5. Claude 对话（传入含图片路径的提示）
    stats.totalRequests++;
    await this.handleClaudeChat(promptText, userId, targetType, targetId, ws);
  }

  async handleCommand(text, userId, targetType, targetId, ws) {
    const spaceIdx = text.indexOf(' ');
    const cmd = (spaceIdx > 0 ? text.slice(0, spaceIdx) : text).toLowerCase();

    switch (cmd) {
      case '/new':
        this.sessions.clear(userId);
        await sendMessage(ws, targetType, targetId, '✅ 已开始新会话');
        console.log(`[会话] 用户 ${userId} 开始新会话`);
        break;

      case '/status': {
        const sid = this.sessions.get(userId);
        const statusText = [
          '📊 桥接服务状态',
          '━━━━━━',
          `启动时间: ${stats.startTime}`,
          `运行时长: ${Math.floor((Date.now() - stats.start) / 60000)}分钟`,
          `总请求数: ${stats.totalRequests}`,
          `当前会话: ${sid ? '有 (可继续对话)' : '无'}`,
          `会话超时: ${config.features.session_timeout_minutes}分钟`,
        ].join('\n');
        await sendMessage(ws, targetType, targetId, statusText);
        break;
      }

      case '/screen':
      case '/screenshot': {
        const shot = await takeScreenshot();
        if (shot.success) {
          await sendImage(ws, targetType, targetId, shot.path, '📸');
          console.log(`[截图] 已发送: ${shot.path} (${shot.size}字节)`);
        } else {
          await sendMessage(ws, targetType, targetId, `❌ 截图失败: ${shot.error}`);
        }
        return;
      }

      case '/help': {
        const helpText = [
          '🤖 QQ-Claude Bridge 使用帮助',
          '━━━━━━',
          '直接发消息 = 与 Claude 对话',
          '/new = 开始新会话（清除上下文）',
          '/status = 查看服务状态',
          '/help = 显示此帮助',
          '━━━━━━',
          `支持多轮对话，${config.features.session_timeout_minutes}分钟无活动自动过期`,
        ].join('\n');
        await sendMessage(ws, targetType, targetId, helpText);
        break;
      }

      default:
        await sendMessage(ws, targetType, targetId, `❓ 未知命令: ${cmd}\n输入 /help 查看可用命令`);
    }
  }

  async handleClaudeChat(text, userId, targetType, targetId, ws) {
    // 立即发送"正在思考"提示
    await sendMessage(ws, targetType, targetId, '🤔 正在思考...');

    // 记录 images 目录的现有文件，用于检测 Claude 是否生成了新图片
    const imgDir = path.join(__dirname, 'images');
    const existingFiles = new Set();
    if (fs.existsSync(imgDir)) {
      fs.readdirSync(imgDir).forEach(f => existingFiles.add(f));
    }

    const sessionId = this.sessions.get(userId);
    const result = await callClaude(text, sessionId);

    if (result.error) {
      const errorMsg = `❌ 出错了: ${result.error}`;
      await sendMessage(ws, targetType, targetId, errorMsg);
      console.error(`[错误] 用户 ${userId}: ${result.error}`);
      return;
    }

    if (result.session_id) {
      this.sessions.set(userId, result.session_id);
    }

    const reply = formatResponse(result.result, result.cost_usd || 0, result.num_turns || 0);

    for (const chunk of splitLongMessage(reply)) {
      await sendMessage(ws, targetType, targetId, chunk);
      await sleep(300);
    }

    // 检测 Claude 是否用 Bash 生成了新截图，自动发送
    if (fs.existsSync(imgDir)) {
      const newFiles = fs.readdirSync(imgDir).filter(f => !existingFiles.has(f) && f.endsWith('.png'));
      for (const f of newFiles) {
        const filepath = path.join(imgDir, f);
        const stat = fs.statSync(filepath);
        if (Date.now() - stat.mtimeMs < 60000) {  // 1分钟内的新文件
          await sendImage(ws, targetType, targetId, filepath, `📸`);
          console.log(`[截图] 自动发送: ${filepath}`);
        }
      }
    }

    console.log(`[回复] 用户 ${userId}: ${reply.length}字符, $${(result.cost_usd || 0).toFixed(4)}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── WebSocket 服务 ────────────────────────────────────────

function startServer() {
  const bridgeConfig = config.bridge;
  const handler = new MessageHandler();

  const wss = new WebSocketServer({
    host: bridgeConfig.host,
    port: bridgeConfig.port,
  });

  console.log('═'.repeat(50));
  console.log('  QQ-Claude Bridge v1.0 (Node.js)');
  console.log('═'.repeat(50));
  console.log(`  监听地址: ws://${bridgeConfig.host}:${bridgeConfig.port}`);
  console.log(`  授权用户: ${handler.allowedUsers.size > 0 ? [...handler.allowedUsers].join(', ') : '所有人 (⚠️)'}`);
  console.log(`  Claude: ${CLAUDE_BIN}`);
  console.log(`  速率限制: ${config.security.rate_limit.max_requests}次/${config.security.rate_limit.window_seconds}秒`);
  console.log(`  会话超时: ${config.features.session_timeout_minutes}分钟`);
  console.log('═'.repeat(50));
  console.log('  等待 NapCatQQ 连接...');
  console.log('');

  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;
    console.log(`[连接] NapCatQQ 已连接: ${peer}`);
    addConnection(ws);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // OneBot v11: post_type 表示事件消息，echo 表示 API 响应
        if (msg.post_type) {
          // 这是事件消息（如收到 QQ 消息）
          await handler.handleMessage(msg, ws);
        } else if (msg.echo) {
          // 这是 API 响应，由 sendOneBotAction 的 Promise 处理
          // 不在这里处理，sendOneBotAction 已注册了监听器
        }
      } catch (e) {
        // 非 JSON 消息，忽略
      }
    });

    ws.on('close', () => {
      console.log(`[连接] NapCatQQ 断开: ${peer}`);
      removeConnection(ws);
    });

    ws.on('error', (err) => {
      console.error(`[错误] WebSocket 异常: ${err.message}`);
      removeConnection(ws);
    });
  });

  wss.on('error', (err) => {
    console.error(`[致命] 服务器错误: ${err.message}`);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n[关闭] 收到中断信号，正在停止...');
    wss.close();
    process.exit(0);
  });
}

startServer();
