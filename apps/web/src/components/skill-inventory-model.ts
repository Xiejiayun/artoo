import type { AgentInstance, AgentRuntime, Capability, Computer, NativeSkill, SkillInstall } from "@artoo/domain";
import { CAPABILITY_LABELS } from "./taskPresentation.js";

const aliases: Record<Capability, string> = {
  "code.read": "阅读代码 代码分析", "code.modify": "编写代码 修改代码 开发 编程", "code.review": "代码审查 评审",
  "test.run": "运行测试 测试 验证", "git.patch": "补丁 版本控制", "github.pr": "拉取请求 合并请求",
  "browser.navigate": "浏览器 网页", "browser.extract": "网页提取 抓取", "desktop.operate": "桌面操作",
  "doc.write": "文档 写作", "research.web": "网络调研 搜索 研究", "shell.run": "命令 终端 脚本",
};
export function matchesSkillSearch(search: string, ...values: (string | null | undefined)[]): boolean {
  const normalize = (value: string): string => value.normalize("NFKC").toLocaleLowerCase();
  const haystack = normalize(values.filter(Boolean).join(" "));
  return normalize(search).trim().split(/\s+/u).every((word) => haystack.includes(word));
}
export function skillInstallSearchText(skill: SkillInstall): string {
  return [skill.name, skill.skill_id, skill.manifest.description, ...skill.compatible_runtimes,
    ...skill.capabilities.flatMap((capability) => [capability, CAPABILITY_LABELS[capability], aliases[capability]])].join(" ");
}
export interface NativeSkillEntry { skill: NativeSkill; runtime: AgentRuntime; computer: Computer }

function normalizedPath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^(?:[a-z]:|\/\/)/i.test(path) ? path.toLocaleLowerCase() : path;
}
export function nativeSkillMatchesInstance(entry: NativeSkillEntry, instance: AgentInstance): boolean {
  if (entry.runtime.computer_id !== instance.computer_id || entry.runtime.runtime !== instance.runtime) return false;
  if (entry.skill.scope === "user") return true;
  if (!entry.skill.workspace_root || !instance.workspace_root) return false;
  const root = normalizedPath(entry.skill.workspace_root), workspace = normalizedPath(instance.workspace_root);
  return workspace === root || workspace.startsWith(root + "/");
}
export function skillInstallMatchesInstance(skill: SkillInstall, instance: AgentInstance): boolean {
  return skill.compatible_runtimes.includes(instance.runtime)
    && (skill.project_id == null || skill.project_id === instance.project_id);
}
