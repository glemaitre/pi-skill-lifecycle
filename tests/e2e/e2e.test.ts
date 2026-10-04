/**
 * End-to-end test in a real Pi process with an offline scripted provider.
 *
 * Opt-in because it spawns Pi:  npm run test:e2e
 * PI_BIN selects the Pi executable (default: the `pi` on PATH).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const PI = process.env.PI_BIN ?? "pi";

const SCRIPT = [
  { tool: "read", args: { path: ".agents/skills/explore-ml-data/SKILL.md" } },
  { tool: "skill", args: { name: "explore-ml-data" } },
  { text: "loaded explore" },
  { tool: "skill", args: { name: "setup-ml-project" } },
  { text: "loaded setup" },
];

const SKILLS = {
  "triage-ml-task": "Route an ambiguous request to the right skill.",
  "explore-ml-data": "Explore and profile the data before modelling.",
  "setup-ml-project": "Set up and bootstrap a new ML workspace.",
};

describe.skipIf(!process.env.PI_E2E)("pi end-to-end", () => {
  let workspace: string;
  let requests: any[];

  function runPi(prompt: string, extraArgs: string[] = []) {
    execFileSync(
      PI,
      [
        "-p", "--offline", "--approve", "--no-extensions",
        "-e", join(ROOT, "extensions", "index.ts"),
        "-e", join(ROOT, "tests", "e2e", "scripted-provider.ts"),
        "--model", "scripted/m",
        "--session-dir", join(workspace, "sessions"),
        ...extraArgs,
        prompt,
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          // Fresh agent dir: no user settings, packages, or config leak into the run.
          PI_CODING_AGENT_DIR: join(workspace, "agent"),
          E2E_LOG: join(workspace, "requests.jsonl"),
          E2E_SCRIPT: JSON.stringify(SCRIPT),
        },
        stdio: "pipe",
        timeout: 60_000,
      },
    );
  }

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "skill-lifecycle-e2e-"));
    for (const [name, description] of Object.entries(SKILLS)) {
      const dir = join(workspace, ".agents", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${"Instructions. ".repeat(400)}\n`);
    }
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(join(workspace, ".pi", "skill-lifecycle.json"), JSON.stringify({ entrySkill: "triage-ml-task", minKeep: 1 }));

    runPi("I would like to explore the data");
    runPi("now set up the project workspace", ["--continue"]);
    runPi("bootstrap and scaffold the new project workspace", ["--continue"]);

    requests = readFileSync(join(workspace, "requests.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  }, 200_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const skillResults = (request: any) => request.messages.filter((m: any) => m.toolName === "skill");

  it("renders one skills section with the protocol and the entry skill", () => {
    const system: string = requests[0].system[0];
    expect(system.match(/<skills>/g)).toHaveLength(1);
    expect(system).toContain('skill("triage-ml-task")');
    expect(system).not.toContain("Use the read tool to load a skill's file");
  });

  it("blocks the direct SKILL.md read and loads the body through the tool", () => {
    const read = requests[1].messages.find((m: any) => m.toolName === "read");
    expect(read.isError).toBe(true);
    expect(read.text).toContain('skill("explore-ml-data")');
    expect(skillResults(requests[2])[0].text).toContain('<skill_content name="explore-ml-data">');
  });

  it("never adds a system prompt update across turns and processes", () => {
    for (const request of requests) expect(request.system).toHaveLength(1);
  });

  it("keeps the resumed body, then archives it once the topic moves on", () => {
    const resumed = requests[3];
    expect(skillResults(resumed)[0].text).toContain("Instructions.");

    const last = requests[requests.length - 1];
    const [explore, setup] = skillResults(last);
    expect(explore.text).toContain("Skill body archived");
    expect(setup.text).toContain("Instructions.");
  });
});

/**
 * Mid-run eviction: one user prompt, the model loads a skill, gets an answer
 * from the user (a bash echo stands in for ask_user_question), then loads an
 * unrelated skill. The first body is archived within the same run.
 */
describe.skipIf(!process.env.PI_E2E)("pi end-to-end: mid-run skill switch", () => {
  const MID_RUN_SCRIPT = [
    { tool: "skill", args: { name: "explore-ml-data" } },
    { tool: "bash", args: { command: "echo 'answer: there is no project yet'" } },
    { tool: "skill", args: { name: "setup-ml-project" } },
    { text: "switched to setup" },
  ];
  let workspace: string;
  let requests: any[];

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "skill-lifecycle-e2e-midrun-"));
    for (const [name, description] of Object.entries(SKILLS)) {
      const dir = join(workspace, ".agents", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${"Instructions. ".repeat(400)}\n`);
    }
    execFileSync(
      PI,
      [
        "-p", "--offline", "--approve", "--no-extensions",
        "-e", join(ROOT, "extensions", "index.ts"),
        "-e", join(ROOT, "tests", "e2e", "scripted-provider.ts"),
        "--model", "scripted/m",
        "--session-dir", join(workspace, "sessions"),
        "I would like to explore the data",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(workspace, "agent"),
          E2E_LOG: join(workspace, "requests.jsonl"),
          E2E_SCRIPT: JSON.stringify(MID_RUN_SCRIPT),
        },
        stdio: "pipe",
        timeout: 60_000,
      },
    );
    requests = readFileSync(join(workspace, "requests.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  }, 100_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const skillResults = (request: any) => request.messages.filter((m: any) => m.toolName === "skill");

  it("keeps the first body while it is the only skill in use", () => {
    // Request after the bash answer: explore is still the active skill.
    expect(skillResults(requests[2])[0].text).toContain("Instructions.");
  });

  it("archives the first body as soon as an unrelated skill is loaded", () => {
    const last = requests[3];
    expect(last.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    const [explore, setup] = skillResults(last);
    expect(explore.text).toContain("Skill body archived");
    expect(setup.text).toContain("Instructions.");
  });
});

/**
 * Helper skills: explore-ml-data calls a helper (setup-ml-project is declared
 * as a helper here). The helper load must not archive the calling skill.
 */
describe.skipIf(!process.env.PI_E2E)("pi end-to-end: helper skill", () => {
  const HELPER_SCRIPT = [
    { tool: "skill", args: { name: "explore-ml-data" } },
    { tool: "skill", args: { name: "setup-ml-project" } },
    { text: "used the helper" },
  ];
  let workspace: string;
  let requests: any[];

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "skill-lifecycle-e2e-helper-"));
    for (const [name, description] of Object.entries(SKILLS)) {
      const dir = join(workspace, ".agents", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${"Instructions. ".repeat(400)}\n`);
    }
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(join(workspace, ".pi", "skill-lifecycle.json"), JSON.stringify({ helperSkills: ["setup-ml-project"] }));
    execFileSync(
      PI,
      [
        "-p", "--offline", "--approve", "--no-extensions",
        "-e", join(ROOT, "extensions", "index.ts"),
        "-e", join(ROOT, "tests", "e2e", "scripted-provider.ts"),
        "--model", "scripted/m",
        "--session-dir", join(workspace, "sessions"),
        "I would like to explore the data",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(workspace, "agent"),
          E2E_LOG: join(workspace, "requests.jsonl"),
          E2E_SCRIPT: JSON.stringify(HELPER_SCRIPT),
        },
        stdio: "pipe",
        timeout: 60_000,
      },
    );
    requests = readFileSync(join(workspace, "requests.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  }, 100_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it("keeps the calling skill's body after the helper is loaded", () => {
    const last = requests.at(-1);
    const [explore, helper] = last.messages.filter((m: any) => m.toolName === "skill");
    expect(explore.text).toContain("Instructions.");
    expect(helper.text).toContain("Instructions.");
  });
});
