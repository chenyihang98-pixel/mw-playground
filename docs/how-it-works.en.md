<h3 align="center">
  <a href="how-it-works.md">日本語</a> &nbsp;|&nbsp; <a href="how-it-works.zh.md">简体中文</a> &nbsp;|&nbsp; English
</h3>

# How the Level Workshop works

You write a sentence and get a level. This page covers what is left to the model and what the code does, picking up from the diagram in the [README](../README.en.md).

## The model only writes a brief

The model never writes coordinates. Not clipping into walls, every gem being reachable on foot, patrol routes that can actually be walked: geometry like this is more dependable when code builds it and checks it. The model gets one job, turning words into a small set of options.

This is everything in the "level brief" the model writes.

| Field | Options |
|---|---|
| Map size | small / medium / large |
| Obstacle density | low / mid / high |
| Platforms | 0 to 4 |
| Gems: how many and where | scattered / along the edge / only on platforms / clustered |
| Guards: how many and how they patrol | loop / back and forth |
| Difficulty | relaxed / normal / tense |
| Look | grass, sand, snow × day, dusk, night × clear, fog, rain |
| Cast | who from the roster, as a companion or a guard, with one line each |
| Title and opening | short free text |

The output is constrained by a JSON Schema and validated again with zod once it arrives. Extra fields are rejected, so even if the model adds coordinates or a time limit, they don't get in.

## Rules a schema can't express

A schema handles types and ranges. Rules about combinations are checked separately.

| Map | Gems | Guards |
|---|---|---|
| small | 2 to 5 | 1 at most |
| medium | 3 to 7 | 2 at most |
| large | 4 to 9 | 3 at most |

- With gems "only on platforms", each platform holds 2 at most
- 3 companions at most
- Only characters you ticked for this request can appear, and only in the roles you allowed

## The flow

The LangGraph graph has six steps (`server/graph.ts`).

1. **Read the request**: the model calls the roster tool if it decides it needs to
2. **Write the brief**: structured output
3. **Check**: types and ranges, combination rules, cast and roles
4. **Build the layout and check it**: a generator that gives the same result for the same seed, and a checker written separately from it
5. **Preview**: stops here and waits for the player
6. **Save**: resumes on confirm and saves

## When it doesn't work

Different failures are handled differently.

- **The brief breaks a rule**: the model is told which field and why. It gets three attempts at the brief in total (the first one plus two fixes)
- **Things don't fit or are too far apart**: the code retries a few times and adjusts the conditions once. Only then does it go back to the model
- **The checker rejects a layout the generator produced**: that is a bug in the code. It is reported as an error and not sent to the model
- **Three failed attempts, or a timeout**: the game falls back to a built-in level and shows the reason and how it differs from the request

## Preview and confirm

The preview step pauses on a LangGraph interrupt and resumes with `Command({ resume })` when the player confirms.

- Confirming doesn't call the model. What is saved is the exact layout shown in the preview
- Confirming twice in a row saves once
- If you discard or redo while a confirm is still in flight, the late result is dropped
- An unconfirmed preview is kept in the service's memory (MemorySaver). It is gone after a restart, and the UI asks you to generate again

On resume, the step containing the interrupt runs again from its start. So that step does nothing but computation before it pauses.

## The roster tool

The model has a single tool, `lookup_roster`, and it is read-only.

- It returns the characters ticked for this request (display name and allowed roles). It doesn't filter by a query
- Whether to call it is up to the model
- The browser sends only each character's ID, display name and allowed roles. Model files are never sent

## Example: sent back for a fix

The request was "Small map, two guards, as many gems as possible".

1. First brief: `tier: small, guards: 2, collectibles: 5`
2. It failed the check. The model was told: "a small map allows at most 1 guard, there are 2 now: use fewer guards, or pick a larger map"
3. Second brief: `tier: medium, guards: 2, collectibles: 7`. It passed and went to preview

It passed, but the small map that was asked for became a medium one. Getting past the rules and doing what was asked are different things, so I record them separately.

## Example: a tool call

The request was "Make the armored soldier a guard, one guard is enough, medium map".

1. The model calls `lookup_roster`
2. The tool answers "r1: armored soldier, can be a companion or a guard"
3. The model writes `cast: [{ personId: "r1", role: "guard" }]` and `guards: 1` in the brief
4. The service maps `r1` back to the real character ID

The roster is also included in the prompt for writing the brief. So picking the right character doesn't prove the tool was called. This run is the one where the call itself was recorded.

## The 8 runs

November 2026, Windows 11, RTX 5080 (16 GB), Ollama 0.40.16, qwen3.5:9b-q4_K_M. The requests were written in Chinese. These are translations.

| Request | Outcome | Requirements set beforehand | Time |
|---|---|---|---|
| A small map, four gems scattered on the ground, no guards | Passed first time | 3 / 3 | 8.2 s (5.9 s of it loading the model) |
| Desert at dusk, foggy, medium map | Passed first time | 3 / 3 | 2.2 s |
| Xingxuan as my companion, grassland, daytime | Passed first time | 2 / 2 | 2.6 s |
| Make the armored soldier a guard, one guard is enough, medium map | Passed first time, one tool call | 3 / 3 | 3.3 s |
| Large map, three platforms, gems only on the platforms, six in total | Passed first time | 3 / 3 | 2.2 s |
| Medium map, two guards patrolling back and forth, rainy night | Passed first time | 3 / 3 | 2.3 s |
| Small map, two guards, as many gems as possible | Passed after one fix | Not counted (the small map wasn't kept) | 3.7 s |
| Sunny grassland, small map, three gems on the ground, no guards, Xingxuan follows me | Passed first time | 3 / 3 | 8.3 s (4.2 s of it loading the model) |

- The last one went through the browser UI end to end: import characters, generate, confirm, play until every gem is collected, reload and find the level still there. The key presses during play were sent by a script
- In all 8, the saved layout matched the preview. Confirming took 2 to 5 ms
- Once, after the model had been idle for a long time, the first request took almost a minute. Since then model loading is timed separately from generation

Each request, brief and result is in [evidence/workshop-20261116](evidence/workshop-20261116/) (in Chinese).

## Why LangGraph

Plain functions would do. I used a state graph because there are two places where the flow goes back: to "write the brief" after a rule violation, and from the paused preview into the rest of the flow after a confirm. The price is having to know the framework's rules, such as a step being re-run from its start on resume.

## Not done

- Keeping an unconfirmed preview across a service restart
- Handling several requests at once
- Querying the roster tool by condition
- Trying a real OpenAI-compatible provider (only a fake server so far)

## Where the code is

| File | Contents |
|---|---|
| `server/graph.ts` | The graph itself, including the send-back loop and the fallback |
| `server/prompts.ts` | Prompts |
| `server/workshop.ts` | Entry points for generate and confirm, and model loading |
| `server/roster.ts` | The roster listing and the role check |
| `src/game/level/gen/brief.ts` | The brief schema and the combination rules |
| `src/game/level/gen/generator.ts`, `checker.ts` | The layout generator and checker |
