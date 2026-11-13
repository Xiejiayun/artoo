import type { AgentInstanceConfig } from "@artoo/protocol";

function importedValidationInstructions(config: AgentInstanceConfig): string[] {
  const context = config.runStart.context_pack.payload;
  if (context?.imported_clean_validation)
    return [
      "",
      "## Product validation after a clean node restart",
      "The current restart checkpoint contains unverified workspace bytes. Complete a fresh validation attempt against the original goal, accepted research/design, and every declared acceptance case and viewport.",
      "Use the protected workspace verification tool. Preserve the accepted research/design. Repair product defects and obtain a new complete final verification; a prior run or checkpoint does not prove this product passed.",
    ];
  if (context?.imported_clean_validation_review_subject)
    return [
      "",
      "## Independent product review after a clean node restart",
      "Review the entire current product against the original goal and accepted inputs using the pinned source and measured evidence. You have read-only tools.",
      "Return the required JSON verdict with review_id, validation_id, source_digest and subject_digest from imported_clean_validation_review_subject. Report every blocking finding and reject when one remains.",
    ];
  if (context?.imported_recovery_validation)
    return [
      "",
      "## Product validation after interrupted execution",
      "The current recovery checkpoint records unverified workspace bytes. Complete a new validation attempt against the original goal, accepted research/design, and every declared acceptance case and viewport.",
      "Inspect the current product and any supplied predecessor findings. You may repair product files, implementation notes, and the validation report. Preserve the exact accepted research.json and design.json bytes and protected measurement configuration.",
      "Run the node-owned verification tool and write a truthful .artoo/product/validation.json. Only the new final verifier and a new independent product review can establish completion; an earlier run result or checkpoint is not a passing result.",
    ];
  if (context?.imported_recovery_validation_review_subject)
    return [
      "",
      "## Independent product review after recovery",
      "Review the complete current product against the original goal, accepted plan, every acceptance criterion, complete new browser evidence, regression risks, and the validation report's accuracy.",
      "Use the workspace evidence index. The retained baseline files describe the actual workspace before this new validation author. Compare that baseline with current product source and the complete new final measurements.",
      "Return the required JSON verdict with review_id, validation_id, source_digest and subject_digest from imported_recovery_validation_review_subject. Report every blocking finding and reject when one remains. The checkpoint and prior interrupted run provide history, not proof that this product passed.",
    ];
  if (context?.imported_validation)
    return [
      "",
      "## Imported product validation",
      "Validate the complete final product against the original goal, accepted research/design, and every declared acceptance case and viewport.",
      "You may repair product files, implementation notes, and the validation report. Preserve the exact accepted research.json and design.json bytes, requirements, measurement programs, and protected configuration.",
      "Use the supplied prior review findings or typed failure feedback to guide repairs, and run the node-owned verification tool before completing. The independent final verifier and full product review decide completion.",
      "Write a truthful .artoo/product/validation.json that describes the actual final product and outcomes. A report alone does not establish a passing product.",
    ];
  if (context?.imported_validation_review_subject)
    return [
      "",
      "## Independent final product review",
      "Review the complete final product, original goal and accepted plan, all acceptance criteria, measured behavior, regression risks, and validation report truthfulness.",
      "Use the workspace evidence index. baseline.directories and baseline.files[].reference expose retained actual files from before the validation author; read those references to assess changes alongside current product source and complete final browser evidence.",
      "Reviewing only validation.json is insufficient. Read-only tools cannot change the product. Return the required JSON verdict with validation_id, source_digest and subject_digest from imported_validation_review_subject; reject when any blocking finding remains.",
    ];
  return [];
}
export function renderContextPack(config: AgentInstanceConfig): string {
  const pack = config.runStart.context_pack;
  const lines: string[] = [`# Context Pack ${pack.id}`, `task: ${config.taskId}`, `run: ${config.runId}`];
  if (pack.uri) {
    lines.push(`uri: ${pack.uri}`);
  }
  if (pack.payload) {
    lines.push(
      "",
      "## Task",
      `id: ${pack.payload.task.id}`,
      `title: ${pack.payload.task.title}`,
      `description: ${pack.payload.task.description}`,
      "acceptance_criteria:",
      ...pack.payload.task.acceptance_criteria.map((criterion) => `- ${criterion}`),
      "",
      "## Project",
      `id: ${pack.payload.project.id}`,
      `name: ${pack.payload.project.name}`,
      `default_workspace: ${pack.payload.project.default_workspace ?? ""}`,
      "",
      "## Workspace",
      `root: ${pack.payload.workspace.root}`,
      "file_scope:",
      ...pack.payload.workspace.file_scope.map((scope) => `- ${scope}`),
      "",
      "## Policy",
      "filesystem_write_scope:",
      ...pack.payload.policy.filesystem_write_scope.map((scope) => `- ${scope}`),
      "requires_approval:",
      ...pack.payload.policy.requires_approval.map((approval) => `- ${approval}`),
      "",
      "## Memory",
      `task_summary: ${pack.payload.memory.task_summary ?? ""}`,
      "project_notes:",
      ...pack.payload.memory.project_notes.map((note) => `- ${note}`),
      "",
      "## Expected Artifacts",
      ...pack.payload.artifacts.expected.map((artifact) => `- ${artifact}`),
      "",
      "## Raw Payload",
      JSON.stringify(pack.payload, null, 2),
    );
  }
  lines.push(...importedValidationInstructions(config));
  return `${lines.join("\n")}\n`;
}

/** MCP pages carry every payload field once; legacy context files keep their original rendering. */
export function renderWorkspaceToolContext(config: AgentInstanceConfig): string {
  const pack = config.runStart.context_pack;
  const lines = [`# Context Pack ${pack.id}`, `task: ${config.taskId}`, `run: ${config.runId}`];
  if (pack.uri) lines.push(`uri: ${pack.uri}`);
  if (pack.payload) lines.push("", "## Raw Payload", JSON.stringify(pack.payload));
  lines.push(...importedValidationInstructions(config));
  return `${lines.join("\n")}\n`;
}
