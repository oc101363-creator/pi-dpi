/**
 * superpowers：按当前 agent 注入 superpowers bootstrap（移植自官方 .pi/extensions/superpowers.ts）。
 *
 * 与官方版的差异只在「作用域」：官方版全局注入；dpi 版跟随当前激活 agent——
 * 仅当 <repoPath>/agents/<currentAgent>/skills/using-superpowers/SKILL.md 存在时注入，
 * 即「哪个 agent 拥有超能力」完全由内容仓库的目录结构决定（目录结构即配置）。
 *
 * 注入机制与官方一致：context 事件改消息数组，session_start/session_compact 重新武装，
 * agent_end 后停火；技能本体一个字不改，仅追加 pi 工具映射说明。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const EXTREMELY_IMPORTANT_MARKER = "<EXTREMELY_IMPORTANT>";
const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for pi (dpi)";

// 缓存键：bootstrap 文件路径（agent 切换后路径变化，缓存自动失效）
let cachedPath: string | null = null;
let cachedBootstrap: string | null = null;

// 当前 agent 的 bootstrap 文件路径；未绑定/无此技能返回 null
function bootstrapSkillPath(): string | null {
  const cfg = loadConfig();
  if (!cfg.repoUrl) return null;
  const agent = /^[\w-]+$/.test(cfg.currentAgent) ? cfg.currentAgent : "coder";
  const path = join(cfg.repoPath, "agents", agent, "skills", "using-superpowers", "SKILL.md");
  return existsSync(path) ? path : null;
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (match ? match[1] : content).trim();
}

// 官方 pi 工具映射（原文保留）：把技能里的动作词汇翻译为 pi 原生工具
function piToolMapping(): string {
  return `## Pi tool mapping

Pi has native skills but does not expose Claude Code's \`Skill\` tool. When a Superpowers instruction says to invoke a skill, use Pi's native skill system instead: load the relevant \`SKILL.md\` with \`read\` when the skill applies, or let a human invoke \`/skill:name\` explicitly.

Pi's built-in coding tools are lowercase: \`read\`, \`write\`, \`edit\`, \`bash\`, plus optional \`grep\`, \`find\`, and \`ls\`. Use those for the corresponding actions: read a file, create or edit files, run shell commands, search file contents, find files by name, and list directories.

Pi does not ship a standard subagent tool. If a subagent tool such as \`subagent\` from \`pi-subagents\` is available, use it for Superpowers subagent workflows. If no subagent tool is available, do the work in this session or explain the missing capability instead of inventing \`Task\` calls.

Pi does not ship a standard task-list tool. If an installed todo/task tool is available, use it. Otherwise track work in plan files or a repo-local \`TODO.md\` when task tracking is needed. Treat older \`TodoWrite\` references as this task-tracking action.`;
}

function getBootstrapContent(): string | null {
  const path = bootstrapSkillPath();
  if (!path) return null;
  if (cachedPath === path && cachedBootstrap !== null) return cachedBootstrap;
  try {
    const body = stripFrontmatter(readFileSync(path, "utf8"));
    const text = `${EXTREMELY_IMPORTANT_MARKER}
${BOOTSTRAP_MARKER}

You have superpowers.

The using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.

${body}

${piToolMapping()}
${EXTREMELY_IMPORTANT_MARKER}`;
    cachedPath = path;
    cachedBootstrap = text;
    return text;
  } catch {
    return null;
  }
}

function messageContainsBootstrap(message: unknown): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      (part as { text: string }).text.includes(BOOTSTRAP_MARKER),
  );
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
  let index = 0;
  while ((messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary") {
    index += 1;
  }
  return index;
}

export default function superpowersDpiExtension(pi: ExtensionAPI) {
  let injectBootstrap = true;

  pi.on("session_start", async () => {
    injectBootstrap = true;
  });

  pi.on("session_compact", async () => {
    injectBootstrap = true;
  });

  pi.on("agent_end", async () => {
    injectBootstrap = false;
  });

  pi.on("context", async (event) => {
    if (!injectBootstrap) return;
    if (event.messages.some(messageContainsBootstrap)) return;

    const bootstrap = getBootstrapContent();
    if (!bootstrap) return;

    const bootstrapMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: bootstrap }],
      timestamp: Date.now(),
    };

    const insertAt = firstNonCompactionSummaryIndex(event.messages);
    return {
      messages: [
        ...event.messages.slice(0, insertAt),
        bootstrapMessage,
        ...event.messages.slice(insertAt),
      ],
    };
  });
}
