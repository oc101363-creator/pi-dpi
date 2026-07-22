/**
 * extension-gate：per-agent 扩展加载的启动自愈门闸。
 *
 * 机制：pi 的 settings.json packages 条目支持
 * { source, extensions: [...] } 对象形式，extensions 是白名单过滤器（按包内
 * 相对路径匹配），过滤发生在 jiti import 之前——被过滤的扩展文件根本不会执行，
 * 这是 dpi 的扩展真隔离机制。本扩展在 session_start 时调用
 * syncExtensionFilter(loadConfig())，把 settings.json 里内容包条目的过滤器
 * 重写为当前 agent 在 agent.json.extensions 中声明的白名单。
 *
 * 边界：改写 settings.json 后，要下一次 ctx.reload()（或重启 pi）重读 settings
 * 才生效——事件 hook 的 ctx 没有 reload，本次会话维持现状；启动自愈的意义在于
 * agent.json 被外部编辑/同步（/sync 拉取）后，过滤器也能在下一次重载后收敛。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, syncExtensionFilter } from "../src/config.ts";

export default function (pi: ExtensionAPI) {
  // 启动自愈：让内容包的 extensions 过滤器与当前 agent 声明对齐（幂等，无改动不写盘）
  pi.on("session_start", async () => {
    syncExtensionFilter(loadConfig());
  });
}
