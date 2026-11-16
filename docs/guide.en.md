<h3 align="center">
  <a href="guide.md">日本語</a> &nbsp;|&nbsp; <a href="guide.zh.md">简体中文</a> &nbsp;|&nbsp; English
</h3>

# Playing and settings

## Controls

Collect the required number of gems before the timer runs out and you win. Run out of time and you lose. Touching a guard on patrol costs 10 seconds. For the next 2 seconds another touch costs nothing.

| Action | Key |
|---|---|
| Move | W / A / S / D |
| Run | Hold Shift |
| Jump | Space |
| Look around | Move the mouse. The arrow keys work too |
| Pause / resume | Esc or P |

- Platforms are too high to jump onto. Walk up the ramp
- Clicking Start locks the mouse to the game. Esc releases it and pauses at the same time
- Menus work with the keyboard alone: Tab to move, Enter or Space to choose, Esc to close a panel

## Language

The interface comes in English, Japanese and Chinese.

- There is a language picker at the bottom of the start screen and in the pause menu. Picking one saves the choice and reloads the page. Your roster, saved levels and mute setting stay as they are
- During play, press Esc to pause before switching
- Add `?lang=en`, `?lang=ja` or `?lang=zh` to the URL to open in that language for that visit only. The saved choice is not changed
- If you have never picked one, the game follows your browser language: Japanese for Japanese, Chinese for Chinese, English for everything else
- File names, roster names and the titles of saved levels are shown as you entered them. Text written by the model and explanations returned by the workshop service are still in Chinese for now

## Importing a character

Click Import character and pick a file, or drag a file onto the window.

| Format | |
|---|---|
| `.glb` | A character with a skeleton and animations. This is the main path |
| `.obj` `.stl` `.ply` | Static models, shown with a default material (the MTL of an OBJ is not read) |

Big files get a warning first. Bigger ones are not loaded.

| | Warning | Not loaded |
|---|---|---|
| File size | over 50 MB | over 150 MB |
| Triangles | over 300,000 | over 1,000,000 |
| Bones | | over 256 |
| Animation clips | | over 64 |
| Texture edge | | over 8192 |

A GLB that points to external files, or one compressed with Draco, Meshopt or KTX2, can't be loaded either. A broken file only shows an "import failed" message. Your current player character and scene stay as they are.

After an import a card appears on the right. On it you can:

- Change the display height (1.2 to 2.4 m, 1.75 m by default). This is visual only. Collision stays the same
- Turn the model 90° left or right if it faces the wrong way
- See what each clip was taken to be (idle, walk, run, jump, other) and fix it by hand. Looping can be changed too
- Tick Lock horizontal movement when a clip moves the character by itself
- Add to Roster, or go straight to Set as Player character

Missing motions are filled in like this. No run: the walk clip is sped up. No walk: the run clip is slowed down. No idle: the first frame of the walk. With no movement clip at all (static models included), the whole model bobs up and down as it moves.

## Roster

- Stored in the browser (IndexedDB), 20 characters at most. The same file is not added twice
- Five roles: player character, guard, player character and guard, companion, not appearing. One player character only, 3 companions at most
- A character set as a guard only replaces the look of the guards in a level. Their number and routes don't change. If there aren't enough characters, the remaining guards use the default figure
- Companions follow diagonally behind the player. They collide only with the map, don't pick up gems and can't be caught by guards. If one falls too far behind it is brought back
- 12 imported characters on screen at most
- If the browser refuses storage the roster still works, but it is gone when you close the page

## Levels

- **Built-in**: three hand-made maps (a meadow and two small test levels) and three generated ones that are frozen
- **Random level**: the code writes a random brief, generates a layout and checks it. You get a preview first, and nothing is saved until you confirm
- **Saved**: random and workshop levels you confirmed. You can load or delete them. Replaying uses the saved layout as is, with no regeneration

Each level carries a difficulty estimate (relaxed, normal, tense). It compares how long it takes to collect everything at a run against the time limit. Guards and detours are not counted.

A level made in the workshop only features the characters you ticked. Tick nobody and the level has no companions and its guards use the default figure. The player character still follows the roster.

## Level Workshop

`npm run dev:workshop` starts the game (port 5173) and the local workshop service (port 8790) together. The service listens on 127.0.0.1 only.

- Before the first generation the model is loaded into VRAM. That usually takes a few seconds, and can take tens of seconds after a long idle period
- You can stop a generation with Stop generating
- The preview shows which model was used, whether it passed first time or how many fixes it took, and whether the code adjusted anything
- After the preview you choose Confirm, Change the sentence or Discard

### Settings

Set these as environment variables, or put them in a `.env` file at the project root.

| Variable | Default | |
|---|---|---|
| `MW_LLM_PROVIDER` | `ollama` | `ollama`, `openai` or `off` |
| `MW_OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama address |
| `MW_OLLAMA_MODEL` | `qwen3.5:9b-q4_K_M` | Model name. It is not downloaded for you |
| `MW_OLLAMA_NUM_CTX` | `8192` | Context length |
| `MW_OPENAI_BASE_URL`, `MW_OPENAI_MODEL`, `MW_OPENAI_API_KEY` | none | OpenAI-compatible API (only tried against a fake server) |
| `MW_WORKSHOP_PORT` | `8790` | Service port |
| `MW_WORKSHOP_MAX_REQUEST_CHARS` | `200` | Longest sentence accepted |
| `MW_WORKSHOP_MAX_BODY_BYTES` | `32768` | Request body limit |
| `MW_WORKSHOP_CALL_TIMEOUT_MS` | `60000` | Time limit for one model call |
| `MW_WORKSHOP_REQUEST_TIMEOUT_MS` | `180000` | Time limit for a whole generation request |
| `MW_WORKSHOP_PREPARE_TIMEOUT_MS` | `150000` | Time limit for loading the model. Never longer than the whole-request limit |
| `MW_WORKSHOP_STATS` | `.local/workshop-stats.jsonl` | Stats file |

The API key is used only inside the service process. It is not logged and not returned to the browser. Stats are one line per request (outcome, number of fixes, time per stage) and don't include the sentence you wrote or any character details.

## Commands

| Command | |
|---|---|
| `npm run dev:workshop` | The game plus the workshop service |
| `npm run dev` | The game only. The workshop shows the service as unavailable |
| `npm run build`, `npm run preview` | Production build and its preview. A production build can't reach the workshop service |
| `npm test` | Unit tests |
| `npm run e2e` | Playwright end-to-end tests (run `npx playwright install chromium` first) |
| `npm run typecheck`, `npm run lint` | Type checking and ESLint |
| `npm run workshop-stats` | Summarize the workshop stats |
| `MW_WORKSHOP_ACCEPTANCE=1 npm run workshop-acceptance` | Run 10 fixed requests through the local model |
| `npm run inspect-asset -- <file> [--json]` | Look at the structure of a GLB |

## Looking inside a GLB

```sh
npm run inspect-asset -- path/to/character.glb
```

Prints the container, meshes and triangle count, textures, bones, each clip's name, duration, looping and horizontal motion, and the bounding box. It reads that one file only, makes no network calls and writes nothing. Anything it can't work out is shown as "not computed" with the reason, never as 0. Add `--json` for JSON output.

## Running the tests with your own characters

```sh
MW_ASSET_DIR=<folder with your character files> npm run e2e -- tests/e2e/real-assets.spec.ts
```

Imports each model in the folder and takes a screenshot. The folder is only read, and nothing is copied into the project. Without `MW_ASSET_DIR` these tests are skipped.

## URL parameters for development

Development mode only.

| Parameter | |
|---|---|
| `?level=meadow`, `test-a`, `test-b` | Open a hand-made map directly |
| `?level=gen-1`, `gen-2`, `gen-3` | Open one of the three generated built-in levels directly |
| `?view=fixtures` | View the test models generated by code |
