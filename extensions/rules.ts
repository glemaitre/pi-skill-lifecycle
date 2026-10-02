/**
 * Relevance engine for smart skill lifecycle management.
 *
 * Pure logic — no Pi imports, fully testable in isolation.
 */

// ── Types ─────────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  /** Full path to SKILL.md */
  filePath: string;
  /** Directory containing the skill */
  baseDir: string;
  /** If true, skill only responds to explicit /skill:name commands */
  disableModelInvocation: boolean;
}

/**
 * A single rule that maps a skill to trigger keywords.
 */
export interface RelevanceRule {
  /** Skill name this rule applies to (lowercase) */
  skillName: string;
  /** Keywords that suggest this skill is relevant (lowercase) */
  keywords: string[];
  /** Optional weight multiplier (default 1.0) */
  weight?: number;
}

/**
 * Configuration for the relevance engine, loadable from a JSON file.
 */
export interface EngineConfig {
  /** Minimum score (0..1) a skill needs to be kept. Default: 0.15 */
  threshold?: number;
  /** Minimum number of skills to always keep. Default: 2 */
  minKeep?: number;
  /** Maximum number of skills to keep. 0 = unlimited. Default: 0 */
  maxKeep?: number;
  /** Custom relevance rules */
  rules?: RelevanceRule[];
  /** Skills to always keep (pinned by config) */
  pinned?: string[];
  /** Whether to log notifications on skill changes. Default: true */
  verbose?: boolean;
}

/**
 * A skill with its computed relevance score.
 */
export interface ScoredSkill {
  skill: Skill;
  score: number;
  reason: string;
}

// ── Defaults ─────────────────────────────────────────────────────-

export const DEFAULT_CONFIG: Required<EngineConfig> = {
  threshold: 0.15,
  minKeep: 2,
  maxKeep: 0,
  rules: [],
  pinned: [],
  verbose: true,
};

/**
 * Fill in defaults for a partial config.
 */
export function configWithDefaults(partial?: EngineConfig): Required<EngineConfig> {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    rules: partial?.rules ?? [],
    pinned: partial?.pinned ?? [],
  };
}

// ── Relevance scoring ─────────────────────────────────────────────

/**
 * Tokenize a string into a set of lowercase word stems (3+ chars).
 */
export function tokenize(text: string): Set<string> {
  // Split on anything that's not a letter or digit — hyphens and underscores are
  // separators too so skill names like "build-ml-pipeline" break into individual tokens.
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  return new Set(words);
}

/**
 * Score a single skill against a user prompt using keyword rules and
 * the skill's own description as a fallback.
 *
 * Returns a number between 0 and 1.
 */
export function scoreRelevance(
  prompt: string,
  skill: Skill,
  rules: RelevanceRule[],
): { score: number; reason: string } {
  const lowerPrompt = prompt.toLowerCase();
  const promptTokens = tokenize(prompt);

  // 1. Check explicit rules for this skill
  const skillRules = rules.filter((r) => r.skillName === skill.name);
  let bestRuleScore = 0;
  let bestRuleReason = "";

  for (const rule of skillRules) {
    const matchCount = rule.keywords.filter((kw) => lowerPrompt.includes(kw.toLowerCase())).length;
    if (matchCount > 0) {
      const raw = matchCount / rule.keywords.length;
      const weighted = raw * (rule.weight ?? 1.0);
      if (weighted > bestRuleScore) {
        bestRuleScore = Math.min(1.0, weighted);
        bestRuleReason = `rule matched ${matchCount}/${rule.keywords.length} keywords`;
      }
    }
  }

  // 2. Fallback: description-based scoring
  const descTokens = tokenize(skill.description);
  let descMatchCount = 0;
  for (const token of descTokens) {
    if (promptTokens.has(token)) descMatchCount++;
  }
  const descScore = descTokens.size > 0
    ? descMatchCount / descTokens.size
    : 0;

  // The skill's name tokens are also a strong signal
  const nameTokens = skill.name.toLowerCase().split(/[^a-z0-9]+/);
  const nameInPrompt = nameTokens.find((t) => t.length >= 3 && lowerPrompt.includes(t)) ? 0.5 : 0;

  // 3. Combine: rule score takes priority, desc is fallback
  const combined = Math.max(bestRuleScore, descScore * 0.6, nameInPrompt);
  const reason = bestRuleScore > 0
    ? bestRuleReason
    : descScore > 0
      ? `description matched ${descMatchCount}/${descTokens.size} tokens`
      : nameInPrompt > 0
        ? "skill name found in prompt"
        : "no match";

  return { score: Math.min(1.0, combined), reason };
}

// ── Skill selection ───────────────────────────────────────────────

/**
 * Filter and rank skills based on relevance to the user prompt.
 *
 * Rules:
 * - Pinned skills are always kept (score = 1.0).
 * - Zero-score skills are dropped unless we need them to reach minKeep.
 * - Skills are sorted by score descending.
 * - If maxKeep > 0, only the top N are kept.
 */
export function selectRelevantSkills(
  prompt: string,
  skills: Skill[],
  pinnedSet: Set<string>,
  config: Required<EngineConfig>,
): { kept: Skill[]; dropped: Array<{ skill: Skill; score: number; reason: string }> } {
  if (skills.length === 0) {
    return { kept: [], dropped: [] };
  }

  if (skills.length <= config.minKeep) {
    // Not enough skills to bother filtering — keep all
    return { kept: [...skills], dropped: [] };
  }

  // Score every skill
  const scored: ScoredSkill[] = skills.map((skill) => {
    const isPinned = pinnedSet.has(skill.name);
    if (isPinned) {
      return { skill, score: 1.0, reason: "pinned" };
    }
    const { score, reason } = scoreRelevance(prompt, skill, config.rules);
    return { skill, score, reason };
  });

  // Split into kept and dropped
  const aboveThreshold = scored.filter((s) => s.score >= config.threshold);
  const belowThreshold = scored.filter((s) => s.score < config.threshold);

  // Sort both by score descending
  aboveThreshold.sort((a, b) => b.score - a.score);
  belowThreshold.sort((a, b) => b.score - a.score);

  // Ensure we keep at least minKeep
  const kept: ScoredSkill[] = [...aboveThreshold];

  if (kept.length < config.minKeep) {
    const needed = config.minKeep - kept.length;
    for (let i = 0; i < needed && i < belowThreshold.length; i++) {
      kept.push(belowThreshold[i]);
    }
  }

  // Apply maxKeep cap
  if (config.maxKeep > 0 && kept.length > config.maxKeep) {
    kept.sort((a, b) => b.score - a.score);
    const dropped = kept.splice(config.maxKeep);
    return {
      kept: kept.map((s) => s.skill),
      dropped: dropped.map((s) => ({ skill: s.skill, score: s.score, reason: s.reason })),
    };
  }

  // Everything not kept is "dropped"
  const keptNames = new Set(kept.map((s) => s.skill.name));
  const dropped = scored
    .filter((s) => !keptNames.has(s.skill.name))
    .map((s) => ({ skill: s.skill, score: s.score, reason: s.reason }));

  return {
    kept: kept.map((s) => s.skill),
    dropped,
  };
}

// ── Config file loading ───────────────────────────────────────────

/**
 * Default config file path (relative to workspace root).
 */
export const CONFIG_FILENAME = "skill-lifecycle.json";

/**
 * Try to load engine config from a JSON file.
 * Returns undefined if the file doesn't exist or is unreadable.
 */
export async function loadConfigFromFile(
  cwd: string,
  filename: string = CONFIG_FILENAME,
): Promise<EngineConfig | undefined> {
  // We use a dynamic import so this module remains dependency-free.
  // In a pi extension, fs is always available.
  try {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(`${cwd}/${filename}`, "utf-8");
    const parsed = JSON.parse(content) as EngineConfig;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Build a summary string for notifications.
 */
export function buildChangeSummary(
  kept: Skill[],
  dropped: Array<{ skill: Skill; score: number; reason: string }>,
  totalBefore: number,
): string {
  if (dropped.length === 0) return "";

  const keptNames = kept.map((s) => s.name).join(", ");
  const droppedNames = dropped.map((s) => `${s.skill.name} (${(s.score * 100).toFixed(0)}%)`).join(", ");

  return [
    `🧠 Skills: ${kept.length}/${totalBefore} loaded after filtering`,
    `   Kept: ${keptNames}`,
    `   Dropped: ${droppedNames}`,
  ].join("\n");
}