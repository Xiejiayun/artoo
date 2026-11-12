# Skill discovery and search

The Skills page combines native `SKILL.md` metadata reported by each machine with Artoo's installed manifests. Search matches every whitespace-separated term across names, descriptions, runtimes, machine/agent names and project names. Installed capabilities also match their display names and common Chinese terms. Filters select source, runtime, project and installation state. The Agent page shows matching native skills and manifests per instance; its search includes their names and descriptions.

## Native inventory

The updated daemon reports the optional, versioned `native_skills` observation in each runtime's heartbeat. It reads:

- Codex: `$CODEX_HOME/skills` (default `~/.codex/skills`), `~/.agents/skills`, and `.agents/skills` / `.codex/skills` beneath explicitly allowed workspace roots.
- Claude Code: `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`) and `.claude/skills` beneath explicitly allowed workspace roots.
- Each skill directory's `SKILL.md`, including Codex's `.system` group. YAML frontmatter supplies the name and description.

Discovery reads at most 32 KiB of a manifest header, visits at most 1,024 entries and returns at most 128 skills per runtime, covering at most 32 configured workspace roots. It refreshes once per minute; the UI polls observations every ten seconds and exposes the observation time. No skill body, script or supporting file is uploaded or executed. Malformed metadata, unsupported links and inaccessible files are reported as incomplete discovery. Symbolic links/junctions are not traversed. Arbitrary workspace subdirectories and plugin caches are not searched; configure the actual project root in the node's allowlist to observe its workspace skills.

Native metadata is stored in the existing runtime JSON metadata and exposed by the authenticated computer runtime API. A missing optional inventory means discovery was not reported; an explicit empty inventory means a scan found no supported manifests. Older daemons must be restarted with the updated version. Offline/missing runtime observations retain their last known metadata and are labelled accordingly.

Native entries are matched to an instance by computer and runtime, with workspace skills restricted to their recorded root and descendants. This describes discovered files, not proof that CLI configuration has enabled them, that a task has loaded them or that tool access has been granted. Native discovery adds no scheduler capabilities and changes no execution policy.

## Artoo installations

An installed manifest is shown for an instance only when its runtime is compatible and the install is organization-wide or scoped to the instance's assigned project. Unknown/unassigned project membership does not expose another project's skills as matching. Legacy servers that do not report instance project membership show only organization-wide manifests as instance matches; project installs remain searchable under their project in the Skills page. The optional read-model field does not create membership or change assignment rules. Disabled installations remain visible with their disabled state. Registering a manifest retains the existing scheduler behavior; it does not install scripts, inject instructions or configure runtime tools.

The change covers discovery, API projection, search and instance association. External community registries, plugin-cache discovery and skill instruction delivery remain separate work. Controlled fixtures establish these paths; they do not establish live-provider skill invocation or product deployment.
