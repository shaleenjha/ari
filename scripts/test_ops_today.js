// v18.14.12 (Nov 2 2026): two Today fixes in web/ops.html, run against the real code with a minimal fake DOM (no jsdom in the repo).
// Synthetic rows only. Scenarios:
//   A  Today's list (#v1812q) and status (#v1812st) are not rewritten on a second render with the same data, even when a name
//      has an apostrophe (escaped to &#39;, which the browser serializes back as '), and not after an in-place row edit
//      (the ui5 observer). It IS rewritten when the data changes or when someone else emptied the slot.
//   B  Focus "Remove from queue" on a relay reply keeps the people.skipped write and its toast, calls ari_reply_done
//      (p_id = the reply id, 'dismissed'), then reloads Today's top data (ari_today_top). A DM never calls ari_reply_done.
// Usage: node scripts/test_ops_today.js [path/to/ops.html] [--expect-bug]   (exit 1 on any failure)
//   --expect-bug runs scenario A against an older build and passes only if the old redraw bug shows (sanity check of the test).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const args = process.argv.slice(2), EXPECT_BUG = args.includes('--expect-bug');
const file = args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'web', 'ops.html');
const html = fs.readFileSync(file, 'utf8');
let fails = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { fails++; console.log('  FAIL ' + m); } };

// ---------- a minimal DOM: ids, children, innerHTML that serializes like a browser (&#39; comes back as ') ----------
function makeDoc() {
  const byId = new Map(); let seq = 0;
  class CL { constructor() { this.s = new Set(); } add(c) { this.s.add(c); } remove(c) { this.s.delete(c); } contains(c) { return this.s.has(c); } toggle(c, on) { if (on === undefined) on = !this.s.has(c); on ? this.s.add(c) : this.s.delete(c); return on; } }
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this._id = ''; this.className = ''; this.dataset = {}; this.style = {}; this.hidden = false; this._h = ''; this._fc = null; this.writes = 0; this.classList = new CL(); this.attrs = {}; this.textContent = ''; }
    get id() { return this._id; } set id(v) { this._id = v; if (v) byId.set(v, this); }
    get firstElementChild() { return this.children[0] || null; }
    get firstChild() { return this.children[0] || this._fc; }
    get innerHTML() { return this._h; }
    set innerHTML(h) {
      h = String(h); this.writes++; this.children.forEach(c => { c.parentNode = null; }); this.children = [];
      this._h = h.replace(/&#39;/g, "'");                     // what a browser hands back when the markup is read again
      this._fc = h ? { node: ++seq } : null;                   // a fresh first node on every write
      const re = /<(\w+)[^>]*?\sid="([^"]+)"/g; let m;          // elements with ids become real children (mount() needs them)
      while ((m = re.exec(h))) { const c = new El(m[1]); c.id = m[2]; c.parentNode = this; this.children.push(c); }
    }
    appendChild(n) { if (n.parentNode) n.parentNode.children = n.parentNode.children.filter(x => x !== n); n.parentNode = this; this.children.push(n); return n; }
    insertBefore(n, ref) { if (n.parentNode) n.parentNode.children = n.parentNode.children.filter(x => x !== n); n.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; i < 0 ? this.children.push(n) : this.children.splice(i, 0, n); return n; }
    after(n) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); if (n.parentNode) n.parentNode.children = n.parentNode.children.filter(x => x !== n); n.parentNode = p; p.children.splice(i + 1, 0, n); }
    get nextElementSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; }
    querySelector(s) { return /^#[\w-]+$/.test(s) ? (byId.get(s.slice(1)) || null) : null; }
    querySelectorAll() { return []; }
    addEventListener() {} removeEventListener() {} dispatchEvent() { return true; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    closest() { return null; } contains() { return false; }
  }
  const listeners = {};
  const doc = {
    hidden: false, body: new El('body'), documentElement: new El('html'),
    createElement: t => new El(t),
    getElementById: id => byId.get(id) || null,
    querySelector: s => /^#[\w-]+$/.test(s) ? (byId.get(s.slice(1)) || null) : null,
    querySelectorAll: () => [],
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }, removeEventListener() {}
  };
  return { doc, El, byId };
}
function ctxFor(doc, extra) {
  const w = Object.assign({
    document: doc, navigator: { onLine: true, vibrate() {} }, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    getComputedStyle: () => ({ display: 'block' }), localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CSS: { escape: s => s }, MouseEvent: function () {}, MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; }, caches: undefined, addEventListener() {}, location: { search: '', hash: '', href: 'https://x/ops' },
    ariIsExec: () => false, ariIsExecId: () => false, Promise, Date, JSON, Math, String, Number, Array, Object, Set, Map, RegExp, Error, isFinite, isNaN, Intl
  }, extra || {});
  w.window = w; w.globalThis = w; return vm.createContext(w);
}
function iifeBody(startMarker, endMarker, exportsExpr) {
  const a = html.indexOf(startMarker); if (a < 0) throw new Error('marker not found: ' + startMarker.slice(0, 60));
  const b = html.indexOf(endMarker, a); if (b < 0) throw new Error('end marker not found: ' + endMarker.slice(0, 60));
  return "(function(){'use strict';\n" + html.slice(a, b) + '\n' + exportsExpr + '\n})();';
}

// ---------- A. Today list redraw ----------
console.log('A  Today list is not rewritten for the same data (' + path.basename(file) + ')');
{
  const { doc, El } = makeDoc();
  const rd = new El('div'); rd.id = 'ready'; const top = new El('div'); top.id = 'v184top'; rd.appendChild(top); doc.body.appendChild(rd);
  const Q = [
    { tag: 'DM2', id: 'syn-1', n: "Alex O'Sample", c: 'Ixterlane & Co', p: { company: 'Ixterlane & Co', title: 'VP Data' }, why: 'Follow-up due', msg: 'hello' },
    { tag: 'DM1', id: 'syn-2', n: "Jo D'Fixture", c: "Bo's Fixtures", p: { company: "Bo's Fixtures", title: 'CISO' }, why: 'Accepted', msg: 'hi' },
    { tag: 'DM3', id: 'syn-3', n: 'Ana Mock', c: 'Globex', p: { company: 'Globex' }, why: 'Last note', msg: 'bye' }
  ];
  const ctx = ctxFor(doc, { ariM: { Q, PEND: [], COMING: [], WAIT: [] }, ariV17: { signed: () => true, store: { loaded: true, people: new Map() } } });
  const start = "const V=window.ariV1812={v:'v18.12',";
  const s0 = html.lastIndexOf("(function(){'use strict';", html.indexOf(start));
  const src = "(function(){'use strict';\n" + html.slice(s0 + "(function(){'use strict';".length, html.indexOf('V.render=render;', s0)) + '\nV.render=render;globalThis.__A={V,render};\n})();';
  vm.runInContext(src, ctx, { filename: 'ops-v1812.js' });
  const { V, render } = ctx.__A;
  render();
  const q = doc.getElementById('v1812q'), st = doc.getElementById('v1812st');
  ok(!!q && !!st, 'Today slots mounted');
  ok(q && /O&#39;Sample|O'Sample/.test(q.innerHTML), 'the list holds the apostrophe name');
  const w1 = q.writes, s1 = st.writes;
  render(); render(); render();
  const redraws = q.writes - w1;
  if (EXPECT_BUG) {
    ok(redraws > 0, 'old build: the list is rebuilt on every render (' + redraws + ' rewrites in 3 renders), the bug this release fixes');
  } else {
    ok(redraws === 0, 'second, third, fourth render with the same data: list rewritten ' + redraws + ' times (want 0)');
    ok(st.writes - s1 === 0, 'status line rewritten ' + (st.writes - s1) + ' times (want 0)');
    // an in-place edit by another module (the ui5 row observer adds spans inside rows): still no rewrite
    q._h = q._h.replace('</button>', '<span class="t5when">Due today</span></button>');
    render(); ok(q.writes === w1, 'after an in-place row edit: no rewrite');
    // data changes: rewritten once
    Q.push({ tag: 'DM2', id: 'syn-4', n: "Mo O'Placeholder", c: 'Initech', p: { company: 'Initech' }, why: 'x', msg: 'y' });
    render(); ok(q.writes === w1 + 1 && /Mo O'Placeholder/.test(q.innerHTML), 'new data: rewritten exactly once');
    render(); ok(q.writes === w1 + 1, 'and then left alone');
    // someone else empties the slot: our next render puts the list back
    q.innerHTML = ''; const w2 = q.writes; render(); ok(q.writes === w2 + 1 && q.innerHTML.length > 0, 'slot emptied by someone else: written again');
    // the forced repaint used by the Needs-your-call buttons (LAST='') still repaints when the markup changes
    ok(typeof V.qw === 'number' && V.qw >= 2, 'write counter V.qw = ' + V.qw);
  }
}

// ---------- B. Remove from queue on a relay reply ----------
if (!EXPECT_BUG) {
  console.log('B  Remove from queue on a relay reply closes the reply');
  const { doc } = makeDoc();
  const calls = [], muts = [];
  let open = [{ id: 7, person_id: 'syn-p7', name: 'Sam Sample', company: 'Initech', title: 'CTO', snippet: 'Sounds good', snippet_source: 'pasted', drafts: [] },
              { id: 8, person_id: 'syn-p8', name: 'Kai Fixture', company: 'Globex', title: 'VP', snippet: '', snippet_source: 'none', drafts: [] }];
  const client = { rpc: async (fn, a) => { calls.push([fn, a]);
      if (fn === 'ari_reply_done') { if (a.p_outcome === 'dismissed') open = open.filter(r => r.id !== a.p_id); return { data: { id: a.p_id, status: a.p_outcome }, error: null }; }
      if (fn === 'ari_today_top') return { data: { replies: open.map(r => Object.assign({}, r)), connects: [], meta: {} }, error: null };
      return { data: null, error: null }; } };
  const ctx = ctxFor(doc, {
    ariModel: (d, o) => ({ Q: [] }),
    ariV17: { signed: () => true, ready: async () => client },
    ariV16: { mutate: (op, a, msg) => { muts.push([op, a, msg]); return Promise.resolve(); } }
  });
  const start = "const V184=window.ariV184={v:'v18.4',";
  const s0 = html.lastIndexOf("(function(){'use strict';", html.indexOf(start));
  const end = html.indexOf('\n})();', html.indexOf("document.addEventListener('visibilitychange',()=>{if(document.hidden)return;if(FX.open", s0));
  const src = "(function(){'use strict';\n" + html.slice(s0 + "(function(){'use strict';".length, end) + '\nglobalThis.__B={wireFx,FX,V184,repItems};\n})();';
  vm.runInContext(src, ctx, { filename: 'ops-v184.js' });
  const { wireFx, FX, V184, repItems } = ctx.__B;
  ok(typeof V184.dismissRelay === 'function', 'ariV184.dismissRelay exists');
  const run = async () => {
    await V184.load('test');
    ok((V184.top.replies || []).length === 2, 'Today top loaded with 2 open replies');
    let handler = null; const o = { addEventListener: (t, f) => { if (t === 'click') handler = handler || f; }, querySelector: () => null };
    wireFx(o);
    const tap = fx => handler({ target: { closest: s => s === '[data-fx]' ? { dataset: { fx } } : null } });
    FX.items = repItems(); FX.i = 0; FX.open = true;
    const nCalls = calls.length;
    await tap('remove');
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    const done = calls.slice(nCalls).filter(c => c[0] === 'ari_reply_done');
    ok(done.length === 1 && done[0][1].p_id === 7 && done[0][1].p_outcome === 'dismissed', 'ari_reply_done called with p_id 7, outcome dismissed: ' + JSON.stringify(done.map(c => c[1])));
    const sk = muts.filter(m => m[0] === 'setFields' && m[1][0] === 'syn-p7');
    ok(sk.length === 1 && /^\d{4}-\d\d-\d\d$/.test(sk[0][1][1].skipped), 'people.skipped still written for the person');
    ok(sk.length === 1 && sk[0][2] === 'Sam removed. Undo from their person file.', 'toast copy unchanged: ' + (sk[0] && sk[0][2]));
    const reload = calls.slice(nCalls).findIndex(c => c[0] === 'ari_today_top'), di = calls.slice(nCalls).findIndex(c => c[0] === 'ari_reply_done');
    ok(reload > di, 'Today top data reloaded after the dismiss');
    ok(!(V184.top.replies || []).some(r => r.id === 7) && (V184.top.replies || []).length === 1, 'reply 7 gone from Today, reply 8 still there');
    // a DM in the same focus never touches replies
    FX.items = [{ k: 'dm', tag: 'DM2', pid: 'syn-p9', name: 'Lee Dummy', why: '', body: 'x', url: '', field: 'dm2_sent', col: 'dm2_text' }]; FX.i = 0;
    const n2 = calls.length; await tap('remove'); for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
    ok(!calls.slice(n2).some(c => c[0] === 'ari_reply_done'), 'Remove on a DM does not call ari_reply_done');
    ok(muts.some(m => m[0] === 'setFields' && m[1][0] === 'syn-p9'), 'Remove on a DM still writes skipped');
  };
  run().then(() => finish(), e => { fails++; console.log('  FAIL threw ' + (e && e.stack || e)); finish(); });
} else finish();

function finish() { console.log(fails ? fails + ' failure(s)' : 'all passed'); process.exit(fails ? 1 : 0); }
