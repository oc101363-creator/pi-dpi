/**
 * agent-loader：当前 agent 解析（移植自旧内容仓库 extensions/agent-loader.ts）。
 *
 * - session_start：渲染当前 agent 的能力卡片（复刻 pi 原生面板样式）+ 底栏状态
 * - before_agent_start：把 agents/<当前agent>/SYSTEM.md 链式注入系统提示词
 * - resources_discover：返回 agents 下各 agent 的 skills/prompts、shared/ 与 themes/ 下存在的目录
 * - /agent [name]：查看/交互或直接切换当前 agent（写入 dpi 配置，跨进程保持）
 *
 * 内容仓库路径全部来自 dpi 配置（config.repoPath）；未绑定时所有 hook 静默 no-op。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig, scanAgents } from "../src/config.ts";

// ---------- 内容仓库路径（每次调用时从配置取，切换绑定即时生效） ----------

function repoPath(): string | null {
  const cfg = loadConfig();
  return cfg.repoUrl ? cfg.repoPath : null;
}

function currentAgent(): string {
  const { currentAgent } = loadConfig();
  // 配置文件可被手工编辑，防御路径穿越：agent 名只允许纯目录名
  return /^[\w-]+$/.test(currentAgent) ? currentAgent : "coder";
}

// ---------- agent 卡片（TUI 面板） ----------

// 读取技能目录下的技能名；tag 用于标注来源（如「共享」）
function readSkillNames(dir: string, tag = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => (tag ? `${e.name}(${tag})` : e.name))
    .sort();
}

// 列出提示词模板（xxx.md → /xxx）
function readPrompts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `/${f.replace(/\.md$/, "")}`)
    .sort();
}

// 取 SYSTEM.md 首行非标题、非空文本作为 agent 一句话简介
function agentTitle(repo: string, agent: string): string {
  try {
    const head = readFileSync(join(repo, "agents", agent, "SYSTEM.md"), "utf-8").slice(0, 1000);
    const line = head
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    if (!line) return "";
    return line.length > 40 ? `${line.slice(0, 39)}…` : line;
  } catch {
    return "";
  }
}

// 渲染当前 agent 卡片：完全复刻 pi 原生资源面板（[节标题] mdHeading 色 + dim 色缩进内容 + 节间空行）
function showAgentCard(ctx: ExtensionContext, agent: string): void {
  if (!ctx.hasUI) return;
  const repo = repoPath();
  if (!repo) return;
  const title = agentTitle(repo, agent);
  const skills = [
    ...readSkillNames(join(repo, "agents", agent, "skills")),
    ...readSkillNames(join(repo, "shared", "skills"), "共享"),
  ];
  const prompts = readPrompts(join(repo, "agents", agent, "prompts"));
  const memDir = join(repo, "memory", agent);
  const memCount = existsSync(memDir)
    ? readdirSync(memDir).filter((f) => f.endsWith(".md")).length
    : 0;

  ctx.ui.setWidget("agent-world", (_tui, theme) => {
    const section = (name: string, body: string) =>
      `${theme.fg("mdHeading", `[${name}]`)}\n${theme.fg("dim", `  ${body}`)}`;
    const sections = [section("Agent", title ? `${agent} — ${title}` : agent)];
    if (skills.length > 0) sections.push(section("Skills", skills.join(", ")));
    if (prompts.length > 0) sections.push(section("Prompts", prompts.join(", ")));
    sections.push(section("Memory", `${memCount} 个文件`));
    return new Text(sections.join("\n\n"), 0, 0);
  });
  ctx.ui.setStatus("agent-world", `agent: ${agent}`);
}

export default function (pi: ExtensionAPI) {
  // 启动时展示当前 agent 的能力卡片
  pi.on("session_start", async (_event, ctx) => {
    if (!repoPath()) return;
    showAgentCard(ctx, currentAgent());
  });

  // 每轮开始前，把当前 agent 的 SYSTEM.md 链式追加到系统提示词之后
  pi.on("before_agent_start", async (event) => {
    const repo = repoPath();
    if (!repo) return;
    const agent = currentAgent();
    const file = join(repo, "agents", agent, "SYSTEM.md");
    if (!existsSync(file)) return;
    const content = readFileSync(file, "utf-8").trim();
    if (!content) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  });

  // 技能/提示词/主题的加载已由 pi 声明式接管：内容仓库是标准 pi 包
  // （package.json 的 pi 清单 + settings.json 的 packages 条目），
  // 引擎不再经 resources_discover 动态报备。

  // /agent [name]：带参数直接切换；无参数时交互选择或报告当前 agent
  pi.registerCommand("agent", {
    description: "切换当前 agent；无参数时列出所有 agent 供选择",
    handler: async (args, ctx) => {
      const repo = repoPath();
      if (!repo) {
        ctx.ui.notify("未绑定内容仓库，请先 /agent-login", "warning");
        return;
      }
      const agents = scanAgents(repo);
      const name = (args ?? "").trim();
      if (name) {
        // agents 来自目录扫描，includes 校验同时起到防路径穿越作用
        if (!agents.includes(name)) {
          ctx.ui.notify(`未知 agent: ${name}（可用: ${agents.join(", ") || "无"}）`, "error");
          return;
        }
        saveConfig({ currentAgent: name });
        showAgentCard(ctx, name);
        ctx.ui.notify(`已切换到 agent: ${name}`, "info");
        return;
      }
      const current = currentAgent();
      if (!ctx.hasUI) {
        ctx.ui.notify(`当前 agent: ${current}`, "info");
        return;
      }
      if (agents.length === 0) {
        ctx.ui.notify(`当前 agent: ${current}（agents/ 下暂无可用 agent）`, "info");
        return;
      }
      const picked = await ctx.ui.select(`选择 agent（当前: ${current}）`, agents);
      if (!picked) return; // 用户取消，不做更改
      saveConfig({ currentAgent: picked });
      showAgentCard(ctx, picked);
      ctx.ui.notify(`已切换到 agent: ${picked}`, "info");
    },
  });
}
