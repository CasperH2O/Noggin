# Third-party material

Noggin is MIT licensed (see `LICENSE`). Parts of it follow or adapt code from BEam:

**BEam** (https://github.com/Jibo-Revival-Group/BEam), BSD-3-Clause, Copyright (c) 2026, Zane V.

- The conversation follows BEam's Agent Mode (`@be/be/skills/agent`): turning off the hotword
  for a session, LED colours, the thinking eye via AnimDB, and the stop-phrase list.
- `noggin/lib/comeback.js` (coming back after another skill) is adapted from Agent Mode's
  `comeback.js`: the polling watcher, the speech recording and the skill relaunch.

BSD-3-Clause terms: redistributions of source code must retain the copyright notice above, this
list of conditions and the disclaimer; redistributions in binary form must reproduce them in the
documentation; the name of the copyright holder and contributors may not be used to endorse or
promote products derived from this software without prior written permission. THIS SOFTWARE IS
PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES
ARE DISCLAIMED.

No firmware, SDK, animations, models, fonts or credentials ship with Noggin.
