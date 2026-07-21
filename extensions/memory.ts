/**
 * memory：分 agent 长期记忆（移植自旧内容仓库 extensions/memory.ts）。
 *
 * - before_agent_start：注入当前 agent 的记忆索引（渐进披露：索引常驻，
 *   正文由 LLM 用 read 工具按需读取）
 * - memory_write 工具：把一行事实追加到 <repoPath>/memory/<当前agent>/<file>，
 *   归一化并防御路径穿越
 *
 * 记忆根目录为内容仓库的 memory/（config.repoPath）；未绑定时注入 no-op。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

// 记忆根目录：未绑定内容仓库时返回 null
function memoryRoot(): string | null {
  const cfg = loadConfig();
  return cfg.repoUrl ? join(cfg.repoPath, "memory") : null;
}

// 从配置读当前 agent 名，防穿越：只允许纯目录名
function currentAgent(): string {
  const { currentAgent } = loadConfig();
  return /^[\w-]+$/.test(currentAgent) ? currentAgent : "coder";
}

export default function (pi: ExtensionAPI) {
  // 每轮开始前注入当前 agent 的记忆索引
  pi.on("before_agent_start", async () => {
    const root = memoryRoot();
    if (!root) return;
    const agent = currentAgent();
    const dir = join(root, agent);
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return;
    const index = files.map((f) => `- ${f}`).join("\n");
    return {
      message: {
        customType: "memory-index",
        content: `当前 agent：${agent}。长期记忆（正文位于 memory/${agent}/ 目录下，用 read 工具按需读取；写记忆用 memory_write 工具，file 参数只传文件名本身，例如 user.md）：\n${index}`,
        display: false,
      },
    };
  });

  // 让 LLM 能主动写记忆
  pi.registerTool({
    name: "memory_write",
    label: "Write Memory",
    description: "Append a durable note to a long-term memory markdown file",
    parameters: Type.Object({
      file: Type.String({ description: "Memory file name, e.g. user.md" }),
      note: Type.String({ description: "One-line note to append" }),
    }),
    async execute(_toolCallId, params) {
      const root = memoryRoot();
      if (!root) throw new Error("未绑定内容仓库，无法写记忆（请先 /agent-login）");
      const agent = currentAgent();
      // 归一化：容忍模型传入 "memory/user.md" 或 "<agent>/user.md"，最终只允许纯文件名，并防御路径穿越
      let name = params.file;
      if (name.startsWith("memory/")) name = name.slice("memory/".length);
      if (name.startsWith(`${agent}/`)) name = name.slice(agent.length + 1);
      if (name.includes("/") || name.includes("..") || !name.endsWith(".md")) {
        throw new Error(`非法记忆文件名: ${params.file}，只允许形如 user.md 的文件名`);
      }
      const dir = join(root, agent);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, name), `- ${params.note}\n`);
      return {
        content: [{ type: "text", text: `已写入 memory/${agent}/${name}` }],
        details: {},
      };
    },
  });
}
