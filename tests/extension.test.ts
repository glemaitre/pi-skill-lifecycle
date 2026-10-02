/**
 * Integration tests for the extension entry point.
 *
 * The extension is driven through a fake `ExtensionAPI`, but the system prompt
 * is rendered with Pi's real builder and section differ so the assertions
 * reflect what Pi actually sends to the model.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Skill as PiSkill } from "@earendil-works/pi-coding-agent";
// Not part of Pi's public exports; imported by path so the tests use the real
// prompt builder rather than a re-implementation.
import {
  buildSystemPromptSections,
  diffSystemPromptSections,
  normalizeBuildSystemPromptOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import extension from "../extensions/index.ts";

// ── Fixtures ──────────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => any;

interface SkillSpec {
  name: string;
  description: string;
  body?: string;
  disableModelInvocation?: boolean;
}

function writeSkills(root: string, specs: SkillSpec[]): PiSkill[] {
  return specs.map((spec) => {
    const baseDir = join(root, ".agents", "skills", spec.name);
    mkdirSync(join(baseDir, "references"), { recursive: true });
    const filePath = join(baseDir, "SKILL.md");
    writeFileSync(
      filePath,
      `---\nname: ${spec.name}\ndescription: ${spec.description}\n---\n\n${spec.body ?? `Body of ${spec.name}.`}\n`,
    );
    writeFileSync(join(baseDir, "references", "notes.md"), "notes");
    return {
      name: spec.name,
      description: spec.description,
      filePath,
      baseDir,
      sourceInfo: { path: filePath, source: "project", scope: "project", origin: "top-level" } as any,
      disableModelInvocation: spec.disableModelInvocation ?? false,
    };
  });
}

const SPECS: SkillSpec[] = [
  { name: "triage-ml-task", description: "Route an ambiguous request to the right skill." },
  { name: "explore-ml-data", description: "Explore and profile the data before modelling." },
  { name: "setup-ml-project", description: "Set up and bootstrap a new ML workspace." },
  { name: "build-ml-pipeline", description: "Build a skrub pipeline for the predictor." },
  { name: "hidden-skill", description: "Only invoked by an explicit command.", disableModelInvocation: true },
];

function createHarness(
  cwd: string,
  skills: PiSkill[],
  activeTools = ["read", "bash", "edit", "write", "skill"],
  trusted = true,
) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  let branch: any[] = [];
  let previousSections: Record<string, string> | undefined;
  let callCounter = 0;

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    getActiveTools: () => activeTools,
  } as unknown as ExtensionAPI;

  extension(pi);

  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getBranch: () => branch },
    isProjectTrusted: () => trusted,
  };

  async function emit(event: string, payload: any) {
    let result: any;
    for (const handler of handlers.get(event) ?? []) {
      const value = await handler(payload, ctx);
      if (value !== undefined) result = value;
    }
    return result;
  }

  /** Emulate one user prompt: fresh options per run, exactly like Pi. */
  async function prompt(text: string) {
    const options = normalizeBuildSystemPromptOptions({
      cwd,
      selectedTools: activeTools,
      skills,
    });
    await emit("before_agent_start", {
      type: "before_agent_start",
      prompt: text,
      systemPrompt: "",
      systemPromptOptions: options,
    });
    const sections = buildSystemPromptSections(options);
    const patch = previousSections ? diffSystemPromptSections(previousSections, sections) : undefined;
    previousSections = sections;
    return { sections, patch };
  }

  /** Call the `skill` tool and return a transcript tool-result message. */
  async function loadSkill(name: string) {
    const toolCallId = `call-${++callCounter}`;
    const result = await tools.get("skill").execute(toolCallId, { name }, undefined, undefined, ctx);
    return {
      role: "toolResult",
      toolCallId,
      toolName: "skill",
      content: result.content,
      isError: false,
      timestamp: Date.now(),
    };
  }

  async function context(messages: any[]) {
    const result = await emit("context", { type: "context", messages });
    return result?.messages ?? messages;
  }

  return {
    pi,
    ctx,
    tools,
    commands,
    notifications,
    emit,
    prompt,
    loadSkill,
    context,
    setBranch: (entries: any[]) => {
      branch = entries;
    },
  };
}

function textOf(message: any): string {
  return message.content.map((block: any) => block.text ?? "").join("");
}

function isPlaceholder(message: any): boolean {
  return textOf(message).includes("Previously loaded skill body");
}

// ── Tests ─────────────────────────────────────────────────────────

let root: string;
let agentDir: string;
let skills: PiSkill[];
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-lifecycle-"));
  // Isolate from the developer's real ~/.pi/agent.
  agentDir = mkdtempSync(join(tmpdir(), "skill-lifecycle-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  skills = writeSkills(root, SPECS);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function writeProjectConfig(config: object) {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "skill-lifecycle.json"), JSON.stringify(config));
}

async function startSession(config?: object, activeTools?: string[], trusted = true) {
  if (config) writeProjectConfig(config);
  const harness = createHarness(root, skills, activeTools, trusted);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  return harness;
}

describe("system prompt", () => {
  it("lists model-invocable skills once, without double-wrapped tags", async () => {
    const h = await startSession();
    const { sections } = await h.prompt("hello");
    const skillsSection = sections.skills;

    expect(skillsSection.startsWith("<skills>\n")).toBe(true);
    expect(skillsSection).not.toMatch(/<skills>\s*<skills>/);
    expect(skillsSection.match(/<available_skills>/g)).toHaveLength(1);
    expect(skillsSection).toContain("<name>explore-ml-data</name>");
    expect(skillsSection).not.toContain("hidden-skill");
    expect(skillsSection).not.toContain("Body of explore-ml-data");
    expect(skillsSection).toContain("skill tool");
    // The default "use the read tool to load a skill" instruction is replaced.
    expect(skillsSection).not.toContain("Use the read tool to load a skill's file");
    expect(Object.keys(sections).filter((name) => name.includes("skill"))).toEqual(["skills"]);
  });

  it("keeps the skill section identical across turns (no removal patch)", async () => {
    const h = await startSession();
    await h.prompt("explore the data please");
    const second = await h.prompt("now build a pipeline for the predictor");
    expect(second.patch).toBeUndefined();
  });

  it("mentions the entry skill only when it is configured and installed", async () => {
    const withEntry = await startSession({ entrySkill: "triage-ml-task" });
    expect((await withEntry.prompt("hi")).sections.skills).toContain('skill("triage-ml-task")');

    const missingEntry = await startSession({ entrySkill: "does-not-exist" });
    expect((await missingEntry.prompt("hi")).sections.skills).not.toContain("does-not-exist");

    rmSync(join(root, ".pi", "skill-lifecycle.json"));
    const noEntry = await startSession();
    expect((await noEntry.prompt("hi")).sections.skills).not.toContain("triage-ml-task\")");
  });

  it("keeps Pi's default listing when the skill tool is not active", async () => {
    const h = await startSession(undefined, ["read", "bash"]);
    const { sections } = await h.prompt("hello");
    expect(sections.skills).toContain("Use the read tool to load a skill's file");
    const blocked = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "t0",
      toolName: "read",
      input: { path: ".agents/skills/explore-ml-data/SKILL.md" },
    });
    expect(blocked?.block).toBeFalsy();
  });
});

describe("skill tool", () => {
  it("returns the body wrapped in <skill_content> with base directory and files", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const message = await h.loadSkill("explore-ml-data");
    const text = textOf(message);
    expect(text).toContain('<skill_content name="explore-ml-data">');
    expect(text).toContain("Body of explore-ml-data.");
    expect(text).toContain(`Base directory for this skill: ${join(root, ".agents", "skills", "explore-ml-data")}`);
    expect(text).toContain("references/");
    // Frontmatter is already in the prompt listing; do not pay for it twice.
    expect(text).not.toContain("description: Explore and profile");
  });

  it("throws for unknown and command-only skills so Pi marks the result as an error", async () => {
    const h = await startSession();
    await h.prompt("hello");
    await expect(h.loadSkill("nope")).rejects.toThrow(/not found/);
    await expect(h.loadSkill("hidden-skill")).rejects.toThrow(/\/skill:hidden-skill/);
  });
});

describe("context handler", () => {
  it("keeps only the latest copy of a skill body that was loaded twice", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const first = await h.loadSkill("explore-ml-data");
    const second = await h.loadSkill("explore-ml-data");
    const out = await h.context([first, second]);
    expect(isPlaceholder(out[0])).toBe(true);
    expect(isPlaceholder(out[1])).toBe(false);
  });

  it("only rewrites results of the skill tool", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const readResult = {
      role: "toolResult",
      toolCallId: "r1",
      toolName: "read",
      content: [{ type: "text", text: '<skill_content name="explore-ml-data"> quoted in a file' }],
      isError: false,
      timestamp: 0,
    };
    const out = await h.context([readResult]);
    expect(out[0]).toBe(readResult);
  });

  it("does nothing when eviction is disabled", async () => {
    const h = await startSession();
    await h.commands.get("skills-off").handler("", h.ctx);
    await h.prompt("explore the data");
    const first = await h.loadSkill("explore-ml-data");
    const second = await h.loadSkill("explore-ml-data");
    const out = await h.context([first, second]);
    expect(out.some(isPlaceholder)).toBe(false);
  });
});

describe("eviction", () => {
  it("does not evict the skill being worked on when the user answers its questions", async () => {
    const h = await startSession();
    await h.prompt("set up the project");
    const body = await h.loadSkill("setup-ml-project");
    // A reply to the skill's own questions shares no keywords with it.
    await h.prompt("use pixi and call the package housing please");
    const out = await h.context([body]);
    expect(isPlaceholder(out[0])).toBe(false);
  });

  it("evicts older irrelevant bodies beyond minKeep", async () => {
    const h = await startSession({ minKeep: 1 });
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.prompt("set up the project workspace");
    const setup = await h.loadSkill("setup-ml-project");
    await h.prompt("bootstrap and scaffold the new project workspace");
    const out = await h.context([explore, setup]);
    expect(isPlaceholder(out[0])).toBe(true);
    expect(isPlaceholder(out[1])).toBe(false);
  });

  it("never evicts pinned bodies", async () => {
    const h = await startSession({ minKeep: 0 });
    await h.commands.get("skills-pin").handler("explore-ml-data", h.ctx);
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.prompt("bootstrap and scaffold the new project workspace");
    const out = await h.context([explore]);
    expect(isPlaceholder(out[0])).toBe(false);
  });

  it("restores loaded bodies from the session branch on resume", async () => {
    const first = await startSession();
    await first.prompt("explore the data");
    const body = await first.loadSkill("explore-ml-data");

    const resumed = createHarness(root, skills);
    resumed.setBranch([{ type: "message", id: "e1", message: body }]);
    await resumed.emit("session_start", { type: "session_start", reason: "resume" });
    await resumed.prompt("ok");
    const out = await resumed.context([body]);
    expect(isPlaceholder(out[0])).toBe(false);
  });
});

describe("direct SKILL.md reads", () => {
  it("blocks reading a known SKILL.md and points to the skill tool", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const result = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "read",
      input: { path: ".agents/skills/explore-ml-data/SKILL.md" },
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('skill("explore-ml-data")');
  });

  it("allows reading files referenced by a skill", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const result = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "t2",
      toolName: "read",
      input: { path: join(root, ".agents", "skills", "explore-ml-data", "references", "notes.md") },
    });
    expect(result?.block).toBeFalsy();
  });

  it("can be turned off in the config", async () => {
    const h = await startSession({ blockDirectSkillReads: false });
    await h.prompt("explore the data");
    const result = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "t3",
      toolName: "read",
      input: { path: ".agents/skills/explore-ml-data/SKILL.md" },
    });
    expect(result?.block).toBeFalsy();
  });
});

describe("config location", () => {
  it("reads the user config from the agent directory", async () => {
    writeFileSync(join(agentDir, "skill-lifecycle.json"), JSON.stringify({ entrySkill: "triage-ml-task" }));
    const h = await startSession();
    expect((await h.prompt("hi")).sections.skills).toContain('skill("triage-ml-task")');
  });

  it("lets the project .pi config override the user config key by key", async () => {
    writeFileSync(
      join(agentDir, "skill-lifecycle.json"),
      JSON.stringify({ entrySkill: "triage-ml-task", blockDirectSkillReads: false }),
    );
    const h = await startSession({ entrySkill: "setup-ml-project" });
    const { sections } = await h.prompt("explore the data");
    expect(sections.skills).toContain('skill("setup-ml-project")');
    expect(sections.skills).not.toContain('skill("triage-ml-task")');
    // Not overridden by the project file, so the user value still applies.
    const result = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "c1",
      toolName: "read",
      input: { path: ".agents/skills/explore-ml-data/SKILL.md" },
    });
    expect(result?.block).toBeFalsy();
  });

  it("ignores the project config until the project is trusted, and says so", async () => {
    const h = await startSession({ entrySkill: "triage-ml-task" }, undefined, false);
    expect((await h.prompt("hi")).sections.skills).not.toContain('skill("triage-ml-task")');
    expect(h.notifications.some((n) => n.includes("ignored until the project is trusted"))).toBe(true);
  });

  it("no longer reads skill-lifecycle.json from the working directory root", async () => {
    writeFileSync(join(root, "skill-lifecycle.json"), JSON.stringify({ entrySkill: "triage-ml-task" }));
    const h = await startSession();
    expect((await h.prompt("hi")).sections.skills).not.toContain('skill("triage-ml-task")');
  });

  it("reports an invalid config file and falls back to defaults", async () => {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "skill-lifecycle.json"), "{ not json");
    const h = await startSession();
    await h.prompt("hi");
    expect(h.notifications.some((n) => n.includes("ignoring invalid"))).toBe(true);
  });

  it("lists the config sources in /skills-list", async () => {
    writeFileSync(join(agentDir, "skill-lifecycle.json"), "{}");
    const h = await startSession({ minKeep: 1 });
    await h.prompt("hi");
    await h.commands.get("skills-list").handler("", h.ctx);
    const listing = h.notifications.at(-1)!;
    expect(listing).toContain(join(agentDir, "skill-lifecycle.json"));
    expect(listing).toContain(join(root, ".pi", "skill-lifecycle.json"));
  });
});
