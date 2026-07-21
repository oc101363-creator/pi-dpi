/**
 * guardrails：安全护栏（原样移植自旧内容仓库 extensions/guardrails.ts）。
 *
 * 全局生效，不随 agent 切换变化，也不读 dpi 配置：
 * - bash 危险命令（rm -rf /、sudo、mkfs）：有 UI 弹确认，无 UI 默认拦截
 * - write/edit 写入受保护路径（.env、node_modules/、.git/）：直接拦截
 */
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED_PATTERNS = [/rm\s+-rf\s+\/(?:\s|$)/, /\bsudo\b/, /\bmkfs\b/];
const PROTECTED_PATHS = [".env", "node_modules/", ".git/"];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      if (BLOCKED_PATTERNS.some((p) => p.test(cmd))) {
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm("危险命令", `允许执行？\n${cmd}`);
          if (!ok) return { block: true, reason: "被 guardrails 拦截" };
        } else {
          return { block: true, reason: "危险命令，无 UI 无法确认，默认拦截" };
        }
      }
    }
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      if (PROTECTED_PATHS.some((p) => event.input.path.includes(p))) {
        return { block: true, reason: `受保护路径: ${event.input.path}` };
      }
    }
  });
}
