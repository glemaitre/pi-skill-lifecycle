/**
 * Pi Skill Lifecycle — Dynamic skill body loading and unloading.
 *
 * All skills are always advertised to the model by name and description.
 * Only the expensive body (SKILL.md + reference files) loaded via the
 * `skill` tool is managed — irrelevant bodies are replaced with a
 * lightweight placeholder before each model request.
 *
 * Install:  pi --extension ./extensions/index.ts
 * Package:  pi install ./pi-skill-lifecycle
 *
 * Commands:
 *   /skills-pin <name>      — Pin a skill so its body is never evicted
 *   /skills-unpin <name>    — Unpin a skill
 *   /skills-list            — Show all known skills and loaded/pinned status
 *   /skills-reload          — Reload config file from disk
 *   /skills-on              — Enable automatic body eviction (default)
 *   /skills-off             — Disable automatic body eviction
 */

import type { ExtensionAPI, Skill as PiSkill } from "@earendil-works/pi-coding-agent";
import type { Skill, EngineConfig, RelevanceRule } from "./rules.ts";
import { Type } from "typebox";
import {
  configWithDefaults,
  CONFIG_FILENAME,
  scoreRelevance,
  extractSkillNameFromContent,
  buildPlaceholder,
} from "./rules.ts";

// ── Extension ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── State ───────────────────────────────────────────────────────

  /** All skills we've ever seen, for `/skills-list` and config reloads. */
  let allKnownSkills: PiSkill[] = [];

  /** Pinned skill names (lowercase) — bodies are never evicted. */
  const pinned = new Set<string>();

  /**
   * Skill bodies that are currently loaded in the conversation.
   * Skill name → timestamp when loaded.
   * Skills NOT in this set that appear as `<skill_content>` in messages
   * will have their content replaced with a placeholder.
   */
  const loadedSkillBodies = new Map<string, number>();

  /** Whether automatic body eviction is enabled. */
  let enabled = true;

  /** Current config (lazy-loaded from file + defaults). */
  let config: ReturnType<typeof configWithDefaults> = configWithDefaults();

  /** Custom rules from config file, keyed by skill name. */
  let customRules: RelevanceRule[] = [];

  /** Cached workspace root. */
  let workspaceRoot = "";

  /** Last prompt, stored for the `context` handler's notification. */
  let lastPrompt = "";

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * Convert Pi's Skill type to our pure `Skill` type.
   */
  function toPureSkill(s: PiSkill): Skill {
    return {
      name: s.name,
      description: s.description,
      filePath: s.filePath,
      baseDir: s.baseDir,
      disableModelInvocation: s.disableModelInvocation,
    };
  }

  /**
   * Reload config from the workspace's `skill-lifecycle.json`.
   * Merges file config with defaults and updates the pinned set.
   */
  async function reloadConfig(cwd: string): Promise<void> {
    workspaceRoot = cwd;
    try {
      const fs = await import("node:fs/promises");
      const configPath = `${cwd}/${CONFIG_FILENAME}`;
      const content = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(content) as EngineConfig;
      config = configWithDefaults(parsed);
      customRules = config.rules;
      // Merge file pins with user-set pins (user pins take precedence)
      for (const name of config.pinned) {
        pinned.add(name.toLowerCase());
      }
    } catch {
      // No config file — use defaults
      config = configWithDefaults();
      customRules = [];
    }
  }

  /**
   * Score all loaded (non-pinned) skill bodies against the current prompt
   * and evict those that fall below the relevance threshold.
   *
   * This runs at the start of each user turn (in `before_agent_start`).
   * The actual body-content replacement happens in the `context` handler.
   */
  function evictIrrelevantBodies(
    prompt: string,
    skills: PiSkill[],
    notify: (message: string, type?: "error" | "info" | "warning") => void,
  ): void {
    if (!enabled || loadedSkillBodies.size === 0) return;

    const evicted: Array<{ name: string; score: number; reason: string }> = [];

    for (const skill of skills) {
      if (!loadedSkillBodies.has(skill.name)) continue;
      if (pinned.has(skill.name)) continue; // never evict pinned bodies

      const { score, reason } = scoreRelevance(prompt, toPureSkill(skill), customRules);

      if (score < config.threshold) {
        evicted.push({ name: skill.name, score, reason });
      }
    }

    if (evicted.length === 0) {
      // Nothing evicted, but still show a status summary if bodies are loaded
      if (config.verbose && loadedSkillBodies.size > 0) {
        const names = [...loadedSkillBodies.keys()].join(", ");
          notify(
          `📚 Skill bodies loaded: ${names}`,
          "info",
        );
      }
      return;
    }

    // Remove evicted bodies from our tracking set
    for (const s of evicted) {
      loadedSkillBodies.delete(s.name);
    }

    // Notify
    if (config.verbose) {
      const lines = evicted.map((s) =>
        `  ${s.name} (${(s.score * 100).toFixed(0)}%) — ${s.reason}`
      );
      notify(
        `🧹 Archived skill bod${evicted.length === 1 ? "y" : "ies"}: ${evicted.map((s) => s.name).join(", ")}\n${lines.join("\n")}`,
        "info",
      );

      // Show what's still loaded
      if (loadedSkillBodies.size > 0) {
        notify(
          `📚 Still loaded: ${[...loadedSkillBodies.keys()].join(", ")}`,
          "info",
        );
      }
    }
  }

  // ── Event handlers ──────────────────────────────────────────────

  /**
   * On session start: capture the workspace root and load config.
   */
  pi.on("session_start", async (_event, ctx) => {
    await reloadConfig(ctx.cwd);
  });

  /**
   * Before each agent run: score loaded bodies for relevance and evict
   * irrelevant ones.  Do NOT filter `systemPromptOptions.skills` — all
   * skills remain advertised so the model can discover and load them.
   */
  pi.on("before_agent_start", (event, ctx) => {
    const skills = event.systemPromptOptions.skills;

    // Capture all known skills on first run
    if (allKnownSkills.length === 0 && skills.length > 0) {
      allKnownSkills = [...skills];
    }

    // Store prompt for context handler notifications
    lastPrompt = event.prompt;

    // Score loaded bodies and evict irrelevant ones
    evictIrrelevantBodies(event.prompt, skills, (msg, type) => ctx.ui.notify(msg, type));

    // NOTE: We do NOT touch event.systemPromptOptions.skills here.
    // All skills stay advertised so the model can discover and load them.
  });

  /**
   * Before each LLM request (including sub-requests during tool loops):
   * replace evicted skill bodies with lightweight placeholders to save
   * context window.
   *
   * The `context` event fires for every model request and gives us the
   * messages that will be sent to the provider.  We scan `ToolResult`
   * messages for `<skill_content>` wrappers and replace those whose
   * skills are no longer in `loadedSkillBodies`.
   */
  pi.on("context", async (event) => {
    // Quick exit: if no bodies have ever been loaded, nothing to do
    if (loadedSkillBodies.size === 0 && allKnownSkills.length === 0) return;

    let changed = false;
    const messages = event.messages.map((msg: any) => {
      // Only process tool results
      if (msg.role !== "toolResult") return msg;
      if (!msg.content || !Array.isArray(msg.content)) return msg;

      const skillName = extractSkillNameFromContent(msg.content);
      if (!skillName) return msg;

      // If the skill's body is NOT in our loaded set, replace with placeholder
      if (!loadedSkillBodies.has(skillName)) {
        changed = true;
        return {
          ...msg,
          content: [{ type: "text" as const, text: buildPlaceholder(skillName) }],
        };
      }

      return msg;
    });

    if (changed) {
      return { messages };
    }
  });

  // ── Skill tool (OpenCode-compatible native skill loader) ────────

  /**
   * Register a `skill` tool that the model can call to load a skill's
   * full instructions — mirroring OpenCode's native skill tool pattern.
   *
   * Instead of reading SKILL.md files directly, the model calls this tool
   * with the skill name. The tool returns the skill content, base
   * directory, and related files, coupled with the relevance filtering.
   */
  pi.registerTool({
    name: "skill",
    label: "Skill loader",
    description: [
      "Load a skill's full instructions by name.",
      "",
      "When you recognize that a task matches one of the available skills listed in the system prompt,",
      "use this tool to load the full skill instructions instead of reading the SKILL.md file directly.",
      "It returns the skill content, its base directory, and related files.",
    ].join("\n"),
    promptSnippet: "Load skill instructions by name (use instead of reading SKILL.md directly)",
    promptGuidelines: [
      "You have access to a `skill` tool to load skill instructions. When a task matches an available skill, call the tool instead of reading SKILL.md directly.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "The name of the skill to load, from the available skills listed in the system prompt",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const skillName = params.name;
      const skill = allKnownSkills.find((s) => s.name === skillName);

      if (!skill) {
        const available = allKnownSkills
          .filter((s) => !s.disableModelInvocation)
          .map((s) => s.name)
          .join(", ");
        return {
          content: [{
            type: "text",
            text: `Skill "${skillName}" not found. Available skills: ${available || "none"}`,
          }],
          details: undefined,
        };
      }

      if (skill.disableModelInvocation) {
        return {
          content: [{
            type: "text",
            text: `Skill "${skillName}" is not available for automatic model loading. Use the /skill:${skillName} command to invoke it manually.`,
          }],
          details: undefined,
        };
      }

      try {
        const fs = await import("node:fs/promises");
        const pathMod = await import("node:path");

        // Read the SKILL.md content
        const content = await fs.readFile(skill.filePath, "utf-8");

        // Record this skill's body as loaded
        loadedSkillBodies.set(skillName, Date.now());

        // Notify
        if (config.verbose) {
          const sizeKb = (content.length / 1024).toFixed(1);
          ctx.ui.notify(
            `📖 Loaded skill body: ${skillName} (${sizeKb} KB)`,
            "info",
          );
        }

        // List files in the skill directory (excluding SKILL.md, up to 10)
        const dir = skill.baseDir || pathMod.dirname(skill.filePath);
        let files: string[] = [];
        try {
          const entries = await fs.readdir(dir);
          files = entries
            .filter((f: string) => f !== "SKILL.md" && !f.startsWith("."))
            .slice(0, 10)
            .map((f: string) => pathMod.join(dir, f));
        } catch {
          // Directory listing not available — proceed without file list
        }

        const fileSection = files.length > 0
          ? [
            "",
            "<skill_files>",
            ...files.map((f) => `  <file>${f}</file>`),
            "</skill_files>",
          ].join("\n")
          : "";

        return {
          content: [{
            type: "text",
            text: [
              `<skill_content name="${skill.name}">`,
              `# Skill: ${skill.name}`,
              "",
              content.trim(),
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill (e.g., scripts/, references/, assets/) are relative to this base directory.",
              fileSection,
              "</skill_content>",
            ].join("\n"),
          }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error reading skill "${skillName}": ${err}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });

  // ── Commands ────────────────────────────────────────────────────

  pi.registerCommand("skills-pin", {
    description: "Pin a skill so its body is never evicted: /skills-pin <skill-name>",
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      if (!name) {
        ctx.ui.notify("Usage: /skills-pin <skill-name>", "warning");
        return;
      }
      pinned.add(name);
      ctx.ui.notify(`📌 Pinned skill body: ${name} (will never be archived)`, "info");
    },
  });

  pi.registerCommand("skills-unpin", {
    description: "Unpin a skill: /skills-unpin <skill-name>",
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      if (!name) {
        ctx.ui.notify("Usage: /skills-unpin <skill-name>", "warning");
        return;
      }
      if (!pinned.delete(name)) {
        ctx.ui.notify(`Skill not pinned: ${name}`, "warning");
        return;
      }
      ctx.ui.notify(`📍 Unpinned: ${name}`, "info");
    },
  });

  pi.registerCommand("skills-list", {
    description: "Show all known skills and their loaded/pinned/evicted status",
    handler: async (_args, ctx) => {
      const lines = allKnownSkills.map((s) => {
        const pin = pinned.has(s.name) ? " 📌" : "";
        const loaded = loadedSkillBodies.has(s.name) ? " 📖" : "";
        return `  ${s.name}${pin}${loaded} — ${s.description}`;
      });
      const bodyCount = loadedSkillBodies.size;
      const status = enabled ? "🟢 eviction enabled" : "🔴 eviction disabled";
      ctx.ui.notify(
        `Known skills (${allKnownSkills.length}) — ${status}\n` +
        `Loaded bodies: ${bodyCount}${bodyCount > 0 ? " (" + [...loadedSkillBodies.keys()].join(", ") + ")" : ""}\n` +
        `${lines.join("\n")}\n\n` +
        `📌 = pinned (body never evicted)   📖 = body loaded in conversation\n` +
        `Pin: /skills-pin <name>   Unpin: /skills-unpin <name>\n` +
        `Toggle eviction: /skills-on | /skills-off   Reload config: /skills-reload`,
        "info",
      );
    },
  });

  pi.registerCommand("skills-reload", {
    description: "Reload skill-lifecycle.json config from disk",
    handler: async (_args, ctx) => {
      await reloadConfig(ctx.cwd);
      ctx.ui.notify(`🔄 Config reloaded from ${CONFIG_FILENAME}`, "info");
    },
  });

  pi.registerCommand("skills-on", {
    description: "Enable automatic body eviction (default)",
    handler: async (_args, ctx) => {
      enabled = true;
      ctx.ui.notify("🟢 Body eviction enabled — irrelevant skill bodies will be archived", "info");
    },
  });

  pi.registerCommand("skills-off", {
    description: "Disable automatic body eviction (keep all loaded bodies)",
    handler: async (_args, ctx) => {
      enabled = false;
      ctx.ui.notify("🔴 Body eviction disabled — all loaded skill bodies stay in context", "info");
    },
  });
}