# dsh-notify-cues

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 通知插件：按「这一轮为什么结束」区分提示音** —— 完成、被你中断、出错、额度耗尽各有各的声音，而不是把所有停止都报成「任务完成」。

纯 PowerShell 实现：**不需要 .NET 桌面运行时，不需要任何音频素材文件**，六种音色全部现场合成。

中文 | [English](README.en.md)

![设置 → 通知](docs/assets/settings.png)

---

## 解决的问题

市面上给 DSH 做的 Windows 通知插件，判定「完成」用的都是 `agent/status → idle`。可这个条件在**任务正常跑完**时成立，在**你按下停止**时同样成立。所以你亲手中断一个任务，它会欢快地弹「任务完成」。

而真正的原因一直都记在会话日志里 —— DSH 自己写进去的：

```js
this.session.append("turn/end", { turn, reason: turnEnds })
```

`reason.kind` 来自 `TurnEndReasonMap`，被取消时还带一层嵌套原因：

```ts
type TurnEndReason     = 'completed' | 'aborted' | 'error' | 'max-tokens'
                       | 'interrupted' | 'blocked' | 'forked'
type TurnEndCancelCause = AgentCancelCause | { kind: 'legacy' }
type AgentCancelCause   = { kind: 'user' } | { kind: 'parent' }
                        | { kind: 'hook'; reason: string } | { kind: 'disposed' }
```

你按下停止就是 `{ kind: 'aborted', reason: { kind: 'user' } }`。信息一直在，只是没人接。本插件把它接上了。

## 六种情形，六种提示音

| 情形 | 判据 | 默认音色 | 听感 |
|---|---|---|---|
| 任务完成 | `completed` | `completed` | D5→A5 上行双音 |
| **被中断** | `aborted` + `reason.kind === 'user'` | `interrupted` | A5→A4 下行短音 |
| 出错 | `error` | `error` | 低沉不谐和音 |
| 达到输出上限 | `max-tokens` | `maxTokens` | 三声急促高音 |
| 被阻止 | `blocked`，或 `aborted` + `reason.kind === 'hook'` | `blocked` | 平音双击 |
| **需要你操作** | `approval/asked`、`ask_user_question` | `attention` | E5-G5-B5 上行琶音 |

`aborted` 的另外两种原因 —— `parent`（父 agent 取消了子会话）和 `disposed`（会话销毁）—— **刻意静默**，那是生命周期噪音，不是你的事。`TurnEndReasonMap` 官方标注为可被其它包扩展，所以遇到不认识的 `kind` 一律静默，而不是瞎猜一个音。

## 任务栏：QQ/微信那套行为

**先闪几下抓注意力，然后停动画但让任务栏图标保持高亮，直到你切回来。**

| `flashAfter` | 行为 |
|---|---|
| `holdUntilFocused`（默认） | 闪 3 次 → 保持高亮直到你点它 |
| `stop` | 闪 3 次就结束 |
| `keepFlashing` | 一直闪到你切回来 |

Windows 从不闪前台窗口，所以你已经盯着 DSH 时这一套都不会触发。

## 设置页

注册进 DSH **自己的设置对话框**（通过官方 `settings.section` 插槽），不是自建弹窗：

![分场景提示音](docs/assets/settings-scenes.png)

- 总开关 · 任务栏闪烁 · 系统通知弹窗 —— 三个独立开关
- 闪烁次数、节奏、以及闪完之后的行为
- 「正在看的那个会话跑完时不出声」—— 见下
- 音量
- **六种情形各自：开关 + 音效下拉 + ▶ 试听**

每个改动即时落盘，不用改代码、不用重启。

### 「静默」指的是**你正在看的那个会话**，不是「页面在前台」

判据不是「只要页面在前台就全静默」。客户端会实时上报主视图正在显示哪个会话，宿主**只在这个完成的会话就是你正在读的那一个时**才静默：

| 你的状态 | 哪个会话跑完 | 结果 |
|---|---|---|
| 正在读会话 A | 会话 A | 安静 |
| 正在读会话 A | **会话 B** | **提醒** |
| 在设置页里调配置 | 任意会话 | **提醒** |
| 切到别的程序 | 任意会话 | 提醒 |
| 提问 / 审批到达 | — | 始终提醒 |

漏掉一次提示音比多响一次更糟，所以上报链路是**失效即放行**：浏览器从没上报过，通知照常响。

## 安装

需要 Windows 10/11。

### 装进 profile

```powershell
# 1. 把插件放进你的 profile
$dest = Join-Path $env:USERPROFILE '.dsh\profiles\<profile>\node_modules\dsh-notify-cues'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item package.json, cordis.patch.yml, lib -Destination $dest -Recurse -Force

# 2. 打印第 3 步要用的加载说明符
#    name 必须是 file:// URL：Cordis loader 把这个值交给裸 import(name)，
#    传文件系统路径会失败（ERR_UNSUPPORTED_ESM_URL_SCHEME）。
node -e "console.log(require('node:url').pathToFileURL(process.argv[1]).href)" "$dest\lib\index.js"
```

把下面这段追加到 `~/.dsh/profiles/<profile>/cordis.patch.yml`，`name` 用上一步打印出来的 URL：

```yaml
- insert:
    - id: dsh-notify-cues
      name: 'file:///.../node_modules/dsh-notify-cues/lib/index.js'
      inject: ['subprocess', 'webServer']
      config:
        notifications: true
```

然后**完整重启** DeepSeek Harness，打开 **设置 → 通知**。

### 本地开发挂载

如果你的 profile 不是桌面应用独占的，可以直接挂载 checkout 并享受热重载：

```powershell
dsh --profile <profile> --patch /path/to/dev.patch.yml web
```

`dev.patch.yml` 里的 `name` 是 `REPLACE/WITH` 占位符，需要先填。被桌面应用独占的 profile 会被拒绝启动（`profile "X" is managed exclusively by the Electron application`），那种情况请走上面的安装方式。

## 配置

配置文件在 `~/.dsh/dsh-notify-cues.json`，可以在设置页改，也可以手改。**每次通知都重新读取**，所以手改立刻生效。

| 字段 | 默认 | 含义 |
|---|---|---|
| `notifications` | `true` | 总开关：不出声、不弹通知、不闪任务栏 |
| `flash` | `true` | 任务栏闪烁 |
| `flashCount` | `3` | 开场闪几次 |
| `flashTimeout` | `500` | 每闪一下的间隔毫秒数 |
| `flashAfter` | `holdUntilFocused` | `stop` · `holdUntilFocused` · `keepFlashing` |
| `toast` | `true` | 系统通知弹窗 |
| `volume` | `1` | 提示音音量，0.1–1.0 |
| `quietOnForeground` | `true` | 只静默你正在读的那一个会话 |
| `alwaysNotifyAttention` | `true` | 提问与审批不受上面那条限制 |
| `dedupMs` | `1500` | 同情形去重窗口 |
| `per.<情形>.enabled` | `true` | 单个情形开关 |
| `per.<情形>.toast` | `true` | 单个情形是否弹通知 |
| `per.<情形>.sound` | 同情形名 | 音色名、`ding`、`none`，或 `.wav` 路径 |

情形键名：`completed`、`interrupted`、`error`、`max-tokens`、`blocked`、`attention`。

### HTTP 接口

仅接受同源请求（校验 `Sec-Fetch-Site`，跨站返回 403）。

| 端点 | 方法 | 用途 |
|---|---|---|
| `/dsh-notify-cues/config` | GET/POST | 读取 / 局部更新配置 |
| `/dsh-notify-cues/presence` | GET/POST | 浏览器状态：`{visible, focused, viewedSessionId}` |
| `/dsh-notify-cues/test?scene=<情形>` | GET | 立刻发一条该情形的真实通知 |
| `/dsh-notify-cues/keys` | GET | 情形名与音色名清单 |

## 两个刻意的设计决定

**去重按 (会话, 情形) 计时，不按会话。** 早期实现用的是会话级窗口，测试立刻抓到一个真 bug —— 审批提示之后紧接着报错，错误通知会被 1.5 秒窗口吞掉，**真实故障被静默**。现在只有「同一情形的重复触发」会被压掉。

**回答完问题后抑制紧随其后的「完成」音，但绝不影响出错和中断。** 你回答提问后回合恢复，最终以 `completed` 结束；你刚点完就叮一声「完成」是纯噪音。但如果那一轮接下来报错或被中断，那是真新闻，照响。

## 测试

```powershell
node test/run.mjs                              # 逻辑单测
node test/client-contract.mjs lib/client.js    # 浏览器 bundle 契约
node test/manifest.mjs package.json            # manifest 对已装 harness
node test/patch-shape.mjs cordis.patch.yml dev.patch.yml
node test/patch-loadable.mjs dev.patch.yml
node test/sim-append.mjs                       # profile 补丁仍合法
```

`test/run.mjs` 是自建的进程内 runner，不用 `node --test`：DSH 的文件沙箱禁止命名管道，而内置 runner 正是用管道 spawn 子进程的。

依赖本机 harness 安装（`app.asar`）的检查，在没有安装时会报 `skipped` 而不是失败。用 `DSH_ASAR=/path/to/app.asar` 可以指向别处的安装。

逻辑套件覆盖：情形映射（取消原因的全部五个成员）、门控规则、配置读写、参数构造，以及通过假 ctx 的端到端分发 —— 其中有若干条专门钉住「中断绝不能报成完成」。

## 已知限制

- **仅 Windows。** 通知器调用 WinRT toast 和 `FlashWindowEx`。
- **第一次弹 toast 会注册 AppUserModelID。** 非打包进程没有 package identity，Windows 会直接丢弃 toast（`0x80073D54`），必须先有 AUMID 注册表项和开始菜单快捷方式。插件会建一个专用的 `DeepSeek Harness Notifications.lnk` —— 刻意**不叫** `DeepSeek Harness.lnk`，那个属于桌面客户端安装程序。
- **通知里不能直接作答。** `ask_user_question` 只弹普通 toast 加闪烁，回答仍在 DSH 界面里完成。那个交互式下拉菜单正是需要 .NET 的部分，本插件刻意避开。
- 任务栏「保持高亮」依赖不带动画标志的 `FLASHW_TIMERNOFG`。Windows 11 不再暴露旧的 `WS_EX_FLASHING` 位，所以这一点无法程序化断言，是在一台机器上肉眼确认的。如果你的机器上并不保持，改用 `keepFlashing` 或 `stop`。
- 开发针对 DSH `0.2.0-rc.2`。同生态的一个更早的插件提到 `0.1.0-rc.6` 根本不发 `turn/end`，在那个版本上只有前台启发式规则能工作。

## 目录结构

```
dsh-notify-cues/
├── lib/
│   ├── index.js          # 宿主：turn/end 判定、门控、配置与状态上报 API
│   ├── client.js         # 浏览器：设置分区 + 状态上报
│   └── notify.ps1        # 音色合成、WinRT toast、任务栏闪烁
├── cordis.patch.yml      # 作为包安装时的 bundle 补丁
├── dev.patch.yml         # 热重载挂载（需填 name 占位符）
├── docs/
│   ├── DSH-API-CONTRACTS.md  # 已核实的 DSH 0.2.0-rc.2 插件契约
│   ├── assets/               # README 截图
│   ├── asar.cjs              # 读取 app.asar 的辅助工具
│   └── probe-asar.mjs        # 对 app.asar 的内存全文检索
└── test/                 # 见「测试」
```

`docs/DSH-API-CONTRACTS.md` 是一份**逐条带行号引用**的契约参考，覆盖本插件依赖的每一个接口：`session/event` 回调签名、`turn/end` 完整类型树、插槽 API（哪种 `kind` 需要哪个必填项、`inject` 如何变成 props）、`webServer` 路由契约、宿主插件导出形态。想扩展这个插件时比重新反查省事得多。

## 致谢

写这个插件之前读了同生态的两个插件，它们各自已经解决过本插件必须解决的一些问题：

- [**dsh-notify-win**](https://github.com/Andyqwe44/dsh-notify-win) —— WinRT toast 的构造方式、AppUserModelID 自注册那一套（以及为什么快捷方式名字不能和安装程序的撞车）、`EnumWindows` + `FlashWindowEx` 的用法。
- [**aokamoaki/dsh-notify**](https://github.com/aokamoaki/dsh-notify) —— 分场景音型的设计，以及「需要你操作」必须绕过前台静默这个判断。

两者都不是依赖，也没有复制代码；是作为先行者参考了源码与文档。

## 许可

MIT，见 [LICENSE](LICENSE)。
