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
5. **立即生效**：自动 `/reload`，agent 卡片、技能、提示词、记忆即刻可用。

其它命令：

| 命令 | 作用 |
| --- | --- |
| `/agent-login [仓库地址]` | 绑定/重新绑定内容仓库 |
| `/agent-logout` | 清除本机 token（本地仓库与配置保留） |
| `/agent [名字]` | 查看/切换当前 agent |
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
│       ├── skills/         # 该 agent 专属技能（<skill>/SKILL.md）
│       └── prompts/        # 该 agent 专属提示词模板（xxx.md → /xxx）
├── shared/
│   ├── skills/             # 所有 agent 共享技能
│   └── prompts/            # 共享提示词模板
├── memory/<agent>/*.md     # 长期记忆，按 agent 隔离，随仓库版本化
├── sessions/               # 会话存档（/record on 时写入）
└── themes/                 # 可选，pi 主题
```

新增 agent = 新增 `agents/<name>/SYSTEM.md`（+ 可选 skills/prompts），无需改任何代码。

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
