# @probabl/pi-skill-lifecycle

OpenCode-style skill loading for Pi: a `skill` tool, a binding skill protocol in
the prompt, and archiving of skill bodies that are no longer relevant. It needs
no configuration: relevance and skill roles are derived from the installed
skills.

## Why

With Pi's default prompt, a model treats skills as reference material: it reads
a SKILL.md, then may skip its stop conditions ("STOP when there is no scaffold,
send to setup") and improvise. OpenCode tells the model to load skills through
a dedicated tool and keeps the skill guidance separate from the core prompt.
This extension brings that pattern to Pi and keeps loaded skill bodies from
accumulating in the context window.

## What it changes

Pi already lists each skill by name, description, and location, and tells the
model to `read` the SKILL.md when a task matches. This extension:

1. **Replaces the prompt's `skills` section** with the same listing plus a
   short protocol: load skills with the `skill` tool, route ambiguous requests
   through an optional entry skill, and treat a skill's stop conditions as
   binding. The section does not change between turns, so it never adds a
   prompt update and does not break prompt caching.
2. **Adds a `skill` tool** that returns the body (without frontmatter) wrapped
   in `<skill_content>`, with its base directory and top-level files.
3. **Blocks direct `read` calls on a known SKILL.md** and tells the model to
   call `skill("<name>")` instead, so every body goes through the tool. Reading
   files a skill references (`references/`, `templates/`, …) stays allowed.
4. **Archives skill bodies** before each LLM request. A body is replaced by a
   short placeholder when it was loaded again later (only the latest copy is
   kept) or when it was evicted. The session file keeps the original results,
   so archiving is per request and reversible; resume, fork, and `/tree`
   rebuild the state from the session branch.
5. **Needs no configuration.** No keyword list, weight, or helper list is
   needed: relevance comes from an index built from the skills' names,
   descriptions, and headings, and the entry skill is inferred from
   cross-references (see [How relevance is derived](#how-relevance-is-derived)).
   A config file can still override any of it.

If the `skill` tool is not active (for example `--tools read,bash`), Pi's
default listing is left unchanged and no read is blocked.

### Token cost

The listing costs about the same as Pi's default (the protocol adds about 450
characters). With 28 skills whose descriptions total 14k characters, every
request carries about 5k tokens of listing either way. Short descriptions are
the only way to lower that.

The savings come from bodies: a loaded body stays in every later request until
it is archived. In the ML skill set, bodies have a median of 5.7k characters and
a maximum of 34k characters.

### Eviction

Before each user prompt, loaded bodies are judged against it:

- pinned bodies are never evicted;
- the `minKeep` most recently loaded bodies are never evicted, so the skill
  being worked on survives replies such as "use pixi and call it housing";
- other bodies are evicted when their skill is not relevant to the prompt;
- when the prompt carries no topic signal ("the frobnicator broke"), nothing
  is evicted for relevance: no evidence is not evidence of irrelevance;
- with `maxKeep` > 0, the oldest unprotected bodies are evicted beyond that cap.

When the model loads a skill in the middle of a run (for example after an
`ask_user_question` answer redirects the work), the other loaded bodies are
judged right away against the new skill's name and description, before the
next request of the same run:

- pinned bodies and the skills loaded in that turn are never evicted;
- `minKeep` does not apply, so the new skill replaces unrelated older ones;
- other bodies are evicted when they are not relevant to the new skill;
  `maxKeep` applies as above;
- loading a helper skill evicts nothing, so the skill that called it keeps
  its instructions. Helper bodies are evicted like any other body when a
  non-helper skill is loaded later.

Set `evictOnSkillLoad` to `false` to only evict at user prompts.

The entry skill is pinned by default (`pinEntrySkill`): the protocol sends
the model back to it after every stage, so archiving it only forces reloads.

Short follow-ups and prompts on the same topic skip judging.

### How relevance is derived

When Pi starts a run, the extension indexes every model-invocable skill. The
index is cached and rebuilt only when a SKILL.md changes or a skill is added
or removed.

- **Terms**: stemmed words and word pairs ("cross_validat") from the name
  (weight 3), the description (weight 2), and the body headings (weight 1).
  Headings of negative sections ("When not to use") are skipped. Prose is
  not indexed: in the measured skill pack, skills share procedural vocabulary
  ("run", "stage", "workspace") and indexing paragraphs made decisions worse.
- **Weights**: BM25 over the installed skills. A word shared by many skills
  ("pipeline") counts little, a rare one ("matplotlib") a lot, so there are no
  weights to write.
- **Decision**: a body stays when its skill ranks in the top `topK` (3) of all
  installed skills for the prompt, or scores at least `relativeScore` (50%) of
  the best one. Ranks and fractions do not depend on the number of skills or
  on description lengths, unlike an absolute threshold. A best score below
  `minSignal` means the prompt has no topic signal: nothing is evicted.
- **Entry skill**, first match wins: `entrySkill` in the config; a skill whose
  frontmatter declares `metadata.role: entry`; a router inferred from
  cross-references, i.e. the skill whose body names at least 75% of the other
  skills in its directory and 1.5× as many as the runner-up. Without a clear
  winner there is no entry skill. Set `inferEntrySkill` to `false` to disable
  inference.
- **Helper skills**: skills whose frontmatter declares `metadata.role: helper`,
  plus `helperSkills` from the config. Most packs need neither: a helper
  related to its caller (for example `plot-ml-figure` and `explore-ml-data`)
  keeps it through relevance.

`/skills-explain <prompt>` shows the ranking, the matched terms, and what
would happen to each loaded body.

Declaring roles in a skill:

```yaml
---
name: persist-ml-git
description: Commit the current stage with git.
metadata:
  role: helper   # or: entry
---
```

### Measured

Measured by replaying 7 recorded sessions of an ML skill pack (28 skills,
1316 requests) with `npm run replay`. Each request is costed by prefix
caching with Anthropic price ratios (cache read 0.1×, cache write 1.25×):
archiving a body re-sends everything after it uncached once. When a strategy
archived a body the model then kept using (an *orphan use*: a tool call in
that skill's directory), the replay adds the reload a model following the
protocol would make, so wrong evictions pay their price.

| Strategy | Cost | Peak context | Reloads | Orphan uses |
|---|---|---|---|---|
| Keep every body (Pi default, OpenCode) | 100% | 100% | 0 | 0 |
| v0.1, no config | 91.9% | 76.5% | 16 | 8 |
| v0.1, hand-written ML config (keywords, helpers, entry) | 102.5% | 78.7% | 3 | 2 |
| **Derived, no config** | **89.3%** | **74.7%** | 5 | 3 |
| Derived + the hand-written ML config | 98.1% | 77.3% | 5 | 3 |

With no config, the derived index is the cheapest strategy measured, with
about as few reloads as the hand-written config. Adding the old keyword rules
and helper list on top only adds cost. Disabling entry inference doubles the
reloads (11), and protecting every skill that mentions the loaded one by name
(`protectCallers`) brings the cost back to 99.8%: in this pack, stage skills
name most other skills, so mentions do not separate sub-steps from handoffs.

The defaults (`topK` 3, `relativeScore` 0.5) sit in a stable region of a grid
search; they were tuned on one skill pack.

## Install

```bash
pi install npm:@probabl/pi-skill-lifecycle
pi install ./pi-skill-lifecycle          # local checkout
pi --extension ./pi-skill-lifecycle/extensions/index.ts   # try once
```

## Configuration

No configuration is needed. To override what is derived, the extension reads
`skill-lifecycle.json` from Pi's configuration directories, like Pi's own
`mcp.json`:

| File | Scope |
|---|---|
| `~/.pi/agent/skill-lifecycle.json` | Every project (follows `PI_CODING_AGENT_DIR`) |
| `.pi/skill-lifecycle.json` | This project; read only once the project is [trusted](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md) |

Both are optional. Project keys override user keys one by one (a project
`rules` list replaces the user list). `/skills-list` shows which files were
read; `/skills-reload` rereads them.

Example:

```json
{
  "entrySkill": "triage-ml-task",
  "helperSkills": ["persist-ml-git"],
  "rules": [
    { "skillName": "explore-ml-data", "keywords": ["eda", "profile"], "weight": 1.5 }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `topK` | `3` | A body stays when its skill ranks in the top N of all installed skills |
| `relativeScore` | `0.5` | …or scores at least this fraction of the best-scoring skill |
| `minSignal` | `2` | Best score below this means the prompt has no topic signal; nothing is evicted |
| `inferEntrySkill` | `true` | Infer the entry skill from cross-references when none is declared |
| `entrySkill` | `""` | Entry skill; overrides the frontmatter and inference; mentioned only if installed |
| `pinEntrySkill` | `true` | Never evict the entry skill's body |
| `helperSkills` | `[]` | Helpers in addition to `metadata.role: helper`; loading one mid-run evicts nothing |
| `protectCallers` | `false` | On a mid-run load, keep bodies whose skill names the loaded skill |
| `rules` | `[]` | Keyword rules (`skillName`, `keywords`, optional `weight`) that keep a body when they match |
| `threshold` | `0.15` | Minimum rule score (matched keyword fraction × weight) for a rule to keep a body |
| `pinned` | `[]` | Skills whose bodies are never evicted |
| `minKeep` | `2` | The N most recently loaded bodies are never evicted at a user prompt |
| `maxKeep` | `0` | Maximum number of loaded bodies (0 = unlimited) |
| `evictOnSkillLoad` | `true` | Evict unrelated bodies as soon as another skill is loaded mid-run |
| `blockDirectSkillReads` | `true` | Block `read` on a known SKILL.md and point to the `skill` tool |
| `verbose` | `true` | Notify when bodies are loaded or archived |
| `skipOnShortPrompts` | `true` | Skip judging for very short follow-ups |
| `minScorablePromptLength` | `15` | Prompts shorter than this skip judging |
| `topicChangeThreshold` | `0.7` | Word overlap above which a prompt counts as the same topic |

An invalid config file is reported and ignored. A `skill-lifecycle.json` at the
root of the working directory is not read.

## Commands

| Command | Description |
|---|---|
| `/skills-pin <name>` | Never archive this skill's body (this session) |
| `/skills-unpin <name>` | Undo `/skills-pin` |
| `/skills-list` | Known skills with pinned and loaded status, and their roles with the source (config, frontmatter, inferred) |
| `/skills-explain <prompt>` | Ranking of the skills for a prompt, matched terms, and what would happen to each loaded body |
| `/skills-reload` | Reload `skill-lifecycle.json` |
| `/skills-on` / `/skills-off` | Enable or disable archiving |

## Limitations

- `bash` commands such as `cat SKILL.md` are not intercepted.
- Bodies loaded with `/skill:name` are injected by Pi into the user message and
  are not archived.
- Archiving a body changes an earlier message, so the provider's prompt cache is
  invalidated from that point once, on the request where the body is archived.
- `/skills-pin` pins last for the session; use `pinned` in the config to persist.
- Relevance is lexical: "fit a model" does not match a skill that only says
  "estimator". Prompts in another language than the skills mostly match
  nothing, so nothing is evicted at those prompts (mid-run loads still are).
- Entry inference relies on the router naming the other skills; a pack that
  routes differently needs `metadata.role: entry` or `entrySkill`.

## Development

```bash
npm install
npm run typecheck
npm test            # unit + extension tests (fake API, Pi's real prompt builder)
npm run test:e2e    # real Pi process with an offline scripted provider
                    # PI_BIN=/path/to/pi selects the Pi executable
npm run replay -- --skills <skills-dir> [--config name=file.json] ~/.pi/agent/sessions/<project>/*.jsonl
                    # replay recorded sessions and compare strategies
```

```
extensions/index.ts         events, skill tool, commands, index cache
extensions/relevance.ts     pure logic: terms, BM25 index, references, roles
extensions/rules.ts         pure logic: config, roles, eviction decisions
scripts/replay.ts           replay recorded sessions through the extension
tests/relevance.test.ts     relevance.ts
tests/rules.test.ts         rules.ts
tests/extension.test.ts     extension through a fake ExtensionAPI
tests/e2e/                  scripted provider + end-to-end test
```
