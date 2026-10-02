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
    expect(explore.text).toContain("Previously loaded skill body");
    expect(setup.text).toContain("Instructions.");
  });
});
