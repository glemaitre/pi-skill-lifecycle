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
  /** The N most recently loaded skill bodies are never evicted. Default: 2 */
  minKeep?: number;
  /** Maximum number of loaded skill bodies. 0 = unlimited. Default: 0 */
  maxKeep?: number;
  /** Custom relevance rules */
  rules?: RelevanceRule[];
  /** Skills to always keep (pinned by config) */
  pinned?: string[];
  /** Whether to log notifications on skill changes. Default: true */
  verbose?: boolean;
  /**
   * Skill the model should load first for ambiguous requests (for example
   * `triage-ml-task`). Only mentioned in the prompt when it is installed.
   * Default: "" (none).
   */
  entrySkill?: string;
  /** Block `read` calls on a known SKILL.md and point to the skill tool. Default: true */
  blockDirectSkillReads?: boolean;

  // ── Change-detection optimisation ────────────────────────────
  /** Skip scoring when the prompt is a short follow-up. Default: true */
  skipOnShortPrompts?: boolean;
  /**
   * Prompts shorter than this many characters skip scoring.
   * Only used when skipOnShortPrompts is true. Default: 15.
   */
  minScorablePromptLength?: number;
  /**
   * Token overlap ratio above which a prompt is considered the same topic.
   * Range 0..1. Default: 0.7.
   */
  topicChangeThreshold?: number;
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
  entrySkill: "",
  blockDirectSkillReads: true,
  skipOnShortPrompts: true,
  minScorablePromptLength: 15,
  topicChangeThreshold: 0.7,
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
    entrySkill: partial?.entrySkill ?? DEFAULT_CONFIG.entrySkill,
    blockDirectSkillReads: partial?.blockDirectSkillReads ?? DEFAULT_CONFIG.blockDirectSkillReads,
    skipOnShortPrompts: partial?.skipOnShortPrompts ?? DEFAULT_CONFIG.skipOnShortPrompts,
    minScorablePromptLength: partial?.minScorablePromptLength ?? DEFAULT_CONFIG.minScorablePromptLength,
    topicChangeThreshold: partial?.topicChangeThreshold ?? DEFAULT_CONFIG.topicChangeThreshold,
  };
}

// ── Relevance scoring ─────────────────────────────────────────────

/**
 * Tokenize a string into a set of lowercase word stems (3+ chars).
 */
/**
 * Common English words that carry no topic. Without this list, "and"/"the"
 * overlap between any prompt and any description keeps unrelated skills alive.
 */
const STOPWORDS = new Set([
  "about", "after", "all", "also", "and", "any", "are", "before", "but", "can", "could",
  "does", "each", "for", "from", "has", "have", "how", "into", "its", "just", "may",
  "more", "most", "not", "now", "only", "other", "our", "out", "should", "some", "such",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "use", "used", "using", "was", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "would", "you", "your",
]);

export function tokenize(text: string): Set<string> {
  // Split on anything that's not a letter or digit — hyphens and underscores are
  // separators too so skill names like "build-ml-pipeline" break into individual tokens.
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
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
 * Config file name, looked up in the user agent directory and the project
 * `.pi` directory (see `configPaths` in index.ts).
 */
export const CONFIG_FILENAME = "skill-lifecycle.json";

// ── Change detection ────────────────────────────────────────────

/**
 * Token set of a previous prompt, used to decide whether the topic shifted.
 */
export type PromptFingerprint = Set<string>;

/**
 * Build a fingerprint from a prompt for change-detection comparisons.
 */
export function fingerprintPrompt(prompt: string): PromptFingerprint {
  return tokenize(prompt);
}

/**
 * Determine whether a new prompt represents the same task as the previous one.
 *
 * Returns true when the prompt should **skip** re-scoring because:
 * - It is a very short follow-up ("yes", "continue", "run it")
 * - It has high token overlap with the previous prompt (> topicChangeThreshold)
 *
 * Returns false when a full re-score is warranted.
 */
export function isMinorChange(
  currentPrompt: string,
  previousFingerprint: PromptFingerprint | undefined,
  config: Required<EngineConfig>,
): boolean {
  if (previousFingerprint === undefined || previousFingerprint.size === 0) {
    return false; // first turn or empty previous state → always score
  }

  const trimmed = currentPrompt.trim();

  // Very short prompts are almost always acknowledgements or brief follow-ups
  if (config.skipOnShortPrompts && trimmed.length < config.minScorablePromptLength) {
    return true;
  }

  // Token overlap ratio: if most of the current tokens appeared in the previous prompt,
  // the topic hasn't changed.
  const currentTokens = tokenize(trimmed);
  if (currentTokens.size === 0) return true; // no meaningful tokens → minor

  let overlapCount = 0;
  for (const token of currentTokens) {
    if (previousFingerprint.has(token)) overlapCount++;
  }
  const overlapRatio = overlapCount / currentTokens.size;

  return overlapRatio >= config.topicChangeThreshold;
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

// ── Skill body helpers ────────────────────────────────────────────

/**
 * Regex to extract a skill name from its `<skill_content>` wrapper.
 */
export const SKILL_CONTENT_RE = /<skill_content name="([^"]+)">/;

/**
 * Scan a tool result's content blocks for a `<skill_content>` wrapper
 * and return the skill name, or null if this isn't skill body content.
 */
export function extractSkillNameFromContent(
  content: Array<{ type: string; text?: string }>,
): string | null {
  for (const block of content) {
    if (block.type === "text" && block.text) {
      const match = block.text.match(SKILL_CONTENT_RE);
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * Build the placeholder text that replaces an evicted skill body.
 */
export function buildPlaceholder(skillName: string): string {
  return [
    `<skill_content name="${skillName}">`,
    `  [Previously loaded skill body — archived because the topic shifted.`,
    `   Call \`skill("${skillName}")\` to reload when needed.]`,
    `</skill_content>`,
  ].join("\n");
}
// ── Body eviction ─────────────────────────────────────────────────

/**
 * A skill body currently loaded in the conversation. `seq` grows with every
 * load, so a larger value means a more recent load.
 */
export interface LoadedBody {
  name: string;
  seq: number;
}

/**
 * Decide which loaded skill bodies to evict for the next user prompt.
 *
 * - Pinned bodies are never evicted.
 * - The `minKeep` most recently loaded bodies are never evicted, so the skill
 *   being worked on survives replies that share no keywords with it.
 * - Other bodies are evicted when their relevance score is below `threshold`.
 * - If `maxKeep` > 0, the oldest unprotected survivors are evicted until at
 *   most `maxKeep` bodies remain (pinned and recent bodies count but stay).
 */
export function selectBodiesToEvict(
  prompt: string,
  loaded: LoadedBody[],
  skillsByName: ReadonlyMap<string, Skill>,
  pinnedSet: ReadonlySet<string>,
  config: Required<EngineConfig>,
): Array<{ name: string; score: number; reason: string }> {
  const byRecency = [...loaded].sort((a, b) => b.seq - a.seq);
  const recent = new Set(byRecency.slice(0, Math.max(0, config.minKeep)).map((b) => b.name));
  const isProtected = (name: string) => pinnedSet.has(name) || recent.has(name);

  const evicted: Array<{ name: string; score: number; reason: string }> = [];
  const survivors: LoadedBody[] = [];

  for (const body of byRecency) {
    if (isProtected(body.name)) {
      survivors.push(body);
      continue;
    }
    const skill = skillsByName.get(body.name);
    if (!skill) {
      evicted.push({ name: body.name, score: 0, reason: "skill no longer installed" });
      continue;
    }
    const { score, reason } = scoreRelevance(prompt, skill, config.rules);
    if (score < config.threshold) evicted.push({ name: body.name, score, reason });
    else survivors.push(body);
  }

  if (config.maxKeep > 0) {
    // survivors are ordered most recent first; drop from the oldest end.
    for (let i = survivors.length - 1; i >= 0 && survivors.length > config.maxKeep; i--) {
      if (isProtected(survivors[i].name)) continue;
      const [body] = survivors.splice(i, 1);
      evicted.push({ name: body.name, score: 0, reason: `over maxKeep (${config.maxKeep})` });
    }
  }

  return evicted;
}
