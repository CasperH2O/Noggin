# Noggin: development

For developers. The owner's text, which the 5x1 Store and BEacon show, is [README.md](README.md).

Noggin is a custom skill for Jibo running the BE ecosystem (BEam with the BEacon menu and the
5x1 Store): Jibo's AI brain. Open it and talk with Jibo in his own voice; he answers with
OpenAI's realtime model, moves with what he says, and uses skills along the way: native skills
(timers, the clock, music, dances), server skills from Jibo's cloud, and custom skills you add. A
settings page on port 8131 holds the key, the models, the persona and everything else.

## Install

On the robot: BEacon, Store, Upload ZIP, and choose `Noggin.zip` from a release. It needs BEam
3.2.0 or newer, and BEacon asks you to agree to the permissions below. Then open `http://<jibo>:8131` and save an OpenAI API key on the Brain tab.

## How it works

- **The conversation** (`noggin/index.js`, `noggin/lib/controller.js`). Opening the skill connects
  to the realtime model over the page's WebSocket, opens the microphone (an `arecord` child process
  on the robot, Web Audio elsewhere) and says the greeting. The model answers in text; Jibo speaks
  it in his own voice, one sentence at a time. A fast model (OpenAI's Decisions API) picks an
  expression for each line. The microphone is closed while Jibo speaks.
- **Touch and sight** (`noggin/lib/conversation-senses.js`, `noggin/lib/touch.js`,
  `noggin/lib/presence.js`). A touch on Jibo's head (`jibo.system.events.touchOn`) plays the
  petting clip his idle skill would pick (the emotion system's query, then the animation database),
  at once while he listens or thinks and after the current line while he speaks, with the
  microphone closed while it plays. Noggin never listens to the global `touchStop`: the action
  system's hold to quit needs it; while Noggin is open the hold takes 3 s instead of 1 s, so a
  stroke does not end the conversation. Whom Jibo recognises by face is read once a second from
  `jibo.lps.identity` and named through his family list. Both reach the model as short system
  notes without a reply; the setting `presence` switches names off.
- **Dutch** (`noggin/lib/voice.js`, `noggin/lib/lines.js`). With Language set to Dutch, the model
  starts every reply with `[nl]` or `[en]`; Noggin reads that label (never says it) and sends a
  Dutch reply through the separate Dutch Voice skill (`@be/dutch-voice`), which publishes
  `global.dutchVoiceService` in Be's process. Noggin keeps its own embodied-speech call and wraps
  it in `service.speak(fn)`, which sends Jibo's speech to the Dutch voice for that one call, so eyes
  and body follow the Dutch words. The service is looked up at every call. Without it (or not
  ready) a conversation set to Dutch runs in English and Jibo says why; if it refuses a line, Jibo
  says so in English once and the conversation goes on in English. Noggin's own lines are in
  `lib/lines.js` in both languages. The end of each conversation log counts the lines said in each
  language, for the Usage tab.
- **Tools** (`noggin/lib/actions.js`). The model may call tools. Some run inside Noggin (facts,
  dance, volume, reading the clock); others hand over to one of Jibo's skills (the clock, photos,
  apps) or ask Jibo's cloud a fixed phrase. When that skill is done, Noggin opens again and carries
  on (`noggin/lib/comeback.js`). Music, the radio, going to sleep and looking away (his idle skill)
  end the conversation instead.
- **The settings page** (`noggin/background.js`, `noggin/lib/server.js`, `noggin/web/`). BEam starts
  `background.js` at boot and after every install or update, inside Be's process. It serves the
  page and a small JSON API on port 8131 with Node's `http` module. Saving writes the data folder;
  the next conversation reads it.
- **Settings** (`noggin/lib/settings.js`). One schema lists every setting with its default, type,
  limits, label and help; the server checks against it and the page is built from it.

- **Memory** (`noggin/lib/memory.js`, `noggin/lib/recap.js`). Jibo keeps facts about the household
  and a one-line note per conversation (kept 14 days) in `memory.json`. At session start the facts
  and the newest notes go in the session note, within a fixed budget, and stay the same all
  session so the prompt cache keeps them cheap. The tools `remember`, `forget` and `recall`
  serve explicit requests; `recall` searches older notes by keyword. After a conversation ends,
  `background.js` sends its text and the current facts to the Helper model once (Responses API,
  strict JSON) and stores the note and the fact changes. It looks every minute, and a few seconds
  after the skill signals the end of a conversation (a listener list on the shared `global`
  object; both run in Be's process). Learning starts with the first conversation that has it on. One conversation per pass, 3 tries, at most 60 calls a day; logs from
  before learning was switched on are never sent. Facts are about the household in the third
  person, since Noggin cannot tell people apart; private things are dropped in code.
- **Usage** (`noggin/lib/usage.js`, `noggin/lib/stats.js`). The Usage tab starts with how often Jibo talks (conversations,
  time talked, average and longest, per day, and the latest ones), read from the start and end of the
  conversation logs, so it needs logs on and reaches back as far as they are kept. It then shows what Jibo's OpenAI use costs, read with an
  admin key that must be read-only: before it is saved, and before every fetch, Noggin tries a write
  that cannot change anything (deleting an invite that does not exist) and goes on only when OpenAI
  refuses it for the missing `api.management.write` scope. A key that gets further is refused, or
  deleted from Jibo when it was saved. The admin key only goes to `api.openai.com`, never to the API
  address setting. Jibo's own key is found by matching the API key's start and last four
  characters against the project keys' redacted values. Money and tokens (audio seconds for
  per-minute models such as gpt-transcribe) come from the costs endpoint (per UTC day, by line item
  and key), the hour grid from completions usage, the budget from the spend limit and alerts; prices are worked out from the bills. Answers are kept in memory for
  15 minutes (Refresh: at most once a minute) and never written to disk; names and emails in
  OpenAI's answers never reach the page.

- **Trouble** (`noggin/lib/trouble.js`, `noggin/lib/setup-screen.js`). When a conversation cannot
  start or go on, Jibo says why with an eye emoji: no key, key refused, settings wrong, no credit,
  no internet, OpenAI down, rate limited. OpenAI's own error code is used when there is one; the
  page's WebSocket only reports "closed" when OpenAI refuses it, so Noggin then asks over HTTPS:
  `GET /models/<conversation model>` (free), and only when that passes one `POST /responses` with
  16 output tokens, all within 6 s. No key, a refused key or wrong settings show a setup screen: a
  QR code to `http://<Jibo's address>:8131/#brain` (qrcode-generator, vendored), the address as
  text and the cause. It ends on swipe, tap, after 3 minutes, or when `settings.json` changes and
  now works; then the conversation starts. A connection that drops mid-conversation reconnects
  once with the conversation so far.
- **Budget heads-up** (`noggin/lib/budget.js`). With an admin key and a spend limit,
  `background.js` reads the Usage tab's numbers 2 minutes after start and then every 12 hours,
  and keeps the answer in memory on the shared `global` object. When at most `budgetWarnPercent`
  (10%) of the limit is left, the next conversation says so after the greeting, once a day.
- **Open on "Hey Jibo"** (`noggin/lib/hey-jibo.js`, setting `heyJibo`, off by default).
  `background.js` listens to Jibo's `hjHeard` event. With the setting on, while Jibo is idle and
  Noggin is closed, it opens Noggin through BEam's background `api.open()` and, 600 ms later, ends
  the cloud turn that "Hey Jibo" started (`jibo.jetstream.cancelAnyTurn()`, again if that turn only
  starts afterwards), so its result cannot switch Noggin away. The delay lets Jibo's own "Hey Jibo"
  action, which restarts when Noggin opens, see the turn end; it then only turns toward the voice
  before Noggin starts. The conversation ignores the start of that one turn; a handover releases the
  claim (`global.nogginHeyJibo`), so Noggin's own cloud turns are never cancelled. Only with an API
  key saved. The ring turns orange before the open (BEam may load Noggin inside it) and stays orange
  until Noggin is up (Be first finishes Jibo's own "Hey Jibo" action, about two seconds); the ring
  colours are in `noggin/lib/ring.js`. Jibo's own listening look for that "Hey Jibo" (blue ring,
  listening eye) is skipped with `jibo.embodied.listen.disableOnce()`, called from a handler placed
  in front of Jibo's own on the `hjHeard` event and only when Noggin is about to open; the flag is
  cleared again after that "Hey Jibo", so with the setting off Jibo looks as he always does. Words
  said right after "Hey Jibo" are not heard. The simulator cancels turns differently, so check this
  on the robot.
- **Open by voice** (`phrases` in `manifest.json`). BEam matches the whole sentence heard after
  "Hey Jibo" against each installed skill's phrases on the robot (`beacon/lib/launch-phrases.js`),
  ignoring case, punctuation, a leading "Jibo" and "please" / "can you". Noggin lists "noggin",
  "open / start / launch / use / switch to noggin", "use your noggin", "(let's) talk to / with
  noggin" and "chat with noggin"; BEam rejects a phrase with only everyday words, and needs the
  cloud's transcript (no turn result without it). No permission is needed. The list is in
  README.md; `tests/package.test.mjs` keeps the two in step. With `heyJibo` on, "Hey Jibo" opens
  Noggin by itself while Jibo is idle and a key is saved, and the words after it are not heard;
  otherwise the phrases open it. A launch while Noggin is open makes Be call `open()` again
  without `close()`, so `open()` first closes the conversation or setup screen still up.

## Permissions

`manifest.json` declares what BEam 3.2.0 asks the owner to agree to at install (`supported` is
`3.2.0`). Each one is used for a reason, and a blocked call throws an error that names it. When the
microphone program or the realtime connection is refused, Jibo says he is not allowed to do that and
ends the conversation, and nothing is left running. A refused hotword mode, timer check or family
list is left out without a message, and the conversation goes on without it.

| Permission | Why |
|---|---|
| `background` | `noggin/background.js`: the settings page, the memory recap, the budget check and "Hey Jibo" opening Noggin |
| `microphone` | `jibo.jetstream.setHotwordMode` while Noggin has the microphone; the page's `getUserMedia({audio})` in the simulator. Works only while Noggin's own screen is open |
| `run-programs` | the `arecord` child process that captures the microphone on the robot (`noggin/lib/mic.js`): an ALSA failure in its own process cannot take Be, and with it Jibo's face and body, down. The page's capture (`micSource` `webaudio`, microphone only) is the simulator's path |
| `jibo-apis` | the settings page asks BEacon on `127.0.0.1` for the installed skills (`noggin/lib/server.js`) |
| `read-kb` | the clock's timer record (`/jibo/clock/alarm_timer`) and Jibo's family list, for names (`noggin/lib/actions.js`, `noggin/lib/presence.js`); once, an earlier version's data folder (`noggin/lib/migrate.js`) |

Not needed, so not declared: `camera`, `local-network`, `edit-kb`, `read-jibo-files`,
`edit-jibo-files`. The internet (OpenAI) needs no permission. `tests/package.test.mjs` keeps the
list and the code in step.

Without `local-network`, BEam 3.2.0 refuses an API address on the home network (a proxy on a private
address, a `.local` or `.lan` name, a name without a dot), and BEacon cannot grant it afterwards. On
Jibo the API address must be public or `localhost`; the settings page refuses another one when you
save it, and Jibo says he is not allowed to reach the address if one gets through.

## Data on the robot

`/opt/jibo/Knowledge/noggin/`, the skill's own Knowledge folder (in a development checkout,
`/tmp/beam-beacon/custom-skills/noggin/`). BEam leaves this folder alone on updates and removal.
Data an earlier version kept in `/opt/jibo/Knowledge/beacon/custom-skills/noggin/` is copied here
once, when Noggin first starts (`noggin/lib/migrate.js`): the settings, the memory, the persona, the
newest 30 conversation logs and the newest 10 memory-recap transcripts, and only files that are not
there yet, so a copy that was cut short can be finished. The old folder is not removed: Noggin cannot
delete it (that needs `edit-kb`), so it still holds the previous API key, memory and logs after the
update. Once the update works you can delete it yourself.

| Path | What |
|---|---|
| `settings.json` | only the settings that differ from the defaults, the API key and the read-only admin key (mode 0600) |
| `persona/SOUL.md`, `IDENTITY.md`, `FACTS.md` | an edited persona part; without it, the packaged one in `noggin/persona/` |
| `logs/conversation-*.jsonl` | one text log per conversation, the newest 200, at most 2 MB each and 20 MB together |
| `memory.json` | facts (at most 60 and 2,400 characters), conversation notes (14 days, at most 300) and the recap's bookkeeping (mode 0600, written through `memory.json.new` and a rename) |
| `memory.json.bad` | a `memory.json` that could not be read, kept aside once |
| `migrated.json` | written once the old folder's data was copied |
| `logs/recap-*.jsonl` | only with logs off and learning on: who said what, until the recap is done; not shown in History; at most 50, 256 KB each, 4 MB together, 2 days |

## Settings API

The page uses these; anything on the local network can too (no login, like BEacon).

| Request | What |
|---|---|
| `GET /api/settings` | schema, values, persona (current and packaged), the instructions size; the key only as a hint |
| `POST /api/settings` | `{values: {key: value or null}, persona: {soul or identity or facts: text or null}}`; `null` restores the default. All or nothing: `400` with `errors` per field. A new `adminKey` is saved only when OpenAI shows it is read-only |
| `GET /api/stats` | the Usage tab's Conversations section, from the conversation logs kept: `{ok, total, since, week: {count, ms, averageMs, longestMs}, days: [{day, count, ms}], recent: [{start, day, time, ms, turns, reason, resumed}]}`; days are Jibo's local days, and a comeback after a handover (`resumed`) adds time but is not counted again |
| `GET /api/usage`, `GET /api/usage?refresh=1` | the Usage tab: `{ok, state, days, models, features, budget, caching, whatIf, perConversation, hours, key, fetchedAt, cached}`; a model or feature has `cost`, `tokens` and `seconds` (audio, per-minute models); `state` is `ok`, `no-key`, `removed` (a saved key had write access and was deleted), `rejected`, `unknown`, `no-match`, `no-api-key` or `error` with `error`. `budget.spent` is what the limit counts: the project's spend for a project limit, else the account's |
| `GET /api/models`, `GET /api/models?refresh=1` | the Models endpoint's answer for the saved key, kept 6 hours (a refresh within a minute of the last answer gets it, requests during a fetch share one): `{ok, fetchedAt, available: {id: shutdown date or null}, others: {conversation, transcription, expression, helper: [id]}}`; `others` are models that look right for the job, are not tested and have no shutdown announced; `{ok: false, error}` without a key or when OpenAI does not answer. The tested lists are in `lib/models.js` |
| `POST /api/test-key` | `{key}` or the saved key: Jibo asks OpenAI for its model list |
| `GET /api/logs`, `GET /api/logs/<name>` | the conversation logs, newest first, and one log as JSON lines |
| `GET /api/skills/found` | the custom skills installed through BEacon that could become extra apps, as `{found: [{name, pkg, label, about}], builtIn}` (`about`: the start of the skill's README); Noggin asks BEacon (`127.0.0.1:8123`, or `BEACON_PORT`) itself. `502` when BEacon does not answer within 4 s |
| `GET /api/memory` | `{facts: [{id, text, source, expires}], summaries: [{id, text, when}], used, max}`; `source` is `auto` (learned) or `asked` |
| `POST /api/memory/fact` | `{text, expires?}` adds a fact, `{id, text, expires?}` changes one; either way it counts as asked. `400` with `error` when it is too long, reads like an instruction or the facts are full |
| `POST /api/memory/delete` | `{kind: 'fact' or 'summary', id}`; `404` when it is gone |
| `POST /api/memory/clear` | `{confirm: true}`: every fact and note goes, and the conversations so far are never recapped |
| `GET /api/memory/export` | the facts and notes as a JSON download: `{format: 'noggin-memory', version: 1, facts, summaries}` (no log names) |
| `POST /api/memory/import` | `{data, mode?: 'add' (default) or 'replace', confirm?}`: `data` is an export (the older one without `format` too). Every entry is checked like a new one (length, instruction-like text, a date that exists, expiry, notes older than 14 days, the memory budget) and gets a new id; at most 400 facts and 400 notes are read, nothing already kept is changed or pushed out, and a full memory (60 facts, 2,400 characters, 300 notes) refuses the rest. The body may be up to 512 KB (other writes 128 KB). `replace` needs `confirm: true`, is refused (`400`) when nothing in the file could be used, and, like `clear`, counts the conversations so far as recapped. Answers like `GET /api/memory` plus `message` (what was added, already known, left out); `400` with `error` for a file that is not an export |
| `POST /api/apps/describe` | `{pkg}` → `{about, model}`: one line on what an installed skill does, written by the Helper model from the README BEacon has, with the saved key. Only a package name comes in. One call at a time (`429` while busy); `404` when the skill is not installed through BEacon, `422` without a README or for an answer that reads like instructions, `502` when OpenAI or BEacon does not answer |

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
| `manifest.json`, `icon.png`, `banner.png` | the store entry (icon 330x330, banner 1600x900) |
| `README.md` | the store text, shipped in the ZIP (no tables or code blocks) |
| `DEVELOPMENT.md` | this file (not shipped) |
| `noggin/index.js` | the skill: opening it starts a conversation; coming back after another skill |
| `noggin/background.js` | starts and stops the settings page, the memory recap, the budget check and the "Hey Jibo" watch with BEam |
| **Conversation** | |
| `noggin/lib/controller.js` | one conversation: start, the realtime events, a turn's flow, failures and close |
| `noggin/lib/conversation-lines.js` | what Jibo says: lines, their expressions and emoji, the speak itself |
| `noggin/lib/conversation-mic.js` | the microphone during a conversation, and the timing probes in the log |
| `noggin/lib/conversation-tools.js` | running the model's tool calls: in Noggin, a handover, or Jibo's cloud |
| `noggin/lib/realtime-session.js` | what the realtime model is told: session settings, instructions (the same in every conversation), the session note (start time and memory, the first system item of every session, also after a reconnect, so a new session can reuse the cached instructions and tools), resume notes |
| `noggin/lib/openai.js` | the OpenAI connections: the realtime WebSocket and HTTPS requests |
| `noggin/lib/models.js` | the tested models per job (one recommended each) and the pick of untested candidates from OpenAI's model list, for the settings page's dropdowns |
| `noggin/lib/labels.js` | the expression classifier's requests and how its answers are read |
| `noggin/lib/catalog.js`, `catalog.json` | moods and their animations, dances, eye emoji (built by `tools/expression-catalog.mjs`) |
| `noggin/lib/emoji-nl.js` | Dutch words for the eye emoji, each pointing at a word of the English emoji index |
| `noggin/lib/expression.js` | plays expressions next to speech; the thinking eye; Jibo's eye view |
| `noggin/lib/tts-text.js` | reply text as plain words and ESML for Jibo's speech; stop phrases in English and Dutch |
| `noggin/lib/voice.js` | the seam to the Dutch Voice skill, and the reply's language label |
| `noggin/lib/lines.js` | everything Noggin says as fixed text, in English and Dutch |
| `noggin/lib/mic.js`, `audio.js` | the microphone (arecord on the robot) and its samples as PCM16 at 24 kHz |
| `noggin/lib/audio-clock.js` | when each part of the sent audio left, for the timing log |
| `noggin/lib/conversation-log.js` | the conversation logs and recap transcripts, with their caps |
| `noggin/lib/log.js` | the system log lines, cut to a length |
| **Tools and coming back** | |
| `noggin/lib/actions.js` | the tools the model may call and how each one is planned; Jibo's local time |
| `noggin/lib/comeback.js`, `cloud-turn.js` | coming back to Noggin after another skill or Jibo's cloud answered |
| **Memory** | |
| `noggin/lib/memory.js` | the facts and notes Jibo keeps, and the memory tools |
| `noggin/lib/recap.js` | after each conversation: a note and new facts, written by a small model |
| **Settings page** | |
| `noggin/lib/settings.js` | every setting (schema, defaults, checks) and the persona overrides |
| `noggin/lib/server.js` | the settings page's HTTP server and API |
| `noggin/lib/describe.js` | Describe with AI: a line on what an extra app does |
| `noggin/lib/usage.js` | the Usage tab: the read-only check, Jibo's key, costs, usage and limits from OpenAI |
| `noggin/lib/stats.js` | the Usage tab's Conversations section: counts and lengths read from the start and end of each conversation log |
| `noggin/lib/budget.js` | the budget check in the background and the heads-up |
| `noggin/lib/ring.js` | the ring colours, shared by the conversation and the "Hey Jibo" hold |
| `noggin/lib/embodied-listen.js` | Jibo's own listening look (Embodied Listen): its state and clearing `disableOnce` |
| `noggin/lib/hey-jibo.js` | "Hey Jibo" opens Noggin: the hotword watch and cancelling that hotword's cloud turn |
| **When something is wrong** | |
| `noggin/lib/trouble.js` | what went wrong when Noggin cannot talk, and how Jibo says it |
| `noggin/lib/setup-screen.js` | the QR code screen to the settings page |
| **Shared** | |
| `noggin/lib/http.js`, `timing.js`, `files.js`, `text.js` | JSON over HTTP with a timeout and size cap; a pause and a deadline for any promise; safe file writes; small text and time helpers |
| `noggin/lib/events.js` | listening to Jibo's events, and state the skill and `background.js` share on `global` |
| `noggin/lib/migrate.js` | copies an earlier version's data folder into the skill's own Knowledge folder, once |
| `noggin/vendor/qrcode.js` | qrcode-generator 1.4.4 (MIT), with its licence |
| `noggin/web/` | the settings page: plain HTML, CSS and JavaScript |
| `noggin/persona/` | the default persona: SOUL, IDENTITY and FACTS |
| `tests/` | unit tests (Node's test runner) |
| `tools/` | packaging and the expression catalogue builder (not shipped) |

## Licence

[MIT](LICENSE). Parts follow or adapt BEam (BSD-3-Clause), and the QR code generator is MIT; see
[THIRD_PARTY.md](THIRD_PARTY.md).
