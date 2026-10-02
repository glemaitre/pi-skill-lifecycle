/**
 * Pi Skill Lifecycle — OpenCode-style skill loading for Pi.
 *
 * - The prompt's `skills` section lists each skill by name, description, and
 *   location, plus a short protocol: load bodies with the `skill` tool, route
 *   ambiguous requests through an optional entry skill, and treat stop
 *   conditions as binding.
 * - The `skill` tool returns a skill body (without frontmatter) wrapped in
 *   `<skill_content>`. Direct `read` calls on a known SKILL.md are blocked so
 *   every body goes through the tool and its lifecycle.
 * - Before each LLM request, superseded or evicted skill bodies are replaced
 *   with a short placeholder. The session keeps the original results, so the
 *   replacement is request-local and reversible.
 *
 * Commands: /skills-pin, /skills-unpin, /skills-list, /skills-reload,
 *           /skills-on, /skills-off
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Skill as PiSkill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { EngineConfig, Skill } from "./rules.ts";
import {
  buildPlaceholder,
  CONFIG_FILENAME,
  configWithDefaults,
  extractSkillNameFromContent,
  fingerprintPrompt,
  isMinorChange,
  selectBodiesToEvict,
} from "./rules.ts";

const SKILL_TOOL = "skill";

/**
 * Config locations, lowest precedence first: the user agent directory
 * (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), then the project `.pi` directory.
 * The project file is read only when the project is trusted, like the rest
 * of Pi's project configuration.
 */
export function configPaths(cwd: string): { user: string; project: string } {
  return {
    user: path.join(getAgentDir(), CONFIG_FILENAME),
    project: path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME),
  };
}
const MAX_LISTED_FILES = 10;

// ── Rendering ─────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Content of the `skills` prompt section. Pi wraps it in `<skills>…</skills>`.
 * It must not depend on per-turn state (loaded or pinned bodies): a changing
 * section would add a prompt delta on every turn and defeat prompt caching.
 */
export function renderSkillsSection(skills: PiSkill[], entrySkill: string | undefined): string {
  const visible = skills.filter((s) => !s.disableModelInvocation).sort((a, b) => a.name.localeCompare(b.name));
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    `Load a skill with the ${SKILL_TOOL} tool, e.g. \`${SKILL_TOOL}("<name>")\`, when a task matches its description. Do not read SKILL.md files directly.`,
    "",
    "Skill protocol:",
    "- If the request clearly matches one skill, load it and follow its instructions.",
    ...(entrySkill
      ? [`- If the request is ambiguous, a stage just finished, or the user asks what to do next, load \`${SKILL_TOOL}("${entrySkill}")\` first.`]
      : []),
    "- Stop conditions in a skill are binding: when one says STOP, stop and follow its redirect instead of continuing its procedure.",
    "- Files a skill references (scripts/, references/, templates/) are relative to its base directory; read them with the read tool.",
    `- An archived skill body is shown as a placeholder; call the ${SKILL_TOOL} tool again to reload it.`,
    "",
    "<available_skills>",
    ...visible.flatMap((s) => [
      "  <skill>",
      `    <name>${escapeXml(s.name)}</name>`,
      `    <description>${escapeXml(s.description)}</description>`,
      `    <location>${escapeXml(s.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}

// ── Message helpers ───────────────────────────────────────────────

/** Name of the skill whose body a message carries, if it is a successful skill-tool result. */
function skillResultName(message: any): string | null {
  if (message?.role !== "toolResult" || message.toolName !== SKILL_TOOL || message.isError) return null;
  if (!Array.isArray(message.content)) return null;
  return extractSkillNameFromContent(message.content);
}

function toPureSkill(s: PiSkill): Skill {
  return {
    name: s.name,
    description: s.description,
    filePath: s.filePath,
    baseDir: s.baseDir,
    disableModelInvocation: s.disableModelInvocation,
  };
}

// ── Extension ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  /** Skills Pi discovered, refreshed on every run (handles /reload). */
  let skillsByName = new Map<string, PiSkill>();
  /** Loaded skill bodies: name → load sequence number (higher = more recent). */
  const loaded = new Map<string, number>();
  let seq = 0;
  /** Pins from the config file and from /skills-pin, kept apart so reloads only reset the former. */
  let configPins = new Set<string>();
  const userPins = new Set<string>();
  let enabled = true;
  let config = configWithDefaults();
  /** Config files that were read, for /skills-list. */
  let configSources: string[] = [];
  let prevFingerprint: ReturnType<typeof fingerprintPrompt> | undefined;

  const pinned = () => new Set([...configPins, ...userPins]);
  const skillToolActive = () => pi.getActiveTools().includes(SKILL_TOOL);

  function markLoaded(name: string) {
    loaded.delete(name);
    loaded.set(name, ++seq);
  }

  /** Read one config file; undefined when it is missing or invalid (invalid files are reported). */
  async function readConfigFile(file: string, ctx: ExtensionContext): Promise<EngineConfig | undefined> {
    let text: string;
    try {
      text = await readFile(file, "utf-8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") warn(ctx, `cannot read ${file}: ${err?.message ?? err}`);
      return undefined;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as EngineConfig;
      warn(ctx, `ignoring ${file}: expected a JSON object`);
    } catch (err: any) {
      warn(ctx, `ignoring invalid ${file}: ${err?.message ?? err}`);
    }
    return undefined;
  }

  function warn(ctx: ExtensionContext, message: string) {
    if (ctx.hasUI) ctx.ui.notify(`skill-lifecycle: ${message}`, "warning");
  }

  /** Merge the user and project config files; project keys override user keys. */
  async function reloadConfig(ctx: ExtensionContext): Promise<void> {
    const paths = configPaths(ctx.cwd);
    const user = await readConfigFile(paths.user, ctx);
    let project: EngineConfig | undefined;
    if (ctx.isProjectTrusted()) {
      project = await readConfigFile(paths.project, ctx);
    } else if (await readFile(paths.project).then(() => true, () => false)) {
      warn(ctx, `${paths.project} is ignored until the project is trusted`);
    }
    configSources = [user && paths.user, project && paths.project].filter((p): p is string => !!p);
    config = configWithDefaults({ ...user, ...project });
    configPins = new Set(config.pinned.map((name) => name.toLowerCase()));
  }

  /** Rebuild the loaded-body state from the active session branch (resume, fork, /tree). */
  function rebuildFromBranch(ctx: ExtensionContext) {
    loaded.clear();
    let entries: any[] = [];
    try {
      entries = ctx.sessionManager.getBranch();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry?.type !== "message") continue;
      const name = skillResultName(entry.message);
      if (name) markLoaded(name);
    }
  }

  // ── Session events ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    await reloadConfig(ctx);
    prevFingerprint = undefined;
    rebuildFromBranch(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    rebuildFromBranch(ctx);
  });

  // ── Prompt section and eviction ─────────────────────────────────

  pi.on("before_agent_start", (event, ctx) => {
    skillsByName = new Map(event.systemPromptOptions.skills.map((s) => [s.name, s]));

    // Without the skill tool, keep Pi's default listing (which tells the model to use read).
    if (!skillToolActive()) return;

    const entry = config.entrySkill && skillsByName.has(config.entrySkill) ? config.entrySkill : undefined;
    // A custom section named `skills` replaces Pi's built-in skills section.
    event.systemPromptOptions.sections.skills = renderSkillsSection([...skillsByName.values()], entry);

    const minor = isMinorChange(event.prompt, prevFingerprint, config);
    prevFingerprint = fingerprintPrompt(event.prompt);
    if (!enabled || loaded.size === 0 || minor) return;

    const evicted = selectBodiesToEvict(
      event.prompt,
      [...loaded].map(([name, n]) => ({ name, seq: n })),
      new Map([...skillsByName].map(([name, s]) => [name, toPureSkill(s)])),
      pinned(),
      config,
    );
    for (const body of evicted) loaded.delete(body.name);

    if (config.verbose && evicted.length > 0 && ctx.hasUI) {
      const lines = evicted.map((b) => `  ${b.name} (${(b.score * 100).toFixed(0)}%) — ${b.reason}`);
      ctx.ui.notify(`🧹 Archived skill bodies: ${evicted.map((b) => b.name).join(", ")}\n${lines.join("\n")}`, "info");
    }
  });

  /**
   * Request-local: keep only the latest copy of each loaded body; replace
   * older copies and evicted bodies with a placeholder.
   */
  pi.on("context", (event) => {
    if (!enabled) return;

    const latest = new Map<string, number>();
    event.messages.forEach((message, index) => {
      const name = skillResultName(message);
      if (name) latest.set(name, index);
    });
    if (latest.size === 0) return;

    let changed = false;
    const messages = event.messages.map((message, index) => {
      const name = skillResultName(message);
      if (!name || (latest.get(name) === index && loaded.has(name))) return message;
      changed = true;
      return { ...message, content: [{ type: "text" as const, text: buildPlaceholder(name) }] };
    });
    return changed ? { messages } : undefined;
  });

  /** Route direct SKILL.md reads through the skill tool. Reads of referenced files stay allowed. */
  pi.on("tool_call", (event, ctx) => {
    if (!config.blockDirectSkillReads || event.toolName !== "read" || !skillToolActive()) return;
    const requested = (event.input as { path?: unknown }).path;
    if (typeof requested !== "string") return;

    const expanded = requested.startsWith("~/") ? path.join(homedir(), requested.slice(2)) : requested;
    const target = path.resolve(ctx.cwd, expanded);
    for (const skill of skillsByName.values()) {
      if (skill.disableModelInvocation || path.resolve(skill.filePath) !== target) continue;
      return {
        block: true,
        reason: `Load this skill with the ${SKILL_TOOL} tool instead: ${SKILL_TOOL}("${skill.name}")`,
      };
    }
  });

  // ── Skill tool ──────────────────────────────────────────────────

  pi.registerTool({
    name: SKILL_TOOL,
    label: "Skill",
    description: [
      "Load a skill's full instructions by name.",
      "Use it when a task matches a skill in <available_skills>. Returns the skill body, its base directory, and its top-level files.",
    ].join("\n"),
    promptSnippet: "Load a skill's instructions by name (instead of reading SKILL.md)",
    parameters: Type.Object({
      name: Type.String({ description: "The skill name from <available_skills>" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const skill = skillsByName.get(params.name);
      if (!skill) {
        const available = [...skillsByName.values()]
          .filter((s) => !s.disableModelInvocation)
          .map((s) => s.name)
          .join(", ");
        throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`);
      }
      if (skill.disableModelInvocation) {
        throw new Error(`Skill "${skill.name}" can only be invoked by the user with /skill:${skill.name}`);
      }

      const body = stripFrontmatter(await readFile(skill.filePath, "utf-8")).trim();
      const dir = skill.baseDir || path.dirname(skill.filePath);
      let files: string[] = [];
      try {
        files = (await readdir(dir, { withFileTypes: true }))
          .filter((e) => e.name !== "SKILL.md" && !e.name.startsWith("."))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, MAX_LISTED_FILES)
          .map((e) => path.join(dir, e.name) + (e.isDirectory() ? "/" : ""));
      } catch {
        // A missing listing is not fatal; the body is what matters.
      }

      markLoaded(skill.name);
      if (config.verbose && ctx.hasUI) {
        ctx.ui.notify(`📖 Loaded skill: ${skill.name} (${(body.length / 1024).toFixed(1)} KB)`, "info");
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `<skill_content name="${escapeXml(skill.name)}">`,
              `# Skill: ${skill.name}`,
              "",
              body,
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill are relative to this base directory.",
              ...(files.length > 0
                ? ["", "<skill_files>", ...files.map((f) => `  <file>${escapeXml(f)}</file>`), "</skill_files>"]
                : []),
              "</skill_content>",
            ].join("\n"),
          },
        ],
        details: undefined,
      };
    },
  });

  // ── Commands ────────────────────────────────────────────────────

  pi.registerCommand("skills-pin", {
    description: "Pin a skill so its body is never archived: /skills-pin <name>",
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      if (!name) return ctx.ui.notify("Usage: /skills-pin <skill-name>", "warning");
      userPins.add(name);
      ctx.ui.notify(`📌 Pinned: ${name}`, "info");
    },
  });

  pi.registerCommand("skills-unpin", {
    description: "Unpin a skill: /skills-unpin <name>",
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      if (!name) return ctx.ui.notify("Usage: /skills-unpin <skill-name>", "warning");
      if (configPins.has(name)) {
        return ctx.ui.notify(`${name} is pinned in ${configSources.join(" or ")}; remove it there`, "warning");
      }
      if (!userPins.delete(name)) return ctx.ui.notify(`Skill not pinned: ${name}`, "warning");
      ctx.ui.notify(`📍 Unpinned: ${name}`, "info");
    },
  });

  pi.registerCommand("skills-list", {
    description: "Show known skills and their loaded/pinned status",
    handler: async (_args, ctx) => {
      const pins = pinned();
      const lines = [...skillsByName.values()].map((s) => {
        const marks = `${pins.has(s.name) ? " 📌" : ""}${loaded.has(s.name) ? " 📖" : ""}${s.disableModelInvocation ? " (command only)" : ""}`;
        return `  ${s.name}${marks}`;
      });
      ctx.ui.notify(
        [
          `Skills (${skillsByName.size}) — eviction ${enabled ? "on" : "off"}; loaded: ${[...loaded.keys()].join(", ") || "none"}`,
          ...(skillsByName.size === 0 ? ["  (list is filled on the first prompt)"] : lines),
          "📌 pinned   📖 body loaded",
          `Config: ${configSources.join(" + ") || "defaults"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("skills-reload", {
    description: `Reload ${CONFIG_FILENAME} from the user and project config directories`,
    handler: async (_args, ctx) => {
      await reloadConfig(ctx);
      ctx.ui.notify(`🔄 Config: ${configSources.join(" + ") || "defaults (no config file)"}`, "info");
    },
  });

  pi.registerCommand("skills-on", {
    description: "Enable archiving of irrelevant skill bodies (default)",
    handler: async (_args, ctx) => {
      enabled = true;
      ctx.ui.notify("🟢 Skill body archiving enabled", "info");
    },
  });

  pi.registerCommand("skills-off", {
    description: "Disable archiving; keep every loaded skill body in context",
    handler: async (_args, ctx) => {
      enabled = false;
      ctx.ui.notify("🔴 Skill body archiving disabled", "info");
    },
  });
}
