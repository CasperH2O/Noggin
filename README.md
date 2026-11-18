# Noggin

Noggin is a custom skill for Jibo running the BE ecosystem (BEam with the BEacon menu and the
5x1 Store). It shows a screen in Jibo's classic look; tap the button and Jibo looks up.

## Install

On the robot: BEacon, Store, Upload ZIP, and choose `Noggin.zip` from a release. It needs BEam
3.1.9 or newer.

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
| `manifest.json`, `icon.png`, `banner.png` | the store entry (icon 330x300, banner 1600x900, optional) |
| `store/README.md` | the store text, shipped as the ZIP's README.md |
| `noggin/` | the `@be/noggin` package that runs on the robot |
| `noggin/lib/screen.js` | the face UI and the skill's open and close |
| `noggin/lib/motion.js` | body movement that always ends centred |
| `noggin/lib/layout.js` | colours, fonts and positions |
| `tests/` | unit tests (Node's test runner) |
| `tools/` | packaging and icon tools (not shipped) |

## Licence

[MIT](LICENSE).
