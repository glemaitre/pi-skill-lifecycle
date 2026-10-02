# Pi Skill Lifecycle

Dynamically load and unload Pi skills based on what you're working on. Only the skills relevant to the current conversation stay in the system prompt — saving context window, reducing noise, and helping the model focus.

## How it works

Before each model call, the extension scores every loaded skill against the user's latest prompt:

1. **Rule matching** — If a skill has explicit trigger keywords (from config), it checks those first.
2. **Description overlap** — As a fallback, it compares the skill's description against the prompt.
3. **Name boost** — If the skill's name appears in the prompt, it gets a lift.
4. **Filtering** — Skills below a relevance threshold are removed from the prompt.

Pinned skills (via config or `/skills-pin`) are always kept.

## Install

### From the GitHub repository (cloned locally)

```bash
git clone https://github.com/glemaitre/pi-skill-lifecycle.git
cd pi-skill-lifecycle
npm install                     # install dev deps (for running tests)
pi install .                    # install the Pi package from the local clone
```

### From a local path (e.g. checkout in your workspace)

```bash
pi install ./pi-skill-lifecycle
```

### From GitHub directly

```bash
pi install git:github.com/glemaitre/pi-skill-lifecycle
```

### Try once without installing

```bash
pi --extension ./pi-skill-lifecycle/extensions/index.ts
```

## Usage

### Commands

| Command | Description |
|---|---|
| `/skills-pin <name>` | Pin a skill so it's always kept |
| `/skills-unpin <name>` | Unpin a previously pinned skill |
| `/skills-list` | Show all known skills with their pinned status |
| `/skills-reload` | Reload `skill-lifecycle.json` config from disk |
| `/skills-on` | Re-enable automatic filtering (default) |
| `/skills-off` | Disable filtering — all skills visible |

### Configuration

Place a `skill-lifecycle.json` in your project root:

```json
{
  "threshold": 0.15,
  "minKeep": 2,
  "maxKeep": 0,
  "verbose": true,
  "pinned": ["build-ml-pipeline"],
  "rules": [
    {
      "skillName": "explore-ml-data",
      "keywords": ["explore", "eda", "profile", "data analysis", "understand data"],
      "weight": 1.5
    },
    {
      "skillName": "build-ml-pipeline",
      "keywords": ["pipeline", "model", "classifier", "regressor", "training", "fit"]
    },
    {
      "skillName": "evaluate-ml-pipeline",
      "keywords": ["evaluate", "cross-val", "cv", "score", "metric", "cross_validate"]
    },
    {
      "skillName": "audit-ml-pipeline",
      "keywords": ["audit", "report", "narrative", "review experiment", "skore"]
    },
    {
      "skillName": "frame-ml-problem",
      "keywords": ["metric to compare", "baseline", "split", "fold", "problem type"]
    },
    {
      "skillName": "smoke-test-ml-pipeline",
      "keywords": ["smoke test", "pytest", "test pipeline"]
    },
    {
      "skillName": "manage-ml-backlog",
      "keywords": ["backlog", "idea", "triage", "next experiment", "promote"]
    }
  ]
}
```

### Options

| Field | Default | Description |
|---|---|---|
| `threshold` | `0.15` | Minimum score (0–1) a skill needs to stay loaded |
| `minKeep` | `2` | Minimum number of skills to always keep |
| `maxKeep` | `0` | Maximum skills to keep (0 = unlimited) |
| `verbose` | `true` | Show notifications when skills are loaded/unloaded |
| `pinned` | `[]` | Skills always kept, regardless of prompt |
| `rules` | `[]` | Keyword rules mapping skill names to trigger keywords |

## Development

```bash
# Clone / cd into the package directory
cd pi-skill-lifecycle

# Install dev deps
npm install

# Run tests
npm test

# Watch mode
npm run test:watch
```

## Design

```
pi-skill-lifecycle/
├── extensions/
│   ├── index.ts        # Pi extension entry point — event hooks & commands
│   └── rules.ts        # Pure logic — scoring, filtering, config (no Pi imports)
├── tests/
│   └── rules.test.ts   # Unit tests for the relevance engine
├── package.json
├── tsconfig.json
└── README.md
```

The relevance engine in `rules.ts` is pure TypeScript with zero dependencies — it can be tested, reused, or embedded elsewhere without Pi.

## Publishing

To publish to npm:

```bash
# Make sure package.json has your details
npm publish
```

Then users install with:

```bash
pi install npm:pi-skill-lifecycle
```