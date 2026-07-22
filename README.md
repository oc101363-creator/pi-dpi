# pi-dpi — dπ：拆解 π

**dπ = 拆解 π = 解耦分发。** pi-dpi 是 pi coding agent 的一个扩展插件（纯引擎，不含任何
agent 内容）：它把「agent 世界」从 pi 包中拆出来——人格、技能、提示词、记忆、会话存档
全部放进一个独立的**内容仓库**（你自己的 git 仓库），pi-dpi 只负责绑定、加载与同步。
引擎与内容解耦：引擎升级不动内容，内容迭代不动引擎，同一份内容仓库可以在多台机器、
多个团队成员之间分发。

## 安装

```bash
pi install git:github.com/oc101363-creator/pi-dpi
```

## 使用：`/agent-login`

安装后第一次使用，在 pi 中执行：

```
/agent-login
```

完整流程：

1. **仓库地址**：直接 `/agent-login <地址>` 或交互输入。容忍 `user/repo`、
   `github.com/user/repo`、`https://…`、`git@…` 等写法，统一归一化为
   `https://github.com/user/repo.git`。
2. **代理选择**：`不需要代理 / 使用 127.0.0.1:7890 / 自定义输入`。
3. **GitHub 设备授权**：终端显示 `user_code` 与验证地址，浏览器打开
   <https://github.com/login/device> 输入代码完成授权（OAuth device flow）。
4. **克隆内容仓库**：授权成功后自动 `git clone` 到
   `~/.pi/agent/dpi/repo`（token 不落 remote URL，走一次性 credential helper）。
5. **声明式注册**：把内容仓库的本地路径写进 `settings.json` 的 `packages`——
   内容仓库本身是标准 pi 包（`package.json` 里 `pi` 清单声明 prompts/themes），
   提示词与主题由 pi 原生加载。
6. **技能按声明发现**：引擎在 `resources_discover` 时读取**当前 agent** 的
   `agent.json`，只把声明的技能（仓库根 `skills/` 注册表条目）返回给 pi——
   未声明的技能不进会话，这是 dpi 的技能隔离机制。
7. **立即生效**：自动 `/reload`，agent 卡片、技能、提示词、记忆即刻可用。

其它命令：

| 命令 | 作用 |
| --- | --- |
| `/agent-login [仓库地址]` | 绑定/重新绑定内容仓库 |
| `/agent-logout` | 清除本机 token（本地仓库与配置保留） |
| `/agent [名字]` | 查看/切换当前 agent |
| `/skills` | 管理当前 agent 的技能组合：勾选/取消、删除注册表技能 |
| `/extensions` | 管理当前 agent 的扩展组合：勾选/取消、删除注册表扩展 |
| `/sync` | 手动同步内容仓库（pull --rebase → 清扫提交 → push） |
| `/record on\|off\|status` | 会话存档开关 |

自动同步：pi 启动时 `pull --rebase --autostash` + 清扫推送，退出时再清扫推送一次；
全部静默容错，失败（断网/冲突）不影响 pi 启动。

## 内容仓库结构约定

内容仓库就是一个普通 git 仓库（**务必保持 Private**——记忆与会话都在里面）：

```
<内容仓库>/
├── agents/                 # 多 agent 平行世界，一个目录一个完整人格
│   └── <name>/
│       ├── SYSTEM.md       # 人格定义（每轮对话注入系统提示词）
│       ├── agent.json      # 能力组合声明：{ "description": "…", "skills": […], "extensions": […] }
│       └── prompts/        # 该 agent 专属提示词模板（xxx.md → /xxx）
├── skills/                 # 技能注册表：平铺的技能库（<skill>/SKILL.md），
│                           #   不直接属于任何 agent，由 agent.json 按名组合
├── extensions/             # 扩展注册表：平铺的扩展库（<name>.ts），
│                           #   不直接属于任何 agent，由 agent.json 按名组合
├── machines/               # 机器层配置：<hostname>.json 覆写白名单字段
│                           #   （proxy、recordSessions），随仓库同步，新机器自动获配
├── memory/<agent>/*.md     # 长期记忆，按 agent 隔离，随仓库版本化
├── sessions/               # 会话存档（/record on 时写入）
├── docs/plans|specs/       # 工作流文档：大改先 spec（设计）后 plan（执行计划）
└── themes/                 # 可选，pi 主题
```

新增 agent = 新增 `agents/<name>/{SYSTEM.md,agent.json}` + 在 `skills/` 注册表挑技能
填进 `skills` 数组，无需改任何代码。新增技能 = 在 `skills/` 下加一个目录，然后由需要的
agent 在各自的 `agent.json` 里声明。日常增删技能、调整组合不需要手编文件，用 `/skills`
交互完成（勾选/取消即写回 `agent.json`，也可删除注册表技能）。扩展同理：新增扩展 =
在 `extensions/` 下加一个 `.ts` 文件，由需要的 agent 在 `agent.json` 的 `extensions`
数组里声明，日常管理用 `/extensions` 交互完成。

## per-agent 扩展

内容仓库根 `extensions/` 是平铺的扩展注册表（一个 `.ts` 文件一个扩展），不直接属于
任何 agent。机制一句话：**切换 agent 时引擎把内容包 settings 条目的 `extensions`
过滤器改写为当前 agent 声明的白名单，过滤发生在 import 之前 = 真隔离**（未声明的
扩展文件根本不会被 jiti 执行）；代价是切换即全量 `reload`。启动时引擎还会自动对齐
一次过滤器（启动自愈），`agent.json` 被外部编辑或 `/sync` 拉取后，下一次重载即收敛。

## superpowers 支持

[superpowers](https://github.com/obra/superpowers) 自 v0.5.0 起作为内容仓库
`extensions/` 注册表中的普通扩展，经 `agent.json` 声明 + settings 白名单按 agent
加载（引擎内置注入器已退役）。

## 机器层配置（machines/）

引擎加载配置时，会在全局 `config.json` 之上叠加内容仓库的
`machines/<hostname>.json`（hostname 归一化为小写 `[a-z0-9-]`，如
`MacBook-Air → macbook-air`）。白名单字段：`proxy`、`recordSessions`——机器相关的
设置随仓库同步，换新机器时写一次机器文件即自动获配，无需逐台重设。

## 配置与数据位置

全部存于 `~/.pi/agent/dpi/`（目录 0700）：

- `config.json`：repoUrl / repoPath / branch / proxy / currentAgent / recordSessions
- `token`：GitHub token（0600）
- `repo/`：内容仓库本地克隆

若设置了 `PI_CODING_AGENT_DIR` 环境变量，则以 `$PI_CODING_AGENT_DIR/dpi/` 替代。

## ⚠️ 隐私提醒

- 内容仓库必须保持 **Private**。记忆与会话存档都在仓库里，仓库公开等于公开你的
  偏好、项目事实与聊天记录。
- token 仅以 0600 权限存于本机 `~/.pi/agent/dpi/token`，绝不写进 remote URL 或任何配置。
