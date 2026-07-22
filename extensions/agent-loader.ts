/**
 * agent-loader：当前 agent 解析（移植自旧内容仓库 extensions/agent-loader.ts）。
 *
 * - session_start：渲染当前 agent 的能力卡片（复刻 pi 原生面板样式）+ 底栏状态
 * - before_agent_start：把 agents/<当前agent>/SYSTEM.md 链式注入系统提示词
 * - resources_discover：按当前 agent 的 agent.json 声明，从仓库根 skills/ 注册表
 *   返回该 agent 的技能目录（技能隔离的裁决点：未声明的技能不进会话）+
 *   agents/<agent>/prompts
 * - /agent [name]：查看/交互或直接切换当前 agent（写入 dpi 配置 + ctx.reload() 让新技能生效）
 *
 * 内容仓库路径全部来自 dpi 配置（config.repoPath）；未绑定时所有 hook 静默 no-op。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, readAgentManifest, saveConfig, scanAgents } from "../src/config.ts";

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

// 列出提示词模板（xxx.md → /xxx）
function readPrompts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `/${f.replace(/\.md$/, "")}`)
    .sort();
}

// 取 SYSTEM.md 首行非标题、非空文本作为 agent 一句话简介（agent.json 无 description 时的回退）
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
  const manifest = readAgentManifest(repo, agent);
  const title = manifest.description ?? agentTitle(repo, agent);
  // 技能列表来自 agent.json 声明，逐一校验注册表 skills/<name>/SKILL.md 存在
  const skills = manifest.skills.filter((name) =>
    existsSync(join(repo, "skills", name, "SKILL.md")),
  );
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

  // 技能发现的裁决点：只返回当前 agent 在 agent.json 里声明的技能
  // （从仓库根 skills/ 注册表逐一校验存在性），外加该 agent 的 prompts 目录。
  // 未声明的技能不进会话——这是 dpi 技能隔离的实现机制。
  pi.on("resources_discover", async () => {
    const repo = repoPath();
    if (!repo) return {};
    const agent = currentAgent();
    const manifest = readAgentManifest(repo, agent);
    const skillPaths = manifest.skills
      .map((name) => join(repo, "skills", name))
      .filter((dir) => existsSync(join(dir, "SKILL.md")));
    const promptPaths: string[] = [];
    const promptsDir = join(repo, "agents", agent, "prompts");
    if (existsSync(promptsDir)) promptPaths.push(promptsDir);
    return { skillPaths, promptPaths };
  });

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
        ctx.ui.notify(`已切换到 agent: ${name}，正在重载资源…`, "info");
        // 重载让 resources_discover 按新 agent 的声明重新发现技能
        await ctx.reload();
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
      ctx.ui.notify(`已切换到 agent: ${picked}，正在重载资源…`, "info");
      await ctx.reload();
    },
  });
}
