/**
 * Pi Skill Lifecycle — Dynamic skill loading and unloading.
 *
 * Automatically keeps only the skills relevant to the current conversation,
 * saving context window and reducing noise for the model.
 *
 * Install:  pi --extension ./extensions/index.ts
 * Package:  pi install ./pi-skill-lifecycle
 *
 * Commands:
 *   /skills-pin <name>      — Pin a skill so it's always kept
 *   /skills-unpin <name>    — Unpin a skill
 *   /skills-list            — Show all known skills and pinned status
 *   /skills-reload          — Reload config file from disk
 *   /skills-on              — Enable automatic skill filtering
 *   /skills-off             — Disable automatic skill filtering
 */

import type { ExtensionAPI, Skill as PiSkill } from "@earendil-works/pi-coding-agent";
import type { Skill, EngineConfig, RelevanceRule } from "./rules.ts";
import {
  configWithDefaults,
  CONFIG_FILENAME,
  scoreRelevance,
  selectRelevantSkills,
  buildChangeSummary,
} from "./rules.ts";

export default function (pi: ExtensionAPI) {
  // ── State ───────────────────────────────────────────────────────

  /** All skills we've ever seen, for `/skills-list` and config reloads. */
  let allKnownSkills: PiSkill[] = [];

  /** Pinned skill names (lowercase). */
  const pinned = new Set<string>();

  /** Whether automatic filtering is enabled. */
  let enabled = true;

  /** Current config (lazy-loaded from file + defaults). */
  let config: ReturnType<typeof configWithDefaults> = configWithDefaults();

  /** Custom rules from config file, keyed by skill name. */
  let customRules: RelevanceRule[] = [];

  /** Cached workspace root. */
  let workspaceRoot = "";

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
   * Apply filtering: if enabled, remove irrelevant skills from the
   * system prompt options for the next model call.
   */
  function applyFiltering(
    prompt: string,
    skills: PiSkill[],
    _ctx: { ui: { notify: (msg: string, type: string) => void } },
  ): PiSkill[] {
    if (!enabled || skills.length <= config.minKeep) {
      return skills;
    }

    const pureSkills = skills.map(toPureSkill);
    const { kept, dropped } = selectRelevantSkills(prompt, pureSkills, pinned, config);

    if (dropped.length > 0 && config.verbose) {
      const summary = buildChangeSummary(kept, dropped, skills.length);
      _ctx.ui.notify(summary, "info");
    }

    // Return is a PiSkill[]; we map back using the original objects
    const keptNames = new Set(kept.map((s) => s.name));
    return skills.filter((s) => keptNames.has(s.name));
  }

  // ── Event handlers ──────────────────────────────────────────────

  /**
   * On session start: capture the workspace root and load config.
   */
  pi.on("session_start", async (_event, ctx) => {
    await reloadConfig(ctx.cwd);

    // Capture all skills if not already done (they're in the prompt options,
    // but we'll grab them on the first before_agent_start).
  });

  /**
   * Before each agent run: filter skills to only the relevant ones.
   *
   * This is the core hook — we mutate `systemPromptOptions.skills`
   * to remove skills the model doesn't need right now.
   */
  pi.on("before_agent_start", (event, ctx) => {
    const skills = event.systemPromptOptions.skills;

    // Capture all known skills on first run
    if (allKnownSkills.length === 0 && skills.length > 0) {
      allKnownSkills = [...skills];
    }

    const filtered = applyFiltering(event.prompt, skills, ctx);
    event.systemPromptOptions.skills = filtered;
  });

  // ── Commands ────────────────────────────────────────────────────

  pi.registerCommand("skills-pin", {
    description: "Pin a skill so it's always kept: /skills-pin <skill-name>",
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      if (!name) {
        ctx.ui.notify("Usage: /skills-pin <skill-name>", "warning");
        return;
      }
      pinned.add(name);
      ctx.ui.notify(`📌 Pinned skill: ${name}`, "info");
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
    description: "Show all known skills and their pinned/filtered status",
    handler: async (_args, ctx) => {
      const lines = allKnownSkills.map((s) => {
        const pin = pinned.has(s.name) ? " 📌" : "";
        const { score, reason } = scoreRelevance("", toPureSkill(s), customRules);
        return `  ${s.name}${pin} — ${s.description}`;
      });
      const status = enabled ? "🟢 enabled" : "🔴 disabled";
      ctx.ui.notify(
        `Known skills (${allKnownSkills.length}) — ${status}:\n${lines.join("\n")}\n\n` +
        `Pin skills: /skills-pin <name>   Unpin: /skills-unpin <name>\n` +
        `Toggle: /skills-on | /skills-off   Reload config: /skills-reload`,
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
    description: "Enable automatic skill filtering",
    handler: async (_args, ctx) => {
      enabled = true;
      ctx.ui.notify("🟢 Skill filtering enabled", "info");
    },
  });

  pi.registerCommand("skills-off", {
    description: "Disable automatic skill filtering (keep all skills)",
    handler: async (_args, ctx) => {
      enabled = false;
      ctx.ui.notify("🔴 Skill filtering disabled — all skills visible", "info");
    },
  });
}