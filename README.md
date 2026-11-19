# Noggin

Noggin is a custom skill for Jibo running the BE ecosystem (BEam with the BEacon menu and the
5x1 Store): Jibo's AI brain. Open it and talk with Jibo in his own voice; he answers with
OpenAI's realtime model, moves with what he says, and uses his own skills (timers, the clock,
music, dances, Jibo's cloud) along the way. A settings page on port 8131 holds the key, the
models, the persona and everything else.

## Install

On the robot: BEacon, Store, Upload ZIP, and choose `Noggin.zip` from a release. It needs BEam
3.1.9 or newer. Then open `http://<jibo>:8131` and save an OpenAI API key on the Brain tab.

## How it works

- **The conversation** (`noggin/index.js`, `noggin/lib/controller.js`). Opening the skill connects
  to the realtime model over the page's WebSocket, opens the microphone (an `arecord` child process
  on the robot, Web Audio elsewhere) and says the greeting. The model answers in text; Jibo speaks
  it in his own voice, one sentence at a time. A fast model (OpenAI's Decisions API) picks an
  expression for each line. The microphone is closed while Jibo speaks.
- **Tools** (`noggin/lib/actions.js`). The model may call tools. Some run inside Noggin (facts,
  dance, volume, reading the clock); others hand over to one of Jibo's skills (the clock, music,
  radio, photos, apps) or ask Jibo's cloud a fixed phrase. When that skill is done, Noggin opens
  again and carries on (`noggin/lib/comeback.js`).
- **The settings page** (`noggin/background.js`, `noggin/lib/server.js`, `noggin/web/`). BEam starts
  `background.js` at boot and after every install or update, inside Be's process. It serves the
  page and a small JSON API on port 8131 with Node's `http` module. Saving writes the data folder;
  the next conversation reads it.
- **Settings** (`noggin/lib/settings.js`). One schema lists every setting with its default, type,
  limits, label and help; the server checks against it and the page is built from it.

## Data on the robot

`/opt/jibo/Knowledge/beacon/custom-skills/noggin/` (in a development checkout,
`/tmp/beam-beacon/custom-skills/noggin/`). BEam leaves this folder alone on updates and removal.

| Path | What |
|---|---|
| `settings.json` | only the settings that differ from the defaults, and the API key (mode 0600) |
| `persona/SOUL.md`, `IDENTITY.md`, `FACTS.md` | an edited persona part; without it, the packaged one in `noggin/persona/` |
| `logs/conversation-*.jsonl` | one text log per conversation, the newest 200, at most 2 MB each |

## Settings API

The page uses these; anything on the local network can too (no login, like BEacon).

| Request | What |
|---|---|
| `GET /api/settings` | schema, values, persona (current and packaged), the instructions size; the key only as a hint |
| `POST /api/settings` | `{values: {key: value or null}, persona: {soul or identity or facts: text or null}}`; `null` restores the default. All or nothing: `400` with `errors` per field |
| `POST /api/test-key` | `{key}` or the saved key: Jibo asks OpenAI for its model list |
| `GET /api/logs`, `GET /api/logs/<name>` | the conversation logs, newest first, and one log as JSON lines |
| `GET /api/skills/found` | the custom skills installed through BEacon that could become extra apps, as `{found: [{name, pkg, label, about}], builtIn}` (`about`: the start of the skill's README); Noggin asks BEacon (`127.0.0.1:8123`, or `BEACON_PORT`) itself. `502` when BEacon does not answer within 4 s |
| `POST /api/apps/describe` | `{pkg}` → `{about, model}`: one line on what an installed skill does, written by the Fallback model from the README BEacon has, with the saved key. Only a package name comes in. One call at a time (`429` while busy); `404` when the skill is not installed through BEacon, `422` without a README or for an answer that reads like instructions, `502` when OpenAI or BEacon does not answer |

A `POST` must be JSON (`Content-Type: application/json`) and must not name another site in its
`Origin` or `Referer`; bodies are limited to 128 KB.

## Build and test

Needs Node.js 20 or newer and Python 3.10 or newer; no packages to install.

```sh
node --test tests/*.test.mjs      # unit tests
python3 tools/package.py          # writes dist/Noggin.zip and prints its sha256
```

The skill runs on the robot's Node 6.9.2 and Chromium 53, so the code under `noggin/` is
ES2015: no `async`/`await`, object spread, optional chaining, `Object.values` or `padStart`.
The tests and tools run on a current Node.

## Layout

| Path | What |
|---|---|
| `manifest.json`, `icon.png`, `banner.png` | the store entry (icon 330x300, banner 1600x900) |
| `store/README.md` | the store text, shipped as the ZIP's README.md |
| `noggin/index.js` | the skill: opening it starts a conversation; coming back after another skill |
| `noggin/background.js` | starts and stops the settings page with BEam |
| `noggin/lib/controller.js` | one conversation: microphone, realtime model, speech, expressions, tools |
| `noggin/lib/settings.js` | every setting (schema, defaults, checks) and the persona overrides |
| `noggin/lib/server.js` | the settings page's HTTP server and API |
| `noggin/lib/actions.js` | the tools the model may call and how each one runs |
| `noggin/web/` | the settings page: plain HTML, CSS and JavaScript |
| `noggin/persona/` | the default persona: SOUL, IDENTITY and FACTS |
| `tests/` | unit tests (Node's test runner) |
| `tools/` | packaging and the expression catalogue builder (not shipped) |

## Licence

[MIT](LICENSE). Parts follow or adapt BEam (BSD-3-Clause); see [THIRD_PARTY.md](THIRD_PARTY.md).
