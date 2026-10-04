/**
 * A small skill pack shaped like a real one: a router that mentions every
 * stage, stage skills with shared vocabulary ("ml", "pipeline", "data"), and
 * small helpers called from the stages.
 */

import type { IndexableSkill } from "../extensions/relevance.ts";

export const PACK_DIR = "/skills";

export const PACK: IndexableSkill[] = [
  {
    name: "triage-ml-task",
    description: "Route an ambiguous request to the right stage, or say what to do next.",
    body: [
      "# Triage ML Task",
      "",
      "You only route and ask.",
      "",
      "| Request | Skill |",
      "|---|---|",
      "| explore | `explore-ml-data` |",
      "| build | `build-ml-pipeline` |",
      "| evaluate | `evaluate-ml-pipeline` |",
      "| set up | `setup-ml-project` |",
      "| plot | `plot-ml-figure` |",
      "| commit | `persist-ml-git` |",
    ].join("\n"),
  },
  {
    name: "explore-ml-data",
    description: "Explore and profile the raw data: distributions, missing values, target leakage.",
    body: [
      "# Explore ML Data",
      "",
      "Profile every column of the dataset before modelling.",
      "",
      "## Steps",
      "",
      "Load `plot-ml-figure` before writing plot code. When done, load `persist-ml-git`.",
      "If there is no project, STOP and load `setup-ml-project`.",
    ].join("\n"),
  },
  {
    name: "build-ml-pipeline",
    description: "Build the ML pipeline from data source to predictor with skrub DataOps.",
    body: "# Build ML Pipeline\n\nDeclare the pipeline. Then load `evaluate-ml-pipeline`.\n",
  },
  {
    name: "evaluate-ml-pipeline",
    description: "Evaluate the ML pipeline with cross-validation and report metrics.",
    body: "# Evaluate ML Pipeline\n\nRun cross validation. Then load `persist-ml-git`.\n",
  },
  {
    name: "setup-ml-project",
    description: "Set up and bootstrap a new ML project workspace with pixi and git.",
    body: "# Setup ML Project\n\nScaffold the workspace. Then load `triage-ml-task`.\n",
  },
  {
    name: "plot-ml-figure",
    description: "Draw a chart or figure with matplotlib before custom plot code.",
    body: "# Plot ML Figure\n\nPick the chart type.\n",
  },
  {
    name: "persist-ml-git",
    description: "Commit the current stage with git when the end-turn hook says invoke.",
    body: "# Persist ML Git\n\nRun git commit.\n",
  },
].map((s) => ({ ...s, packDir: PACK_DIR }));
