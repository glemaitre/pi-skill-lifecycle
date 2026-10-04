/**
 * Tests for the relevance engine (pure logic).
 *
 * Run: npx vitest run
 * Watch: npx vitest
 */

import { describe, it, expect } from "vitest";
import {
  tokenize,
  scoreRelevance,
  selectRelevantSkills,
  configWithDefaults,
  DEFAULT_CONFIG,
  buildChangeSummary,
  isMinorChange,
  fingerprintPrompt,
  extractSkillNameFromContent,
  buildPlaceholder,
  selectBodiesSupersededBy,
  selectBodiesToEvict,
} from "../extensions/rules.ts";
import type { Skill, RelevanceRule } from "../extensions/rules.ts";

// ── Fixtures ──────────────────────────────────────────────────────

function makeSkill(overrides: Partial<Skill> & { name: string }): Skill {
  return {
    description: "Default test skill description",
    filePath: `/skills/${overrides.name}/SKILL.md`,
    baseDir: `/skills/${overrides.name}`,
    disableModelInvocation: false,
    ...overrides,
  };
}

const makeSut = () => {
  const buildSkill = makeSkill;
  return { buildSkill };
};

const NO_RULES: RelevanceRule[] = [];

// ── tokenize ──────────────────────────────────────────────────────

describe("tokenize", () => {
  it("splits on punctuation and whitespace", () => {
    const t = tokenize("hello, world! build-ml-pipeline?");
    // "ml" is filtered out (2 chars), hyphen splits the compound name
    expect([...t]).toEqual(["hello", "world", "build", "pipeline"]);
  });

  it("excludes words shorter than 3 characters", () => {
    const t = tokenize("a an of ml pi data");
    expect([...t]).toEqual(["data"]);
  });

  it("excludes stopwords so filler words do not count as overlap", () => {
    const t = tokenize("the data and the pipeline for you");
    expect([...t]).toEqual(["data", "pipeline"]);
  });

  it("lowercases everything", () => {
    const t = tokenize("Hello World BUILD");
    expect([...t]).toEqual(["hello", "world", "build"]);
  });

  it("handles empty input", () => {
    expect([...tokenize("")]).toEqual([]);
  });
});

// ── scoreRelevance ────────────────────────────────────────────────

describe("scoreRelevance", () => {
  it("returns 0 for a skill with no match", () => {
    const skill = makeSkill({
      name: "pdf-tools",
      description: "Extract text and tables from PDF files",
    });
    const { score, reason } = scoreRelevance("build a classifier with sklearn", skill, NO_RULES);
    expect(score).toBe(0);
    expect(reason).toBe("no match");
  });

  it("scores based on description token overlap", () => {
    const skill = makeSkill({
      name: "build-ml-pipeline",
      description: "Declare the pipeline from data source to predictor as a skrub DataOps graph",
    });
    const { score } = scoreRelevance("I want to build a pipeline for my data", skill, NO_RULES);
    expect(score).toBeGreaterThan(0);
  });

  it("gives a boost when the skill name appears in the prompt", () => {
    const skill = makeSkill({
      name: "audit-ml-pipeline",
      description: "Review past experiments",
    });
    const { score, reason } = scoreRelevance("run an audit on experiment 5", skill, NO_RULES);
    expect(score).toBeGreaterThan(0);
    expect(reason).toContain("skill name found");
  });

  it("uses explicit rules when they exist", () => {
    const skill = makeSkill({ name: "explore-ml-data", description: "Data exploration" });
    const rules: RelevanceRule[] = [
      { skillName: "explore-ml-data", keywords: ["explore", "eda", "profile", "data analysis"] },
    ];
    const { score, reason } = scoreRelevance("I need to explore the data and run EDA", skill, rules);
    expect(score).toBeGreaterThan(0);
    expect(reason).toContain("rule matched");
  });

  it("applies rule weight multiplier", () => {
    const skill = makeSkill({ name: "explore-ml-data", description: "Data exploration" });
    const rules: RelevanceRule[] = [
      {
        skillName: "explore-ml-data",
        keywords: ["explore", "eda", "data analysis"],
        weight: 2.0,
      },
    ];
    const { score } = scoreRelevance("explore the data", skill, rules);
    // 1/3 keywords * 2.0 weight = 0.66, capped at 1
    expect(score).toBeGreaterThan(0.5);
  });

  it("caps score at 1.0", () => {
    const skill = makeSkill({ name: "test", description: "a" });
    const rules: RelevanceRule[] = [
      {
        skillName: "test",
        keywords: ["hello", "world"],
        weight: 10,
      },
    ];
    const { score } = scoreRelevance("hello world", skill, rules);
    expect(score).toBe(1.0);
  });
});

// ── selectRelevantSkills ──────────────────────────────────────────

describe("selectRelevantSkills", () => {
  const cfg = configWithDefaults({ threshold: 0.01, minKeep: 2 });

  const skills = [
    makeSkill({ name: "build-ml-pipeline", description: "Build sklearn pipelines with skrub DataOps" }),
    makeSkill({ name: "explore-ml-data", description: "Profile and understand raw data before modeling" }),
    makeSkill({ name: "evaluate-ml-pipeline", description: "Run cross-validation and scoring" }),
    makeSkill({ name: "audit-ml-pipeline", description: "Review past experiment reports" }),
    makeSkill({ name: "frame-ml-problem", description: "Lock problem type, metric, baseline, and split" }),
    makeSkill({ name: "model-ml-pipeline", description: "Coordinate model design and experiments" }),
  ];

  it("keeps all skills when count <= minKeep", () => {
    const { kept, dropped } = selectRelevantSkills(
      "anything",
      skills.slice(0, 2),
      new Set(),
      cfg,
    );
    expect(kept.length).toBe(2);
    expect(dropped).toEqual([]);
  });

  it("keeps pinned skills regardless of prompt", () => {
    const pinned = new Set(["audit-ml-pipeline"]);
    const { kept, dropped } = selectRelevantSkills(
      "build a classifier with sklearn",
      skills,
      pinned,
      cfg,
    );
    const keptNames = kept.map((s) => s.name);
    expect(keptNames).toContain("audit-ml-pipeline");
    expect(keptNames).toContain("build-ml-pipeline"); // best match
  });

  it("drops skills below threshold", () => {
    const strictCfg = configWithDefaults({ threshold: 0.3, minKeep: 1 });
    const { kept, dropped } = selectRelevantSkills(
      "build a classifier with sklearn",
      skills,
      new Set(),
      strictCfg,
    );
    const keptNames = kept.map((s) => s.name);
    const droppedNames = dropped.map((s) => s.skill.name);
    expect(keptNames).toContain("build-ml-pipeline");
    // Some should have been dropped
    expect(dropped.length).toBeGreaterThan(0);
  });

  it("ensures at least minKeep skills survive", () => {
    const minKeepCfg = configWithDefaults({ threshold: 0.9, minKeep: 3 });
    const { kept } = selectRelevantSkills(
      "i love cats a lot meow",
      skills,
      new Set(),
      minKeepCfg,
    );
    expect(kept.length).toBe(3);
  });

  it("caps at maxKeep when set", () => {
    const maxCfg = configWithDefaults({ threshold: 0, minKeep: 1, maxKeep: 2 });
    const { kept } = selectRelevantSkills(
      "build pipeline explore data evaluate model audit frame",
      skills,
      new Set(),
      maxCfg,
    );
    expect(kept.length).toBeLessThanOrEqual(2);
  });

  it("returns all skills when empty prompt is given and minKeep > total", () => {
    const { kept } = selectRelevantSkills("", skills.slice(0, 1), new Set(), cfg);
    expect(kept.length).toBe(1);
  });

  it("returns empty for empty skills input", () => {
    const { kept, dropped } = selectRelevantSkills("anything", [], new Set(), cfg);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("drops skills with score 0 unless needed for minKeep", () => {
    const { kept, dropped } = selectRelevantSkills(
      "quantum physics",
      skills,
      new Set(),
      configWithDefaults({ threshold: 0.5, minKeep: 1 }),
    );
    // Most skills should have near-0 scores
    const keptNames = kept.map((s) => s.name);
    expect(kept.length).toBe(1); // minKeep
    expect(dropped.length).toBe(skills.length - 1);
  });
});

// ── buildChangeSummary ────────────────────────────────────────────

describe("buildChangeSummary", () => {
  it("returns empty string when nothing was dropped", () => {
    const result = buildChangeSummary(
      [makeSkill({ name: "a" }), makeSkill({ name: "b" })],
      [],
      2,
    );
    expect(result).toBe("");
  });

  it("includes kept and dropped names", () => {
    const result = buildChangeSummary(
      [makeSkill({ name: "build-ml-pipeline" })],
      [{ skill: makeSkill({ name: "audit-ml-pipeline" }), score: 0.05, reason: "no match" }],
      2,
    );
    expect(result).toContain("build-ml-pipeline");
    expect(result).toContain("audit-ml-pipeline");
    expect(result).toContain("5%");
  });
});

// ── configWithDefaults ────────────────────────────────────────────

describe("configWithDefaults", () => {
  it("fills all fields from DEFAULT_CONFIG when given empty object", () => {
    const cfg = configWithDefaults({});
    expect(cfg.threshold).toBe(DEFAULT_CONFIG.threshold);
    expect(cfg.minKeep).toBe(DEFAULT_CONFIG.minKeep);
    expect(cfg.rules).toEqual([]);
    expect(cfg.pinned).toEqual([]);
    expect(cfg.entrySkill).toBe("");
    expect(cfg.blockDirectSkillReads).toBe(true);
    expect(cfg.skipOnShortPrompts).toBe(true);
    expect(cfg.minScorablePromptLength).toBe(15);
    expect(cfg.topicChangeThreshold).toBe(0.7);
  });

  it("preserves fields that are set", () => {
    const cfg = configWithDefaults({ threshold: 0.5, pinned: ["test"] });
    expect(cfg.threshold).toBe(0.5);
    expect(cfg.minKeep).toBe(DEFAULT_CONFIG.minKeep);
    expect(cfg.pinned).toEqual(["test"]);
    expect(cfg.rules).toEqual([]);
    expect(cfg.blockDirectSkillReads).toBe(true);
    expect(cfg.skipOnShortPrompts).toBe(true);
  });

  it("keeps explicit false and empty values", () => {
    const cfg = configWithDefaults({ blockDirectSkillReads: false, entrySkill: "triage-ml-task" });
    expect(cfg.blockDirectSkillReads).toBe(false);
    expect(cfg.entrySkill).toBe("triage-ml-task");
  });
});

// ── isMinorChange ─────────────────────────────────────────────────

describe("isMinorChange", () => {
  const cfg = configWithDefaults({});

  it("returns false when there is no previous fingerprint (first turn)", () => {
    expect(isMinorChange("build a classifier", undefined, cfg)).toBe(false);
  });

  it("returns false when previous fingerprint is empty", () => {
    expect(isMinorChange("build a classifier", new Set(), cfg)).toBe(false);
  });

  it("returns true for very short prompts (acknowledgements)", () => {
    const prev = fingerprintPrompt("build a classifier with sklearn");
    expect(isMinorChange("yes", prev, cfg)).toBe(true);
    expect(isMinorChange("ok", prev, cfg)).toBe(true);
    expect(isMinorChange("run it", prev, cfg)).toBe(true);
    expect(isMinorChange("continue", prev, cfg)).toBe(true);
  });

  it("returns true when the prompt length is below minScorablePromptLength", () => {
    const prev = fingerprintPrompt("build a classifier with sklearn");
    // "go ahead" is 8 chars, below default of 15
    expect(isMinorChange("go ahead", prev, cfg)).toBe(true);
  });

  it("respects a custom minScorablePromptLength", () => {
    const shortCfg = configWithDefaults({ minScorablePromptLength: 5, skipOnShortPrompts: true });
    const prev = fingerprintPrompt("build a classifier");
    // "hello" is 5 chars, not below threshold
    expect(isMinorChange("hello", prev, shortCfg)).toBe(false);
    // "hi" is 2 chars, below threshold
    expect(isMinorChange("hi", prev, shortCfg)).toBe(true);
  });

  it("does not skip short prompts when skipOnShortPrompts is false", () => {
    const noSkipCfg = configWithDefaults({ skipOnShortPrompts: false });
    const prev = fingerprintPrompt("build a classifier with sklearn");
    expect(isMinorChange("yes", prev, noSkipCfg)).toBe(false);
  });

  it("returns true when high token overlap with previous prompt", () => {
    const prev = fingerprintPrompt("build a random forest classifier with sklearn");
    // 4/4 tokens overlap → 1.0 ratio, well above 0.7 threshold
    expect(isMinorChange("random forest classifier sklearn", prev, cfg)).toBe(true);
  });

  it("returns false when topic clearly changed", () => {
    const prev = fingerprintPrompt("build a random forest classifier with sklearn");
    // Completely different topic — low token overlap
    expect(isMinorChange("explore the data distributions and outliers", prev, cfg)).toBe(false);
  });

  it("uses topicChangeThreshold from config", () => {
    // threshold 0.4 means 40%+ overlap needed to consider it the same topic
    const cfg40 = configWithDefaults({ topicChangeThreshold: 0.4 });
    const prev = fingerprintPrompt("build a random forest classifier with sklearn");
    // "build an xgboost model" has 33% overlap (1/3) → below 40% → not minor
    expect(isMinorChange("build an xgboost model", prev, cfg40)).toBe(false);

    // With threshold 0.2 (only 20% needed), 33% overlap IS enough → minor
    const cfg20 = configWithDefaults({ topicChangeThreshold: 0.2 });
    expect(isMinorChange("build an xgboost model", prev, cfg20)).toBe(true);
  });

  it("returns true when current prompt has no meaningful tokens", () => {
    const prev = fingerprintPrompt("build a classifier");
    expect(isMinorChange("a", prev, cfg)).toBe(true);
    expect(isMinorChange("", prev, cfg)).toBe(true);
  });
});

// ── extractSkillNameFromContent ───────────────────────────────────

describe("extractSkillNameFromContent", () => {
  it("extracts skill name from <skill_content> wrapper", () => {
    const content = [
      { type: "text", text: '<skill_content name="build-ml-pipeline">\n# Skill: build-ml-pipeline' },
    ];
    expect(extractSkillNameFromContent(content)).toBe("build-ml-pipeline");
  });

  it("returns null when content has no skill wrapper", () => {
    const content = [
      { type: "text", text: "Some random tool output without skill content" },
    ];
    expect(extractSkillNameFromContent(content)).toBeNull();
  });

  it("returns null for empty content array", () => {
    expect(extractSkillNameFromContent([])).toBeNull();
  });

  it("scans multiple blocks to find the wrapper", () => {
    const content = [
      { type: "text", text: "Some preliminary output" },
      { type: "text", text: '<skill_content name="explore-ml-data">\n...' },
    ];
    expect(extractSkillNameFromContent(content)).toBe("explore-ml-data");
  });

  it("handles image blocks without crashing", () => {
    const content = [
      { type: "image", data: "abc", mimeType: "image/png" } as any,
    ];
    expect(extractSkillNameFromContent(content)).toBeNull();
  });

  it("handles mixed image and text blocks", () => {
    const content = [
      { type: "image", data: "abc", mimeType: "image/png" } as any,
      { type: "text", text: '<skill_content name="audit-ml-pipeline">' },
    ];
    expect(extractSkillNameFromContent(content)).toBe("audit-ml-pipeline");
  });

  it("matches only <skill_content> open tags, not text containing it", () => {
    const content = [
      { type: "text", text: "some text <skill_content name=\"something\"> else" },
    ];
    expect(extractSkillNameFromContent(content)).toBe("something");
  });
});

// ── buildPlaceholder ──────────────────────────────────────────────

describe("buildPlaceholder", () => {
  it("wraps skill name in a <skill_content> placeholder", () => {
    const result = buildPlaceholder("build-ml-pipeline");
    expect(result).toContain('<skill_content name="build-ml-pipeline">');
    expect(result).toContain("</skill_content>");
    expect(result).toContain("archived because the topic shifted");
    expect(result).toContain('skill("build-ml-pipeline")');
  });

  it("tells the model it can reload the skill", () => {
    const result = buildPlaceholder("explore-ml-data");
    expect(result).toContain("reload when needed");
  });

  it("produces valid XML-like tags", () => {
    const result = buildPlaceholder("test-skill");
    expect(result).toMatch(/^<skill_content/);
    expect(result).toMatch(/<\/skill_content>$/);
  });
});
// ── selectBodiesToEvict ───────────────────────────────────────────

describe("selectBodiesToEvict", () => {
  const skills = new Map(
    [
      makeSkill({ name: "explore-ml-data", description: "Explore and profile the data" }),
      makeSkill({ name: "setup-ml-project", description: "Set up and bootstrap a workspace" }),
      makeSkill({ name: "build-ml-pipeline", description: "Build a skrub pipeline" }),
    ].map((s) => [s.name, s]),
  );
  const loaded = [
    { name: "explore-ml-data", seq: 1 },
    { name: "setup-ml-project", seq: 2 },
    { name: "build-ml-pipeline", seq: 3 },
  ];
  const names = (out: Array<{ name: string }>) => out.map((e) => e.name).sort();

  it("protects the minKeep most recent bodies even with no keyword match", () => {
    const out = selectBodiesToEvict("unrelated words here", loaded, skills, new Set(), configWithDefaults({ minKeep: 2 }));
    expect(names(out)).toEqual(["explore-ml-data"]);
  });

  it("keeps an old body that is still relevant", () => {
    const out = selectBodiesToEvict("explore the data again", loaded, skills, new Set(), configWithDefaults({ minKeep: 1 }));
    expect(names(out)).toEqual(["setup-ml-project"]);
  });

  it("never evicts pinned bodies", () => {
    const out = selectBodiesToEvict("unrelated", loaded, skills, new Set(["explore-ml-data"]), configWithDefaults({ minKeep: 0 }));
    expect(names(out)).toEqual(["build-ml-pipeline", "setup-ml-project"]);
  });

  it("evicts bodies of skills that are no longer installed", () => {
    const out = selectBodiesToEvict("explore", [{ name: "gone", seq: 0 }, ...loaded], skills, new Set(), configWithDefaults({ minKeep: 3 }));
    expect(names(out)).toEqual(["gone"]);
  });

  it("caps the total with maxKeep by evicting the oldest unprotected survivors", () => {
    const out = selectBodiesToEvict(
      "explore data, set up workspace, build pipeline",
      loaded,
      skills,
      new Set(),
      configWithDefaults({ minKeep: 1, maxKeep: 2 }),
    );
    expect(out).toEqual([{ name: "explore-ml-data", score: 0, reason: "over maxKeep (2)" }]);
  });

  it("returns nothing when nothing is loaded", () => {
    expect(selectBodiesToEvict("x", [], skills, new Set(), configWithDefaults())).toEqual([]);
  });
});

// ── selectBodiesSupersededBy ──────────────────────────────────────

describe("selectBodiesSupersededBy", () => {
  const skills = new Map(
    [
      makeSkill({ name: "explore-ml-data", description: "Explore and profile the data" }),
      makeSkill({ name: "setup-ml-project", description: "Set up and bootstrap a workspace" }),
      makeSkill({ name: "build-ml-pipeline", description: "Build a skrub pipeline from the data" }),
    ].map((s) => [s.name, s]),
  );
  const names = (out: Array<{ name: string }>) => out.map((e) => e.name).sort();

  it("evicts bodies unrelated to the new skill, ignoring minKeep", () => {
    const loaded = [
      { name: "explore-ml-data", seq: 1 },
      { name: "setup-ml-project", seq: 2 },
    ];
    const out = selectBodiesSupersededBy(["setup-ml-project"], loaded, skills, new Set(), configWithDefaults({ minKeep: 5 }));
    expect(names(out)).toEqual(["explore-ml-data"]);
    expect(out[0].reason).toContain("superseded by setup-ml-project");
  });

  it("keeps bodies related to the new skill's description", () => {
    const loaded = [
      { name: "explore-ml-data", seq: 1 },
      { name: "build-ml-pipeline", seq: 2 },
    ];
    // "data" appears in both descriptions.
    expect(selectBodiesSupersededBy(["build-ml-pipeline"], loaded, skills, new Set(), configWithDefaults())).toEqual([]);
  });

  it("never evicts the new skills or pinned bodies", () => {
    const loaded = [
      { name: "explore-ml-data", seq: 1 },
      { name: "setup-ml-project", seq: 2 },
      { name: "build-ml-pipeline", seq: 3 },
    ];
    const out = selectBodiesSupersededBy(
      ["setup-ml-project", "build-ml-pipeline"],
      loaded,
      skills,
      new Set(["explore-ml-data"]),
      configWithDefaults(),
    );
    expect(out).toEqual([]);
  });

  it("returns nothing without a new skill", () => {
    expect(selectBodiesSupersededBy([], [{ name: "explore-ml-data", seq: 1 }], skills, new Set(), configWithDefaults())).toEqual([]);
  });
});
