import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const lib = (name) => require(`../noggin/lib/${name}`);
export const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

// A fake jibo.expression and animDB that record what the skill asks for. `pose` controls the
// played pose: {never: true} never finishes.
export function fakeJibo(pose = {}) {
  const calls = [];
  const handles = [];
  const jibo = {
    expression: {
      dofs: { BODY: 'BODY' },
      AttentionMode: { OFF: 'OFF' },
      pushAttentionMode(mode) {
        const handle = { mode, released: false, release() { this.released = true; calls.push('release'); } };
        handles.push(handle); calls.push('push ' + mode);
        return Promise.resolve(handle);
      },
      cleanup() { calls.push('cleanup'); return Promise.resolve(); }
    },
    animDB: {
      getAnimByName(name) {
        return { play() {
          calls.push('play ' + name);
          const playback = { stop() { calls.push('stop'); } };
          return { playback, result: pose.never ? new Promise(() => {}) : Promise.resolve() };
        } };
      }
    },
    loader: { activeCache: {} }
  };
  return { jibo, calls, handles };
}

// A fake face view manager. `remove` controls the removal of a view: 'ok', 'fail' or 'never'.
export function fakeViews(options = {}) {
  const views = {
    currentView: null, viewStackLength: 1, remove: options.remove || 'ok',
    ActionData: { CALLBACK: 'callback' }, GESTURE: { SWIPE_DOWN: 'swipeDown' }, TRANSITION: { IN: 'in', OUT: 'out' },
    created: [],
    createView(type, config) {
      const view = { type, config, state: 'active', actions: [], viewStateStacked: false,
        addAction(kind, data, a, b, gesture) { this.actions.push({ kind, data, gesture }); } };
      views.created.push(view);
      return view;
    },
    changeView(options, done, failed) {
      if (options.addView) { views.currentView = options.addView; if (done) done(); return; }
      if (views.remove === 'ok') { views.currentView = null; done(); }
      else if (views.remove === 'fail') failed();
    }
  };
  return views;
}

export class FakeBeSkill {
  constructor() { this.exits = 0; this.log = { info() {}, warn() {}, error() {} }; }
  exit() { this.exits++; }
  destroy(done) { done(); }
}
