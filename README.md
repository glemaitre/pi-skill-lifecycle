# Pi Skill Lifecycle

OpenCode-style skill loading for Pi: a `skill` tool, a binding skill protocol in
the prompt, and archiving of skill bodies that are no longer relevant.

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

Before each user prompt, loaded bodies are scored against it:

- pinned bodies are never evicted;
- the `minKeep` most recently loaded bodies are never evicted, so the skill
  being worked on survives replies such as "use pixi and call it housing";
- other bodies are evicted when their relevance score is below `threshold`;
- with `maxKeep` > 0, the oldest unprotected bodies are evicted beyond that cap.

When the model loads a skill in the middle of a run (for example after an
`ask_user_question` answer redirects the work), the other loaded bodies are
scored right away against the new skill's name and description, before the
next request of the same run:

- pinned bodies and the skills loaded in that turn are never evicted;
- `minKeep` does not apply, so the new skill replaces unrelated older ones;
- other bodies are evicted when their score is below `threshold`; `maxKeep`
  applies as above;
- loading a skill listed in `helperSkills` evicts nothing, so the skill that
  called it keeps its instructions. Helper bodies are evicted like any other
  body when a non-helper skill is loaded later.

Set `evictOnSkillLoad` to `false` to only evict at user prompts.

The entry skill (`entrySkill`) is pinned by default (`pinEntrySkill`): the
protocol sends the model back to it after every stage, so archiving it only
forces reloads.

### Why helpers and the entry pin

Measured by replaying 7 recorded ML sessions (about 200 to 300 requests each)
with Anthropic price ratios (cache read 0.1×, cache write 1.25×). Each
request is costed by prefix caching: archiving a body re-sends everything after
it uncached once.

| Strategy | Cost (relative) | Peak context | Reloads after archive |
|---|---|---|---|
| Keep every body (Pi default, OpenCode) | 100% | 100% | 0 |
| Evict on every mid-run load | 93% | 83% | 46 |
| + helpers + entry pin (bundled config) | 96% | 85% | 22 |

Evicting on every load is the cheapest, but it archives the skill driving the
work whenever it calls a helper, and the model works without those
instructions until it reloads them. Helpers and the entry pin halve the
reloads and keep most of the savings. Protecting the K most recent bodies
instead costs more than keeping everything: protected bodies are evicted later
anyway, so their cost is paid twice (re-sent on more requests, then a cache
miss when they are archived).

Short follow-ups and prompts on the same topic skip scoring. Scoring uses
keyword rules from the config, then description and name overlap (stopwords
ignored).

## Install

```bash
pi install ./pi-skill-lifecycle          # local checkout
pi install git:github.com/glemaitre/pi-skill-lifecycle
pi --extension ./pi-skill-lifecycle/extensions/index.ts   # try once
```

## Configuration

The extension reads `skill-lifecycle.json` from Pi's configuration directories,
like Pi's own `mcp.json`:

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
  "helperSkills": ["choose-python-library", "persist-ml-git"],
  "threshold": 0.15,
  "minKeep": 2,
  "maxKeep": 0,
  "pinned": [],
  "rules": [
    { "skillName": "explore-ml-data", "keywords": ["explore", "eda", "profile"], "weight": 1.5 }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `entrySkill` | `""` | Skill to load first for ambiguous requests; mentioned only if installed |
| `blockDirectSkillReads` | `true` | Block `read` on a known SKILL.md and point to the `skill` tool |
| `evictOnSkillLoad` | `true` | Evict unrelated bodies as soon as another skill is loaded mid-run |
| `helperSkills` | `[]` | Skills called for a sub-step; loading one mid-run evicts nothing |
| `pinEntrySkill` | `true` | Never evict the entry skill's body |
| `threshold` | `0.15` | Minimum relevance score (0..1) for an unprotected body to stay |
| `minKeep` | `2` | The N most recently loaded bodies are never evicted |
| `maxKeep` | `0` | Maximum number of loaded bodies (0 = unlimited) |
| `pinned` | `[]` | Skills whose bodies are never evicted |
| `rules` | `[]` | Keyword rules per skill (`skillName`, `keywords`, optional `weight`) |
| `verbose` | `true` | Notify when bodies are loaded or archived |
| `skipOnShortPrompts` | `true` | Skip scoring for very short follow-ups |
| `minScorablePromptLength` | `15` | Prompts shorter than this skip scoring |
| `topicChangeThreshold` | `0.7` | Token overlap above which a prompt counts as the same topic |

An invalid config file is reported and ignored. A `skill-lifecycle.json` at the
root of the working directory is not read.

### Use with the ML skill set

Copy the bundled [`skill-lifecycle.json`](skill-lifecycle.json) into the ML
workspace's `.pi/` directory so ambiguous requests go through `triage-ml-task`
(pinned), sub-step skills are declared as helpers, and the keyword rules apply:

```bash
mkdir -p path/to/ml-workspace/.pi
cp pi-skill-lifecycle/skill-lifecycle.json path/to/ml-workspace/.pi/
```

To use it in every project instead, copy it to `~/.pi/agent/`.

Without it, the protocol still applies, but no entry skill is named.

## Commands

| Command | Description |
|---|---|
| `/skills-pin <name>` | Never archive this skill's body (this session) |
| `/skills-unpin <name>` | Undo `/skills-pin` |
| `/skills-list` | Known skills with pinned, loaded, and helper status |
| `/skills-reload` | Reload `skill-lifecycle.json` |
| `/skills-on` / `/skills-off` | Enable or disable archiving |

## Limitations

- `bash` commands such as `cat SKILL.md` are not intercepted.
- Bodies loaded with `/skill:name` are injected by Pi into the user message and
  are not archived.
- Archiving a body changes an earlier message, so the provider's prompt cache is
  invalidated from that point once, on the request where the body is archived.
- `/skills-pin` pins last for the session; use `pinned` in the config to persist.

## Development

```bash
npm install
npm run typecheck
npm test            # unit + extension tests (fake API, Pi's real prompt builder)
npm run test:e2e    # real Pi process with an offline scripted provider
                    # PI_BIN=/path/to/pi selects the Pi executable
```

```
extensions/index.ts         events, skill tool, commands
extensions/rules.ts         pure logic: scoring, eviction, config
tests/rules.test.ts         rules.ts
tests/extension.test.ts     extension through a fake ExtensionAPI
tests/e2e/                  scripted provider + end-to-end test
```
