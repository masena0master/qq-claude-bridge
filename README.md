# QQ-Claude Bridge

在手机上用 QQ 远程操控电脑上的 Claude Code。像聊天一样对话，让它写代码、查文件、执行任务。

## 效果

```
📱 手机 QQ                     💻 你的电脑
─────────────────────────────────────────────
你: "帮我写一个贪吃蛇"    →    Claude 生成完整代码
你: "运行一下看看"        →    Claude 执行并回复结果
你: "有什么bug"           →    Claude 分析并修复
你: /new                  →    清除记忆，开始新对话
```

## 工作原理

```
手机QQ → NapCatQQ → bridge.js → Claude Code CLI
         (QQ协议)   (WebSocket)   (headless模式)
```

## 你需要准备

| 东西 | 说明 |
|------|------|
| **Node.js 18+** | https://nodejs.org |
| **Claude Code CLI** | 终端运行 `claude --version` 确认已安装 |
| **NapCatQQ** | QQ 机器人框架，[下载地址](https://github.com/NapNeko/NapCatQQ/releases) |
| **QQ 小号** | 建议用不常用的小号登录 NapCat |

## 安装步骤

### 1. 下载本项目

```bash
git clone https://github.com/masena0master/qq-claude-bridge.git
cd qq-claude-bridge
npm install
```

### 2. 配置

```bash
# 复制配置模板
copy config.example.yaml config.yaml
```

编辑 `config.yaml`，把 `你的QQ号` 改成你的真实 QQ 号：

```yaml
security:
  allowed_users:
    - 123456789   # ← 改成你的 QQ 号
```

如果后台运行找不到 `claude` 命令，改成绝对路径：
```yaml
claude:
  binary: C:/Users/你的用户名/AppData/Roaming/npm/claude.cmd
```

### 3. 安装 NapCatQQ

1. 下载 NapCatQQ Windows 一键包（Shell 版本）
2. 解压到桌面 `napcat` 文件夹
3. 启动 NapCat，用手机 QQ 扫码登录
4. 浏览器打开 `http://127.0.0.1:6099/webui`
   - 登录密码查看 `napcat/config/webui.json` 中的 `token` 字段
5. 开启 OneBot v11 服务（启动器会自动处理，无需手动配置 WS）

### 4. 启动

```bash
node launcher.js              # 一键启动（推荐）
# 或双击 QQ-Claude.bat
```

启动器会自动：
- 检测环境并修复配置
- 清理旧进程
- 启动桥接服务和 NapCat
- 通过 API 启用 OneBot
- 等待 WebSocket 连接就绪

看到 `🎉 QQ-Claude Bridge 已完全启动！` 就成功了。

## 使用命令

| 消息 | 作用 |
|------|------|
| 直接发任何内容 | 与 Claude 对话，自动保持上下文 |
| `/new` | 清空记忆，开始新会话 |
| `/status` | 查看服务运行状态 |
| `/help` | 显示帮助 |
| `/screen` 或 `截屏` | 截取桌面屏幕 |
| 发送图片 | Claude 会分析图片内容 |

## launcher.js 命令

```bash
node launcher.js              # 一键启动
node launcher.js --stop       # 停止所有服务
node launcher.js --status     # 查看运行状态
```

## 文件说明

```
qq-claude-bridge/
├── launcher.js             # 一键启动器 (v2.0)
├── bridge.js               # 核心桥接服务
├── config.yaml             # 你的配置（不要分享）
├── config.example.yaml     # 配置模板（可安全分享）
├── package.json            # Node.js 项目文件
├── QQ-Claude.bat           # 启动快捷脚本
├── stop-all.bat            # 停止所有服务
├── create-shortcut.vbs     # 创建桌面快捷方式
└── README.md               # 本文件
```

## 故障排查

| 问题 | 解决 |
|------|------|
| 消息没反应 | 检查 NapCat WebUI 中 OneBot v11 是否已开启 |
| Claude 启动失败 | `config.yaml` 中 `claude.binary` 改成绝对路径 |
| NapCat 扫码失败 | 换小号试试，或用密码登录 |
| 端口被占用 | 启动器会自动清理旧进程，或运行 `launcher.js --stop` |
| 启动后未连接 | 打开 `http://127.0.0.1:6099/webui/setting/protocol` 手动开启 OneBot |

## 安全提示

- 务必设置 `allowed_users` 白名单
- 不要用常用大号登录 NapCat（可能被封）
- 可通过 `allowed_tools` 限制 Claude 的电脑操作权限
