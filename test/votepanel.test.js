import assert from 'node:assert/strict';
import { VotePanel } from '../client/votepanel.js';
import { VOTE_RUNNING, VOTE_PASSED, VOTE_KICK } from '../shared/protocol.js';

// A stand-in for the page: counts every write to the panel and its lines.
function fakePage() {
  const writes = { n: 0 };
  const node = (tag) => {
    let text = '';
    return {
      tag,
      get textContent() {
        return text;
      },
      set textContent(t) {
        writes.n++;
        text = t;
      },
    };
  };
  globalThis.document = { createElement: node };
  const el = {
    style: {},
    children: [],
    replaceChildren(...c) {
      writes.n++;
      this.children = c;
    },
  };
  return { el, writes };
}

Deno.test('vote panel: a resent vote that changed nothing writes nothing', () => {
  const { el, writes } = fakePage();
  try {
    const panel = new VotePanel(el, () => 'bob', () => '');
    const vote = (at, yes) => ({ id: 1, state: VOTE_RUNNING, issue: VOTE_KICK, caller: 2, yes, no: 0, voters: 4, needed: 3,
      left: 15, mine: 1, detail: 'alice', at });
    panel.update(vote(0, 1), 100);
    assert.equal(el.children.length, 5);
    assert.equal(el.children[0].textContent, 'Vote: Kick alice?');
    // The server resends the running vote twice a second: a new object, the same text.
    const before = writes.n;
    panel.update(vote(500, 1), 600);
    assert.equal(writes.n, before, 'nothing changed: no DOM write');
    // A new yes vote rewrites its line alone.
    panel.update(vote(1000, 2), 1100);
    assert.equal(writes.n, before + 1);
    assert.equal(el.children[2].textContent, 'Yes 2 · No 0 · 3 of 4 needed');
    // The result: the seconds and keys give way to one line.
    panel.update({ ...vote(1500, 3), state: VOTE_PASSED }, 1600);
    assert.equal(el.children.length, 4);
    assert.equal(el.children[3].textContent, 'Vote passed');
    panel.update(null, 1700);
    assert.equal(el.style.display, 'none');
    assert.equal(el.children.length, 0);
  } finally {
    delete globalThis.document;
  }
});
