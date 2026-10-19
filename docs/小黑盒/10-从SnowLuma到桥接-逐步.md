# 从 SnowLuma 到桥接 · 一步不漏

> 这是施工单（照着做就能跑起来），也是视频分镜底稿。
> 写作日期：2026-10-14　对应版本：qq-bridge main 分支 / SnowLuma 1.14+
> 记号：※ = 要动手做的地方　⚠️ = 踩过的坑　→ 后面是屏幕上应该看到什么

---

## 0. 先看清这条链子

```
你的手机 QQ ──┐
              │  (腾讯服务器)
              ▼
      ┌───────────────┐        注入
      │  QQ 客户端 NT  │◀──────────────┐
      └───────┬───────┘                │
              │ 本机 IPC               │
              ▼                        │
      ┌───────────────┐                │
      │   SnowLuma    │────────────────┘
      │（协议端/网关）  │  它是 QQ 的一个"外挂插件"，
      └───────┬───────┘  把 QQ 收到的消息翻译成 OneBot v11
              │
              │  HTTP 127.0.0.1:3000（发消息、拉历史、查状态）
              │  WS   127.0.0.1:3001（收消息，实时推）
              ▼
      ┌───────────────┐
      │   qq-bridge   │  它负责"人味"：唤醒、节奏、分条、角色卡、
      │   （桥接）     │  记忆、语音、图库、日记、工具（QQ 那套 MCP）
      └───────┬───────┘
              │  HTTP 127.0.0.1:43129
              ▼
      ┌───────────────┐
      │      DSH      │  大脑：真正"想"的地方，一次唤醒 = 跑一轮
      └───────────────┘
```

三句话记住分工：

- **SnowLuma 负责跟腾讯说话**（这部分别自己写，写不出来）
- **桥接负责像个人**（什么时候回、分几条、发语音还是打字、记得住昨天）
- **DSH 负责想内容**（角色卡 + 上下文 + 她手上那些工具）

**端口表**（后面每一步都会回到这张表）：

| 端口 | 属于谁 | 干什么 |
|---|---|---|
| 5099 | SnowLuma | 它的 WebUI（配置界面，扫码后进去开服务、拿令牌） |
| 3000 | SnowLuma | OneBot HTTP（发消息、拉群成员、查状态） |
| 3001 | SnowLuma | OneBot WS（消息实时推送，收消息全靠它） |
| 3100 | 桥接 | 桥接控制台（看会话、看状态、卡住时救她） |
| 43129 | DSH | 桥接把提示词发到这里，等大脑回话 |
| 3210 | 语音服务（可选） | 她的声音，要发语音才需要 |

---

# 第一部分 · SnowLuma

## 1.1 前置

- 一个**小号 QQ**（她的号）——不要用你自己的主号，出问题方便重来
- 那个小号的**手机 QQ 能登录**（扫码要用）
- Windows 10/11，**纯英文路径**（`E:\SnowLuma`；⚠️ 别放桌面、别放"我的文档"、别放中文名的文件夹）
- 同一台电脑上装着 QQ NT 客户端

## 1.2 下载与解压

1. GitHub 搜 `SnowLuma`，进仓库 Releases，下 Windows 包
2. 解压到 `E:\SnowLuma`
3. 检查解压出来是这样的（不要多套一层文件夹）：

```
E:\SnowLuma\
├─ launcher.bat          ← 以后都点这个
├─ 带窗口启动.bat          ← 想看日志点这个
├─ 静默启动.bat
├─ node.exe              ← 自带的 Node，不用你装
├─ index.mjs / server-*.js / config-*.js
├─ config\               ← 配置都在这里（关键）
├─ data\
├─ logs\
└─ client\  native\
```

→ 屏幕上：能看到 `launcher.bat` 和 `node.exe` 就算对了

⚠️ 如果解压后里面还有一个同名文件夹，说明是"套娃"，把里层的内容整个剪切出来。

## 1.3 第一次装依赖（很多人死在这一步）

1. **先把 QQ 关掉**（右下角托盘右键退出，不是最小化）
2. 在 `E:\SnowLuma` 目录里开一个终端：

```powershell
cd E:\SnowLuma
npm install
```

3. 等它跑完（可能要几分钟，会下一堆 native 模块）

→ 屏幕上：最后出现 `added xxx packages` 之类的就是成了

⚠️ 坑 1：QQ 没关 → 依赖装不上，或者装上了也注入不进去
⚠️ 坑 2：路径有中文/空格 → 各种莫名其妙的报错
⚠️ 坑 3：开着代理/VPN → 下载依赖超时（可以临时关掉）

## 1.4 启动 + 扫码登录

1. 双击 `launcher.bat`（想看实时日志就点 `带窗口启动.bat`）
2. 它会自己拉起 QQ 并注入
3. 第一次会弹二维码

→ 屏幕上：一个二维码窗口，或者它直接说"请在 WebUI 里扫码"

4. 打开 `http://127.0.0.1:5099`，用**她的手机 QQ** 扫码登录

→ 屏幕上：WebUI 左上角显示她的头像、昵称、QQ 号，状态 `在线`

5. 登录成功后 QQ 桌面端会被重启一次（注入生效），这是正常的

6. 这时候拿你**自己的号**给她发一条消息，看 QQ 桌面端是不是**同时**能收到

→ 屏幕上：你发的消息，QQ 客户端里出现了

⚠️ 坑 4：QQ 桌面端如果是"免打扰/自动更新"状态，注入会失败——先把 QQ 更新到最新，再重来
⚠️ 坑 5：QQ 官方更新之后，注入会掉，重新点一次 `launcher.bat` 就行

## 1.5 在 WebUI 里开 OneBot 服务（桥接就等这两个口子）

WebUI（`http://127.0.0.1:5099`）→ 找到 OneBot / 网络配置，开两个：

| 要开的 | 端口 | 说明 |
|---|---|---|
| **HTTP 服务** | `3000` | 桥接用它发消息、拉历史、查状态；**别忘了勾上 WebSocket 支持** |
| **WS 服务** | `3001` | 桥接用它收消息（这个不开，她就"聋了"） |

**访问令牌**：界面上那串（可以自己设，也可以用它生成的）→ **复制出来，下一步要填到桥接里**。

填写要点：

- host 一律 `127.0.0.1`（**别开 0.0.0.0**，除非你清楚在干什么）
- 消息格式选 `array`（不是 `string`）
- `reportSelfMessage` 关掉（不然她自己的消息也会被当成"收到的"）

## 1.6 配置落盘在哪（排查问题时直接看这个文件）

SnowLuma 每个登录过的账号一份配置：

```
E:\SnowLuma\config\onebot_<QQ号>.json
```

里面大致长这样（值已脱敏）：

```json
{
  "networks": {
    "httpServers": [{
      "name": "http-default",
      "accessToken": "★HTTP 的令牌★",
      "messageFormat": "array",
      "reportSelfMessage": false,
      "host": "127.0.0.1",
      "port": 3000,
      "path": "/",
      "enableWebSocket": true
    }],
    "wsServers": [{
      "name": "ws-default",
      "accessToken": "★WS 的令牌（跟上面不是同一个值！）★",
      "messageFormat": "array",
      "reportSelfMessage": false,
      "host": "127.0.0.1",
      "port": 3001,
      "role": "Universal"
    }]
  }
}
```

⚠️ **记住这一条**：HTTP 的 token 和 WS 的 token 是**两个值**。桥接的 config.json 里只能存一个（存 HTTP 那个），WS 那个它会自己去这个文件里读出来（下面 2.4 讲）。

## 1.7 自检：三条命令，看见绿字才算过

在 PowerShell 里跑（把 `<TOKEN>` 换成刚复制的访问令牌）：

```powershell
$h = @{ Authorization = 'Bearer <TOKEN>' }

# ① 网关活着吗
Invoke-RestMethod 'http://127.0.0.1:3000/get_status' -Method POST -Headers $h

# ② 版本对不对
Invoke-RestMethod 'http://127.0.0.1:3000/get_version_info' -Method POST -Headers $h

# ③ 登的是哪个号
Invoke-RestMethod 'http://127.0.0.1:3000/get_login_info' -Method POST -Headers $h
```

→ 屏幕上：① 有 `online: true`；② 有版本号；③ 有 `user_id`（她的 QQ 号）和 `nickname`

⚠️ 坑 6：不要拿 `get_login_info` 判断"活没活"——它只返回 `{user_id, nickname}`，**永远不报错**，QQ 掉线了它照样回。**判活要用 `get_status`**。

## 1.8 SnowLuma 这一段常见故障

| 症状 | 原因 | 怎么办 |
|---|---|---|
| 3000/3001 连不上 | SnowLuma 没跑 / QQ 被关了 | 点 `launcher.bat`，看 WebUI 是不是在线 |
| 401 / 令牌错误 | 令牌填错，或用了 WS 那个令牌去连 HTTP | 回 WebUI 重新复制 |
| WebUI 打不开 | 端口被占 / 没启动 | `Get-NetTCPConnection -LocalPort 5099 -State Listen` |
| 扫码后 QQ 闪退 | QQ 版本和注入不匹配 | 更新 QQ 到最新，重新注入 |
| 昨天还好好的，今天不行 | QQ 自动更新把注入冲掉了 | 重新 `launcher.bat`（每天开机点一次就当体检） |

---

# 第二部分 · 桥接（qq-bridge）

## 2.1 前置

- **Node.js ≥ 20**（`node -v` 看一眼；SnowLuma 那个自带的 node.exe 不算，桥接用自己的）
- **DSH 已经装好并在运行**（`http://127.0.0.1:43129` 能开就算在）
- SnowLuma 那一步已经跑通（3000/3001 是绿的）

## 2.2 装（一键脚本做了什么）

双击 `安装.bat`（或命令行 `安装.bat D:\qq-bridge` 指定目录），它做五件事：

| 步骤 | 它在干什么 | 屏幕上 |
|---|---|---|
| [1/5] | 检查 `node -v` 和 `npm -v`，版本不够直接退出 | `OK Node.js v2x.x.x` |
| [2/5] | 去 GitHub 下 qq-bridge 的 main.zip（走 gh-proxy 加速），解压到目标目录 | `正在下载（可能要一两分钟）…` |
| [3/5] | `npm install` 装依赖（**最慢的一步，3~5 分钟，别关窗口**） | 刷一堆进度，最后 `OK 依赖装好了` |
| [4/5] | 从 `config.example.json` 复制出 `config.json` | `OK 已生成 config.json` |
| [5/5] | 弹出记事本让你填三个地方（见 2.3） | 记事本打开 |

⚠️ 如果 npm 卡住：脚本会问你要不要换成 `registry.npmmirror.com`，国内网络建议换。

手动装（等价）：

```powershell
cd D:\
git clone https://github.com/Derpyu520/qq-bridge.git
cd qq-bridge
npm install
copy config.example.json config.json
notepad config.json
```

## 2.3 config.json：必填三处，别填错层级

**必填（不填她就不理人）：**

```jsonc
{
  "ownerQQ": "3776013884",              // ① 你的 QQ 号（主人，最高权限、不会被 Ignore）

  "allow": {
    "private": ["2542965840", "3776013884"],   // ② 白名单：她的号 + 你的号，别的号一律不理
    "groups":  ["1055935861"],                 //    要聊的群（没有群就留空数组）
    "allowAllWhenEmpty": false                 //    别开！开了谁都能跟她说话
  },

  "snowluma": {
    "httpUrl": "http://127.0.0.1:3000",
    "wsUrl":   "ws://127.0.0.1:3001",
    "accessToken": "★SnowLuma 界面里那串令牌★",   // ③ 填在 snowluma 下面！
    "homeDir": "E:\\SnowLuma",                    //    ★很重要★ 见 2.4
    "launcherPath": "E:\\SnowLuma\\launcher.bat",
    "followDiscoveredEndpoint": true              //    让它自动纠偏端点，保持 true
  }
}
```

⚠️ **坑（最容易死的一个）**：令牌要填在 **`snowluma.accessToken`**，**不是** `onebot.accessToken`。填错层级 = 一直连不上 = 她一句都不会回。

**其余关键项**（有默认值，知道有哪些就行）：

```jsonc
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:43129",   // 大脑在哪
    "provider": "deepseek-official",
    "model": "deepseek-flash",
    "reasoningEffort": "low",              // 闲聊场景 low 就够，省钱又快
    "authToken": "★DSH 的令牌★",
    "allowRemote": false
  },
  "sessionCwd": "E:\\ai",                   // 她被唤醒时的工作目录（能读写哪里）
  "agentPreset": "qq-chat",                 // 用哪套预设（私聊另有 privateAgentPreset）
  "consolePort": 3100,                      // 控制台
  "consoleToken": "★自己设一串★",           // 控制台钥匙，别外传
  "ackMessage": "嗯嗯",                      // 等待时的口头禅
  "socialV2": {
    "enabled": true,                        // 二代仿真社交（分条、节奏、打字状态）
    "agentPreset": "qq-chat-private",
    "send": { "maxSendPerMinute": 6, "burstMaxMessages": 4 },
    "wake": { "defaultMode": "active" }
  }
}
```

## 2.4 令牌那点事（为什么第一次连会"失败"一次）

桥接启动时会连两个东西：

1. `wsUrl`（3001）——收消息
2. `httpUrl`（3000）——发消息、拉历史

而你 config.json 里只有一个 `accessToken`。实际情况是：**SnowLuma 的 HTTP 令牌和 WS 令牌是两个不同的值**，config 里存的是 HTTP 那个。

所以**第一次连 WS 通常会被拒**，日志里会看到：

```
SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ...
SnowLuma 连接断开（code=1006），重连中…
   自愈完成：账号 2542965840（close code=1006）
SnowLuma 已连接：ws://127.0.0.1:3001        ← 看到这一行才算真的连上
```

**看见"首次连接未成功"不要慌，那是正常流程**。桥接会自己去 `snowluma.homeDir` 里的 `config\onebot_<QQ号>.json` 把真正的 WS 令牌读出来，然后重连。

如果它说 **"token 自愈失败"**，那只有一个原因：`homeDir` 没配 / 配错 / SnowLuma 挪了地方 → 改 config.json 里的 `snowluma.homeDir`，重启桥接。

## 2.5 启动

双击 `启动.bat`（它先体检两个端口，再起）：

```
检查前置服务...
    OK   SnowLuma（QQ 连接）
    OK   DeepSeek Harness（大脑）

   ★ 这个窗口不要关 ★
```

然后它执行 `node src\bridge.js`，日志开始刷。

⚠️ **这个窗口要一直开着**，最小化就行。关掉窗口 = 她下线。
⚠️ 想让她下线：直接关窗口（干净，不要用杀进程的方式）。

## 2.6 启动日志怎么读（一眼判断好没好）

| 日志行 | 意思 |
|---|---|
| `SnowLuma 已连接：ws://127.0.0.1:3001` | **最关键的一行**。有它 = 她能听见你 |
| `SnowLuma 首次连接未成功（将在后台自动重连…）` | 正常，等自愈 |
| `SnowLuma 连接断开（code=1006），重连中…` | 正常（第一次必出现）；反复出现才是问题 |
| `token 自愈失败` | homeDir 配错，去改 config.json |
| `DSH 会话就绪` / `harness ...` | 大脑连上了 |
| `401` | DSH 令牌或 SnowLuma 令牌不对 |
| `会话繁忙，暂存唤醒原因` | 她上一轮还没跑完，消息排队了（正常，别慌） |

看日志文件（窗口关了以后照样能查）：

```powershell
Get-Content E:\qq-bridge\state\bridge.log -Tail 50 -Encoding UTF8
```

每一条 QQ 消息的流水（谁说了什么、她怎么回）：

```powershell
Get-Content E:\qq-bridge\state\qq-activity.log -Tail 50 -Encoding UTF8
```

## 2.7 白名单：她只认谁

| 字段 | 作用 |
|---|---|
| `ownerQQ` | 主人。**永远有权限**，且她的工具会额外给你开绿灯（比如私聊直接回） |
| `allow.private` | 私聊白名单：只有这里面的号能跟她私聊 |
| `allow.groups` | 群白名单：只有这些群里她才会被唤醒 |
| `allowAllWhenEmpty` | **保持 false**。true = 白名单为空时任何人都能聊 |
| `deny.*` | 黑名单，优先级比 allow 高 |

群里的唤醒条件由 `socialV2.wake.groupLock` 控制（被 @、被叫名字、关键词、概率等），想改就改这一处，别去改代码。

## 2.8 控制台（3100）：出事了来这里救

浏览器打开 `http://127.0.0.1:3100/?token=<consoleToken>`（或者在弹出的框里粘令牌）。

⚠️ 直接开 `http://127.0.0.1:3100/` 会给你一个 401 页面，那是正常的，不是坏了。

里面能看：会话列表、每个会话的唤醒配置、未读数、上次唤醒原因、发送统计。

**她卡住不动时的两条命令**（在 PowerShell 里跑）：

```powershell
$t = (Get-Content E:\qq-bridge\config.json -Raw | ConvertFrom-Json).consoleToken
$h = @{ 'x-console-token' = $t }

# ① 把某个会话的"正在跑"状态清掉
Invoke-RestMethod 'http://127.0.0.1:3100/api/session/reset' -Method POST -Headers $h `
  -ContentType 'application/json' -Body '{"key":"private:3776013884"}'

# ② 手动戳一下，让她立刻看有没有新消息
Invoke-RestMethod 'http://127.0.0.1:3100/api/socialV2/wake' -Method POST -Headers $h `
  -ContentType 'application/json' -Body '{"key":"private:3776013884"}'
```

（`key` 的格式：私聊 `private:<QQ号>`，群 `group:<群号>`）

## 2.9 验收：三件事都过才算搭完

```powershell
# ① 三个端口都在听
foreach ($p in 3000,3001,3100,43129) {
  $ok = (Test-NetConnection 127.0.0.1 -Port $p -WarningAction SilentlyContinue).TcpTestSucceeded
  "$p : $(if ($ok) {'OK'} else {'XX'})"
}

# ② WS 是不是真的连上了（看日志最后一行）
Get-Content E:\qq-bridge\state\bridge.log -Tail 5 -Encoding UTF8

# ③ 控制台能进（带令牌）
$t = (Get-Content E:\qq-bridge\config.json -Raw | ConvertFrom-Json).consoleToken
(Invoke-WebRequest "http://127.0.0.1:3100/?token=$t" -UseBasicParsing).StatusCode   # 应该是 200
```

**最后一步（真正的验收）**：拿你的大号，给她的号发一句 `在吗`。

→ 屏幕上：几秒到几十秒内，她回你消息。**回了 = 整条链子通了。**

## 2.10 桥接这一段常见故障

| 症状 | 八成是这个 | 怎么办 |
|---|---|---|
| 她一句话都不回 | WS 没连上（她能说不能听） | 看日志有没有 `SnowLuma 已连接`；没有就查 `homeDir` |
| 能收到但不回 | DSH 没开 / 令牌错 | 看 43129 端口 + 日志里的 401 |
| 回一半不回了 | 会话卡在"正在跑" | 控制台两条命令（2.8） |
| 白名单外的号能聊 | `allowAllWhenEmpty` 开着 / `deny` 没写 | 改 config.json，重启 |
| 图片发了她说没收到 | 图片通道掉了（这就是"落半路"） | 看 `state/bridge.log` 里发送记录；大图会超 `image.maxMB` |
| 重启后消息全丢 | OneBot 的 WS **不重放**，断线期间的消息永久没了 | 重启时尽量别在聊天；靠 HTTP 拉历史补 |
| 改了 config 没生效 | 桥接内存里有一份，不重启不读新值 | 关窗口重启；**改 state/social-v2.json 前必须先停桥接** |

---

# 第三部分 · 顺序（顺序错=连不上）

**开机（或者重启整套）：**

```
① DSH 起来（43129 能开）
② SnowLuma：双击 launcher.bat → WebUI 5099 显示在线
③ 桥接：双击 启动.bat → 看到「SnowLuma 已连接」
④ 验证：QQ 发一句
```

**重启某一层的时候：**

| 你动了什么 | 要跟着重启谁 |
|---|---|
| 重启 SnowLuma | 桥接不用重启（它会自动重连；断的那几秒消息会丢） |
| 改桥接 config.json | 重启桥接（必） |
| 改 `state/social-v2.json` | **先停桥接**，改完再起（不然被内存覆盖） |
| 改 MCP 文件（`src/mcp-*.js`） | 杀掉对应的 MCP 进程，DSH 会自己拉起新的（不用重启 DSH） |
| 改角色卡 `roles/小鲸鱼.md` | 不用重启，下一轮唤醒就生效 |

**关机顺序**：先关桥接窗口 → 再关 SnowLuma → 最后关 QQ。反过来也行，但别在聊天的时候关。

---

# 第四部分 · 故障速查（一页版）

| 症状 | 先看 | 再看 |
|---|---|---|
| 她完全不说话 | 桥接日志有没有 `SnowLuma 已连接` | 3000/3001 端口；`homeDir` |
| 她说话但答非所问 | 角色卡 `roles/小鲸鱼.md` | 上下文里拼了什么（控制台） |
| 她重复说话的毛病 | `socialV2.send.*` 节奏参数 | 模型是不是降智了（换 model 试试） |
| 401 | DSH 令牌 / SnowLuma 令牌 | 令牌填的层级对不对 |
| 一直在"正在跑" | 控制台 reset + wake | 看是不是某个工具卡住了 |
| 语音发不出去 | 3210 语音服务在不在 | `socialV2.voice.*` 时长/体积上限 |
| 群里不回 | `allow.groups` 有没有这个群 | `wake.groupLock` 的唤醒条件 |

---

# 第五部分 · 录视频的分镜（4 段）

**第 1 段 · 讲清楚结构（2 分钟，只放 PPT/画图，不录屏）**
- 画那张链子图：QQ → SnowLuma → 桥接 → DSH
- 记一句金句：*"SnowLuma 管说话，桥接管像人，DSH 管想内容"*

**第 2 段 · SnowLuma（4~5 分钟，全屏录）**
- 展示解压后的目录（**故意点一下那个多套一层的错误示范**）
- 关 QQ → `npm install` → 出二维码 → 扫码 → WebUI 显示在线
- 开 3000 / 3001，复制令牌（**这里把令牌挡一下再展示**）
- 跑 1.7 那三条命令，让观众看到返回

**第 3 段 · 桥接（5~6 分钟，全屏录）**
- 双击 `安装.bat`，镜头停在 npm install 那一段（说一句"这一步最慢，别关"）
- 打开 config.json，**只改三处**：ownerQQ、allow.private、snowluma.accessToken
- 特别强调：令牌填 `snowluma` 下面，不是 `onebot`
- 启动 `启动.bat`，光标停在日志上等那句 `SnowLuma 已连接`
- 拿手机给她的号发"在吗"，等她回 → 全片最高潮

**第 4 段 · 收尾（2 分钟）**
- 故障速查表走一遍（把这张表做成画面上的贴纸）
- 关机顺序、改配置后要重启
- 结尾：*"搭这个最花时间的不是写代码，是踩坑——坑我都替你踩完了。"*

**录制前准备清单：**
- [ ] 两个 QQ 号（一个主人号，一个她的号），都退掉自动登录
- [ ] 令牌要么事先打码，要么录完再遮
- [ ] SnowLuma 和桥接的窗口放大字号（观众要看清）
- [ ] 提前把 `node_modules` 删掉再录，才有"装依赖"这段真实画面（可选）

---

# 第六部分 · 一页速查卡（打印贴墙上）

```
【四个端口】5099 SnowLuma界面 · 3000 发消息 · 3001 收消息 · 3100 桥接控制台 · 43129 大脑

【必填三处】ownerQQ / allow.private / snowluma.accessToken（填 snowluma 下面！）

【看这行才算通】日志里出现：SnowLuma 已连接：ws://127.0.0.1:3001

【连不上先查】snowluma.homeDir 指向 SnowLuma 目录了吗

【她卡住了】控制台 POST /api/session/reset → 再 POST /api/socialV2/wake

【顺序】DSH → SnowLuma → 桥接 → 发消息验证

【别干的事】别开 allowAllWhenEmpty；别用 get_login_info 判活；
            改 social-v2.json 前先停桥接；桥接窗口别关
```
