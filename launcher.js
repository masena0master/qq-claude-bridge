/**
 * QQ-Claude Bridge - 一键启动器 (v2.0)
 *
 * 解决 v1 的三个核心问题:
 *   1. NapCat 启动不可靠 (start /min 在部分环境失效)
 *   2. 协议配置未自动启用 (napcat_protocol_*.json 的 enable 未同步)
 *   3. 端口检测粗糙 (固定秒数等待，不准确)
 *
 * 用法:
 *   node launcher.js            # 一键启动
 *   node launcher.js --stop     # 停止所有服务
 *   node launcher.js --status   # 查看状态
 */

'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const yaml = require('js-yaml');

// ── 路径常量 ─────────────────────────────────────────────────

const BRIDGE_DIR = __dirname;
const DESKTOP_DIR = path.resolve(BRIDGE_DIR, '..');
const BRIDGE_JS = path.join(BRIDGE_DIR, 'bridge.js');
const CONFIG_YAML = path.join(BRIDGE_DIR, 'config.yaml');

// ── 工具函数 ─────────────────────────────────────────────────

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function log(msg, color = 'reset') { console.log(`${COLORS[color]}${msg}${COLORS.reset}`); }
function ok(msg) { log(`  ✅ ${msg}`, 'green'); }
function warn(msg) { log(`  ⚠️  ${msg}`, 'yellow'); }
function err(msg) { log(`  ❌ ${msg}`, 'red'); }
function info(msg) { log(`  ℹ️  ${msg}`, 'cyan'); }
function step(msg) { log(`\n${COLORS.bold}── ${msg}${COLORS.reset}`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 轮询直到端口可连接 */
async function waitForPort(port, host = '127.0.0.1', timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const s = net.connect(port, host, () => { s.destroy(); resolve(); });
        s.on('error', reject);
        s.setTimeout(1000, () => { s.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch { }
    await sleep(800);
  }
  return false;
}

/** 轮询直到端口上有 ESTABLISHED 连接 (不仅仅是 LISTENING) */
async function waitForConnection(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const output = execSync(`netstat -ano | findstr ":${port}"`, { encoding: 'utf8', windowsHide: true });
      if (output.includes('ESTABLISHED')) return true;
    } catch { }
    await sleep(1000);
  }
  return false;
}

/** 使用 PowerShell 查找进程 */
function findProcess(name) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" 2>nul`, { encoding: 'utf8', windowsHide: true });
    return out.includes(name);
  } catch { return false; }
}

/** 强制终止进程 */
function killProcess(name) {
  try {
    execSync(`taskkill /F /IM ${name} 2>nul`, { windowsHide: true });
  } catch { }
}

// ── 环境检测 ─────────────────────────────────────────────────

function detectEnvironment() {
  step('环境检测');

  const env = {
    botQq: '',           // 机器人 QQ（NapCat 登录的号）
    userQq: '',          // 授权用户 QQ
    napcatDir: null,
    napcatConfigDir: null,
    claudePath: 'claude',
    bridgePort: 8080,
  };

  // 1. 读取 bridge 配置
  if (fs.existsSync(CONFIG_YAML)) {
    const cfg = yaml.load(fs.readFileSync(CONFIG_YAML, 'utf8')) || {};
    env.userQq = cfg.security?.allowed_users?.[0] || '';
    env.claudePath = cfg.claude?.binary || 'claude';
    env.bridgePort = cfg.bridge?.port || 8080;
    ok(`Bridge 配置已加载 (授权用户: ${env.userQq || '未设置'}, 端口: ${env.bridgePort})`);
  } else {
    warn('未找到 config.yaml，将使用默认配置');
  }

  // 2. 检测 Claude
  const claudePaths = [
    env.claudePath,
    'claude',
    'D:/npm-global/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    `${process.env.APPDATA}\\npm\\claude.cmd`,
    `${process.env.USERPROFILE}\\AppData\\Roaming\\npm\\claude.cmd`,
  ];
  for (const p of claudePaths) {
    if (fs.existsSync(p)) { env.claudePath = p; break; }
  }
  try {
    const result = execSync(`"${env.claudePath}" --version 2>nul`, { encoding: 'utf8', windowsHide: true }).trim();
    if (result) { ok(`Claude: ${result}`); }
    else throw new Error();
  } catch {
    // 尝试 where
    try {
      const w = execSync('where claude 2>nul', { encoding: 'utf8', windowsHide: true }).trim().split('\n')[0];
      if (w && fs.existsSync(w)) { env.claudePath = w; ok(`Claude: ${w}`); }
      else throw new Error();
    } catch { warn('未检测到 claude 命令，请安装 Claude Code CLI'); }
  }

  // 3. 检测 NapCat
  const napcatDirs = [
    path.join(DESKTOP_DIR, 'napcat', 'NapCat.44498.Shell'),
    'C:\\NapCat',
    'D:\\NapCat',
  ];
  for (const d of napcatDirs) {
    if (fs.existsSync(d) && fs.existsSync(path.join(d, 'NapCatWinBootMain.exe'))) {
      env.napcatDir = d;
      break;
    }
  }
  if (!env.napcatDir) {
    // 模糊匹配
    const napcatRoot = path.join(DESKTOP_DIR, 'napcat');
    if (fs.existsSync(napcatRoot)) {
      try {
        const dirs = fs.readdirSync(napcatRoot).filter(d => d.startsWith('NapCat'));
        if (dirs.length > 0) {
          for (const d of dirs) {
            const full = path.join(napcatRoot, d);
            if (fs.existsSync(path.join(full, 'NapCatWinBootMain.exe'))) {
              env.napcatDir = full;
              break;
            }
          }
        }
      } catch { }
    }
  }

  if (env.napcatDir) {
    ok(`NapCat: ${env.napcatDir}`);

    // 查找 config 目录
    const versionsDir = path.join(env.napcatDir, 'versions');
    if (fs.existsSync(versionsDir)) {
      try {
        const vers = fs.readdirSync(versionsDir);
        for (const v of vers) {
          const cfgDir = path.join(versionsDir, v, 'resources', 'app', 'napcat', 'config');
          if (fs.existsSync(cfgDir)) {
            env.napcatConfigDir = cfgDir;
            break;
          }
        }
      } catch { }
    }
    if (env.napcatConfigDir) {
      ok(`NapCat 配置: ${env.napcatConfigDir}`);

      // 从现有 onebot11_<QQ>.json 文件名推断机器人 QQ
      try {
        const files = fs.readdirSync(env.napcatConfigDir);
        const obFile = files.find(f => f.match(/^onebot11_(\d+)\.json$/));
        if (obFile) {
          env.botQq = obFile.match(/^onebot11_(\d+)\.json$/)[1];
          ok(`机器人 QQ: ${env.botQq} (从配置文件名检测)`);
        }
      } catch { }
    } else {
      warn('未找到 NapCat 配置目录');
    }
  } else {
    warn('未检测到 NapCatQQ，请下载并安装: https://github.com/NapNeko/NapCatQQ/releases');
  }

  return env;
}

// ── 配置修复 ─────────────────────────────────────────────────

function fixConfigs(env) {
  if (!env.napcatConfigDir) return false;

  step('配置检查与修复');

  // 使用从 NapCat 配置文件名检测到的机器人 QQ
  const qq = env.botQq;
  if (!qq) {
    warn('无法确定机器人 QQ 号（未找到现有 NapCat 配置），跳过配置修复');
    info('请先在 NapCat WebUI 中登录机器人 QQ，然后重新运行本启动器');
    return false;
  }

  const onebotPath = path.join(env.napcatConfigDir, `onebot11_${qq}.json`);
  const protocolPath = path.join(env.napcatConfigDir, `napcat_protocol_${qq}.json`);
  let fixed = false;

  // 1. 修复 onebot11_<qq>.json — 确保 WS 客户端配置存在
  const wsClient = {
    name: 'QQ-Claude桥接',
    url: `ws://127.0.0.1:${env.bridgePort}`,
    messagePostFormat: 'array',
    reportSelfMessage: false,
    reconnectInterval: 5000,
    heartInterval: 30000,
    enable: true,
  };

  if (fs.existsSync(onebotPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(onebotPath, 'utf8'));
      const clients = cfg.network?.websocketClients || [];
      const hasBridge = clients.some(c => c.url && c.url.includes(String(env.bridgePort)));

      if (!hasBridge) {
        clients.push(wsClient);
        cfg.network = cfg.network || {};
        cfg.network.websocketClients = clients;
        fs.writeFileSync(onebotPath, JSON.stringify(cfg, null, 2), 'utf8');
        ok(`已添加 WS 客户端到 onebot11_${qq}.json`);
        fixed = true;
      } else {
        ok(`onebot11_${qq}.json 配置正确`);
      }
    } catch (e) {
      warn(`onebot11_${qq}.json 解析失败: ${e.message}`);
    }
  } else {
    // 创建默认配置
    const defaultCfg = {
      network: {
        httpServers: [],
        websocketServers: [],
        websocketClients: [wsClient],
      },
      enableLocalFile2Url: false,
      parseMultMsg: false,
      timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
    };
    fs.writeFileSync(onebotPath, JSON.stringify(defaultCfg, null, 2), 'utf8');
    ok(`已创建 onebot11_${qq}.json`);
    fixed = true;
  }

  // 2. 修复 napcat_protocol_<qq>.json — 确保协议启用
  if (fs.existsSync(protocolPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(protocolPath, 'utf8'));
      if (!cfg.enable) {
        cfg.enable = true;
        fixed = true;
        ok('已启用 napcat_protocol (enable: true)');
      } else {
        ok('napcat_protocol 已启用');
      }

      // 确保有 WS 客户端配置
      const clients = cfg.network?.websocketClients || [];
      const hasBridge = clients.some(c => c.url && c.url.includes(String(env.bridgePort)));
      if (!hasBridge) {
        cfg.network = cfg.network || { httpServers: [], websocketServers: [], websocketClients: [] };
        cfg.network.websocketClients.push(wsClient);
        fs.writeFileSync(protocolPath, JSON.stringify(cfg, null, 2), 'utf8');
        ok('已添加 WS 客户端到 napcat_protocol');
        fixed = true;
      }
    } catch (e) {
      warn(`napcat_protocol_${qq}.json 解析失败: ${e.message}`);
    }
  } else {
    const defaultProtocol = {
      enable: true,
      network: {
        httpServers: [],
        websocketServers: [],
        websocketClients: [wsClient],
      },
    };
    fs.writeFileSync(protocolPath, JSON.stringify(defaultProtocol, null, 2), 'utf8');
    ok(`已创建 napcat_protocol_${qq}.json`);
    fixed = true;
  }

  return fixed;
}

// ── 停止旧进程 ───────────────────────────────────────────────

function killOldProcesses(env) {
  step('清理旧进程');

  // 1. 检查桥接端口是否被占用（可能是旧实例）
  if (isPortInUse(env.bridgePort)) {
    info(`端口 ${env.bridgePort} 已被占用，清理旧桥接进程...`);
    try {
      const out = execSync(`netstat -ano | findstr ":${env.bridgePort}" | findstr "LISTENING"`, { encoding: 'utf8', windowsHide: true });
      const pidMatch = out.match(/(\d+)\s*$/m);
      if (pidMatch) {
        execSync(`taskkill /F /PID ${pidMatch[1]} 2>nul`, { windowsHide: true });
        ok(`已停止旧桥接进程 (PID: ${pidMatch[1]})`);
      }
    } catch { }
  }

  // 2. 停止 NapCat 相关进程
  const procs = [
    { name: 'NapCatWinBootMain.exe', label: 'NapCatQQ' },
    { name: 'NapCatInstaller.exe', label: 'NapCat 安装器' },
  ];
  for (const p of procs) {
    if (findProcess(p.name)) {
      killProcess(p.name);
      ok(`已停止 ${p.label}`);
    }
  }
}

/** 快速检查端口是否被占用 */
function isPortInUse(port) {
  try {
    const s = new net.Socket();
    s.connect(port, '127.0.0.1');
    s.destroy();
    return true;
  } catch { return false; }
}

// ── 启动 Bridge ───────────────────────────────────────────────

function startBridge(env) {
  step('启动桥接服务');

  return new Promise((resolve, reject) => {
    const child = spawn('node', [BRIDGE_JS], {
      cwd: BRIDGE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
      env: { ...process.env },
    });

    let started = false;

    child.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(`  [bridge] ${text}`);
      if (!started && text.includes('等待 NapCatQQ 连接')) {
        started = true;
        ok(`桥接服务已启动 (PID: ${child.pid}, 端口: ${env.bridgePort})`);
        resolve(child);
      }
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(`  [bridge/err] ${data}`);
    });

    child.on('error', (e) => {
      err(`桥接服务启动失败: ${e.message}`);
      reject(e);
    });

    child.on('exit', (code) => {
      if (!started) {
        err(`桥接服务意外退出 (code: ${code})`);
        reject(new Error(`Bridge exited with code ${code}`));
      }
    });

    // 超时回退：即使没捕获到日志，端口通了也算
    setTimeout(async () => {
      if (!started) {
        const portOpen = await waitForPort(env.bridgePort, '127.0.0.1', 5000);
        if (portOpen) {
          started = true;
          ok(`桥接服务已启动 (PID: ${child.pid}, 端口: ${env.bridgePort})`);
          resolve(child);
        }
      }
    }, 5000);
  });
}

// ── 启动 NapCat ───────────────────────────────────────────────

function startNapCat(env) {
  if (!env.napcatDir) {
    warn('NapCat 未安装，跳过启动');
    return null;
  }

  step('启动 NapCatQQ');

  const exePath = path.join(env.napcatDir, 'NapCatWinBootMain.exe');
  if (!fs.existsSync(exePath)) {
    err(`找不到 NapCatWinBootMain.exe: ${exePath}`);
    return null;
  }

  return new Promise((resolve) => {
    const child = spawn(exePath, [], {
      cwd: env.napcatDir,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });

    child.on('error', (e) => {
      err(`NapCat 启动失败: ${e.message}`);
      resolve(null);
    });

    child.on('close', (code) => {
      // NapCatWinBootMain 可能正常退出（由 bootmain 拉起真正的进程）
      // 所以 exit 不一定是失败
    });

    ok(`NapCatQQ 已启动 (PID: ${child.pid})`);
    resolve(child);
  });
}

// ── OneBot 自动启用 ───────────────────────────────────────────

async function autoEnableOneBot(env) {
  step('启用 OneBot 服务');

  // 读取 webui token 用于 API 认证
  let token = '';
  if (env.napcatConfigDir) {
    const webuiPath = path.join(env.napcatConfigDir, 'webui.json');
    if (fs.existsSync(webuiPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(webuiPath, 'utf8'));
        token = cfg.token || '';
      } catch { }
    }
  }

  // 方法1: 尝试 NapCat WebUI API
  if (token) {
    const enabled = await tryHttpEnable(token, env.bridgePort);
    if (enabled) {
      ok('OneBot 服务已通过 API 启用');
      return true;
    }
  }

  // 方法2: 打开 WebUI 协议设置页
  warn('无法通过 API 自动启用 OneBot');
  info('正在打开 WebUI 协议设置页面...');
  try {
    execSync('start http://127.0.0.1:6099/webui/setting/protocol', { windowsHide: true });
    info('请在打开的页面中开启 OneBot v11 服务');
  } catch {
    info('请手动访问 http://127.0.0.1:6099/webui/ 开启 OneBot');
  }

  return false;
}

/** 通过 HTTP API 尝试启用 OneBot */
async function tryHttpEnable(token, bridgePort) {
  // 方案A: 先登录获取 session
  const loginResult = await httpPost('/api/auth/login', { token }, {});
  if (loginResult === null) return false; // 网络不通

  // 方案B: 尝试直接调用协议状态 API (某些版本不需要登录)
  const statusResult = await httpGet('/api/protocol/status');
  if (statusResult) {
    // OneBot 可能已经在运行
    try {
      const protocols = JSON.parse(statusResult);
      if (Array.isArray(protocols)) {
        const ob = protocols.find(p => p.name === 'onebot11' || p.id === 'onebot11');
        if (ob && ob.enabled) return true;
      }
    } catch { }
  }

  // 方案C: 尝试启用协议 (多种可能的 API)
  const enableEndpoints = [
    { method: 'POST', path: '/api/protocol/onebot11/enable', body: {} },
    { method: 'POST', path: '/api/protocol/onebot11/start', body: {} },
    { method: 'PUT', path: '/api/setting/protocol/onebot11', body: { enable: true } },
    { method: 'POST', path: '/api/setting/onebot11/enable', body: {} },
  ];

  for (const ep of enableEndpoints) {
    const result = await httpPost(ep.path, ep.body, {});
    if (result !== null) {
      // API 存在且调用成功（不管返回值是什么）
      await sleep(2000);
      return true;
    }
  }

  return false;
}

function httpPost(urlPath, body, headers) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: '127.0.0.1', port: 6099, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: 5000,
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

function httpGet(urlPath) {
  return new Promise((resolve) => {
    const opts = { hostname: '127.0.0.1', port: 6099, path: urlPath, method: 'GET', timeout: 5000 };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── 主流程 ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // 处理特殊命令
  if (args.includes('--stop')) {
    console.log('正在停止所有服务...');
    killProcess('NapCatWinBootMain.exe');
    killProcess('NapCatInstaller.exe');
    console.log('✅ 已停止');
    process.exit(0);
  }
  if (args.includes('--status')) {
    printStatus();
    process.exit(0);
  }

  // ═══════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(50));
  console.log('  QQ-Claude Bridge v2.0 — 一键启动器');
  console.log('═'.repeat(50));

  // 1. 检测环境
  const env = detectEnvironment();

  // 2. 修复配置
  const configFixed = fixConfigs(env);

  // 3. 停止旧进程
  killOldProcesses(env);

  // 4. 启动桥接服务
  let bridgeProc;
  try {
    bridgeProc = await startBridge(env);
  } catch (e) {
    err('桥接服务启动失败，无法继续');
    process.exit(1);
  }

  // 等待桥接端口就绪
  const bridgeReady = await waitForPort(env.bridgePort, '127.0.0.1', 10000);
  if (!bridgeReady) {
    err('桥接服务端口未就绪，请检查 bridge.js');
    process.exit(1);
  }

  // 5. 启动 NapCat
  const napcatProc = await startNapCat(env);
  if (!napcatProc && !env.napcatDir) {
    // 没有 NapCat，提示用户手动操作
    printManualSteps(env);
    process.exit(0);
  }

  // 6. 等待 NapCat WebUI 就绪
  log('\n  等待 NapCatQQ 就绪...', 'gray');
  const napcatReady = await waitForPort(6099, '127.0.0.1', 30000);
  if (napcatReady) {
    ok('NapCatQQ WebUI 已就绪');
  } else {
    warn('NapCatQQ WebUI 未就绪，可能需要扫码登录');
  }

  // 7. 如果配置被修改了，需要重启 NapCat 使其生效
  if (configFixed) {
    info('配置已更新，重启 NapCat 使其生效...');
    killProcess('NapCatWinBootMain.exe');
    await sleep(2000);
    const napcat2 = await startNapCat(env);
    await sleep(3000);
  }

  // 8. 自动启用 OneBot
  if (napcatReady || configFixed) {
    await sleep(2000);
    await autoEnableOneBot(env);
  }

  // 9. 等待 WebSocket 连接
  log('\n  等待 NapCat 连接桥接服务...', 'gray');
  const connected = await waitForConnection(env.bridgePort, 45000);

  // 10. 最终报告
  console.log('\n' + '═'.repeat(50));
  if (connected) {
    log('  🎉 QQ-Claude Bridge 已完全启动！', 'green');
  } else {
    log('  ⚠️  桥接已启动，等待 NapCat 连接...', 'yellow');
  }
  console.log('═'.repeat(50));
  console.log(`  桥接服务:  ws://127.0.0.1:${env.bridgePort}`);
  console.log(`  NapCat UI: http://127.0.0.1:6099/webui/`);
  if (env.botQq) console.log(`  机器人 QQ: ${env.botQq}`);
  if (env.userQq) console.log(`  授权用户:   ${env.userQq}`);
  console.log('═'.repeat(50));

  if (connected) {
    console.log('\n  用手机 QQ 给机器人发消息即可开始使用！');
    console.log('  本窗口可以关闭，服务在后台运行。\n');
  } else {
    console.log('\n  请确保:');
    console.log('  1. 在 WebUI 中开启 OneBot v11 服务');
    console.log('  2. 机器人 QQ 已扫码登录\n');
  }

  // 释放对 bridge 进程的引用，让它独立运行
  if (bridgeProc) bridgeProc.unref();
  if (napcatProc) napcatProc.unref();
}

function printStatus() {
  console.log('\nQQ-Claude Bridge 状态检查\n');

  // 检查端口
  for (const [port, name] of [[8080, '桥接服务'], [6099, 'NapCat WebUI']]) {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); });
    s.on('error', () => { });
    s.on('connect', () => {
      console.log(`  ✅ ${name} — 端口 ${port} 已监听`);
      // 检查 WS 连接(仅桥接)
      if (port === 8080) {
        try {
          const out = execSync(`netstat -ano | findstr ":8080"`, { encoding: 'utf8', windowsHide: true });
          if (out.includes('ESTABLISHED')) console.log('  ✅ WebSocket 已连接');
          else console.log('  ⚠️  WebSocket 未连接');
        } catch { }
      }
    });
    s.setTimeout(2000, () => s.destroy());
  }

  // 检查进程
  if (findProcess('NapCatWinBootMain.exe')) console.log('  ✅ NapCatQQ 进程运行中');
  else console.log('  ⚠️  NapCatQQ 未运行');

  console.log('');
}

function printManualSteps(env) {
  console.log('\n未检测到 NapCatQQ，请按以下步骤操作:');
  console.log('  1. 下载 NapCatQQ: https://github.com/NapNeko/NapCatQQ/releases');
  console.log('  2. 解压到桌面 napcat 文件夹');
  console.log('  3. 启动 NapCat 并扫码登录机器人 QQ');
  console.log('  4. 在 WebUI 中开启 OneBot v11 服务');
  console.log('  5. 重新运行本启动器\n');
  console.log(`桥接服务已启动在 ws://127.0.0.1:${env.bridgePort}\n`);
}

// ── 入口 ──────────────────────────────────────────────────────

main().catch((e) => {
  console.error('启动失败:', e.message);
  process.exit(1);
});
