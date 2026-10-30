// v18.14.11 (Oct 30 2026): cross-device catch-up in web/ops.html, run against the real store/fetch code.
// Pulls the V17 store + fetch + realtime + write section out of ops.html and runs it with a fake Supabase client
// (synthetic rows only). Scenarios:
//   1 rows changed earlier on device A while device B slept, then a later save on B (echo) and a live row:
//     B's next catch-up must still fetch A's rows
//   2 Sync now ('manual') does a full reload
//   3 coming back after more than 10 minutes hidden: the next fetch is a full reload
//   4 a fetch that hangs is cut at 25 s, the next one runs and rejoins live updates
// Usage: node scripts/test_ops_sync.js [path/to/ops.html]   (exit 1 on any failure)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'web', 'ops.html');
const html = fs.readFileSync(file, 'utf8');
const a = html.indexOf('/* ---------- the store: Supabase rows'), b = html.indexOf('async function sbHealthy(');
if (a < 0 || b < 0) { console.error('markers not found in', file); process.exit(1); }
const SRC = html.slice(a, b);

const T0 = Date.parse('2026-10-30T06:00:00Z');
let clock = T0;                                   // fake wall clock (Date.now)
const iso = t => new Date(t).toISOString();

function makeEnv() {
  const server = { people: [], accounts: [], queue: [], brief: [], log_entries: [] };
  const calls = [];                               // every select: {table, gt}
  let hangNext = 0;
  function builder(table) {
    const st = { table, gt: null, gtCol: null };
    const exec = () => {
      calls.push({ table, gt: st.gt, col: st.gtCol });
      let rows = server[table] || [];
      if (st.gt != null) rows = rows.filter(r => st.gtCol === 'id' ? r.id > st.gt : Date.parse(r.updated_at) > Date.parse(st.gt));
      return { data: rows.map(r => Object.assign({}, r)), error: null, status: 200 };
    };
    const q = {
      select() { return q; }, order() { return q; },
      gt(col, v) { st.gtCol = col; st.gt = v; return q; },
      range() { return q; },
      then(res, rej) {
        if (hangNext > 0) { hangNext--; return new Promise(() => {}).then(res, rej); }   // never settles (iOS suspend)
        return Promise.resolve(exec()).then(res, rej);
      }
    };
    return q;
  }
  let subs = 0;
  const client = {
    from: builder,
    auth: { getSession: async () => ({ data: { session: { access_token: 'x' } } }), signOut: async () => {} },
    realtime: { setAuth() {} },
    channel() { const ch = { on() { return ch; }, subscribe(cb) { subs++; ch.cb = cb; setTimeout(() => cb('SUBSCRIBED'), 0); return ch; } }; return ch; },
    removeChannel() {},
    rpc: async (fn, args) => ({ data: { row: env.rpcRow, ok: true }, error: null, status: 200 })
  };
  const listeners = {};
  const document = {
    hidden: false,
    documentElement: { classList: { add() {}, remove() {} } },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    querySelector() { return null; }
  };
  // timers: real, but 25 s cut scaled down to 25 ms so the suite stays quick
  const sbx = {
    console, Promise, Object, Array, Map, Set, JSON, Math, String, Number, Error, isNaN, Date: class extends Date {
      constructor(...x) { if (x.length) super(...x); else super(clock); }
      static now() { return clock; }
    },
    setTimeout: (f, ms) => setTimeout(f, ms >= 20000 ? ms / 1000 : Math.min(ms || 0, 5)),
    clearTimeout, performance: { now: () => 0 }, navigator: { onLine: true },
    document, addEventListener() {}, crypto: { randomUUID: () => 'u' + Math.random() },
    toast() {}, syncLine() {}, publish17() {}, accept() {}, flushSoon() {}, pushBoot17() {}, outbox: () => [],
    legacyFetch: () => Promise.resolve(), tokValid: () => true, locked17: () => false, me: () => 'x', QA: false,
    LS17: { g: () => 0, s() {}, r() {}, j: (k, d) => d }, SYNC: {}, IST_MS: 19800000, todayIST: () => '2026-10-30',
    DATA: null, DEVICE17: 'test', SBK: 'k', login() {}, window: {}, V17: { signed: () => true, rt: { n: 0 } },
    ST17: { session: { access_token: 'x' }, client }, READY17: Promise.resolve(client), LS3: { s() {} }, SB_URL: '', SB_KEY: '',
    sbStored: () => true, dl17: false, deepLink17() {}
  };
  const env = { server, calls, client, sbx, listeners, document, subs: () => subs, hang: n => { hangNext = n; } };
  vm.createContext(sbx);
  // publish17 is defined inside SRC; the stub above is replaced by the real one, which needs locked17/accept (stubbed)
  vm.runInContext(SRC + '\n;this.__V17=V17;this.__S17=S17;this.__rpc17=rpc17;this.__onRow17=onRow17;', sbx, { filename: 'ops-v17-section.js' });
  env.V17 = sbx.__V17; env.S17 = sbx.__S17; env.rpc17 = sbx.__rpc17; env.onRow17 = sbx.__onRow17;
  return env;
}
const person = (id, t, extra) => Object.assign({ id, name: 'Test Person ' + id, company: 'Brennuvia Co', updated_at: iso(t) }, extra || {});
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, done = false;
// a fetch that never settles empties the event loop: count that as a failure, never a silent pass
process.on('beforeExit', () => { if (!done) { console.log('FAIL a fetch never settled (the page would stay frozen on old data)'); process.exit(1); } });
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const lastFetchWasFull = env => { const pc = env.calls.filter(c => c.table === 'people'); return pc.length && pc[pc.length - 1].gt == null; };

(async () => {
  // ---------- 1. stale catch-up mark (the Oct 30 report) ----------
  {
    clock = T0; const e = makeEnv();
    e.server.people = [person('P001', T0 - 864e5), person('P002', T0 - 864e5), person('P003', T0 - 864e5), person('P004', T0 - 864e5)];
    await e.V17.fetch('boot');                                         // device B: first full load
    ok(e.S17.loaded && e.S17.people.size === 4, '1a device B full load: 4 rows');
    // device A marks P001 + P002 at 11:36 IST while B is asleep (no realtime reaches B)
    const tA = T0 + 36 * 60e3;
    e.server.people[0] = person('P001', tA, { dm2_sent: iso(tA) });
    e.server.people[1] = person('P002', tA + 60e3, { dm3_sent: iso(tA + 60e3) });
    // 3.5 h later B wakes; before its catch-up lands it snoozes P003 (save echo) and a live row for P004 arrives
    const tB = T0 + 4 * 36e5; clock = tB;
    e.server.people[2] = person('P003', tB, { snooze_until: '2026-10-31' });
    e.sbx.window = {};
    e.rpcRow = Object.assign({}, e.server.people[2]);
    await e.rpc17('set', 'people', 'P003', { snooze_until: '2026-10-31' }, 'setFields', ['P003', { snooze_until: '2026-10-31' }]);
    e.server.people[3] = person('P004', tB + 1000, { next_action: 'Send DM2' });
    e.onRow17('people', { eventType: 'UPDATE', new: Object.assign({}, e.server.people[3]) });
    await e.V17.fetch('unlock');                                       // incremental catch-up (short gap)
    const p1 = e.S17.people.get('P001') || {}, p2 = e.S17.people.get('P002') || {};
    ok(!!p1.dm2_sent && !!p2.dm3_sent, '1b after a later local save and a live row, the catch-up still fetched device A\'s earlier marks (P001 dm2_sent, P002 dm3_sent)');
    ok(!lastFetchWasFull(e), '1c that catch-up was incremental (the mark logic fixed it, not a full reload)');
  }
  // ---------- 2. Sync now = full reload ----------
  {
    clock = T0; const e = makeEnv(); e.server.people = [person('P010', T0 - 1000)];
    await e.V17.fetch('boot'); await e.V17.fetch('auto');
    ok(!lastFetchWasFull(e), '2a an ordinary refetch is incremental');
    await e.V17.fetch('manual');
    ok(lastFetchWasFull(e), '2b Sync now (manual) reloads everything');
    await e.V17.fetch('auto');
    ok(!lastFetchWasFull(e), '2c and the next ordinary refetch is incremental again');
  }
  // ---------- 3. long gap = full reload ----------
  {
    clock = T0; const e = makeEnv(); e.server.people = [person('P020', T0 - 1000)];
    await e.V17.fetch('boot');
    const vis = () => (e.listeners.visibilitychange || []).forEach(f => f());
    e.document.hidden = true; vis(); clock += 5 * 60e3; e.document.hidden = false; vis();
    await e.V17.fetch('foreground');
    ok(!lastFetchWasFull(e), '3a back after 5 min: incremental');
    e.document.hidden = true; vis(); clock += 11 * 60e3; e.document.hidden = false; vis();
    await e.V17.fetch('unlock');
    ok(lastFetchWasFull(e), '3b back after 11 min: full reload');
  }
  // ---------- 4. hung fetch is cut, next one runs and rejoins live ----------
  {
    clock = T0; const e = makeEnv(); e.server.people = [person('P030', T0 - 1000)];
    await e.V17.fetch('boot');
    const subs0 = e.subs();
    e.V17.stopLive(); e.hang(5);                                      // the next 5 queries never answer
    const t = Date.now(); const r = await Promise.race([e.V17.fetch('foreground').then(() => 'settled'), wait(2000).then(() => 'stuck')]);
    ok(r === 'settled', '4a a hung fetch settles (25 s cut) instead of holding every later fetch');
    e.server.people.push(person('P031', clock + 1000)); clock += 2000;
    await e.V17.fetch('foreground');
    ok(e.S17.people.has('P031'), '4b the next fetch runs and brings new rows');
    await wait(10);
    ok(e.subs() > subs0, '4c and live updates are joined again');
  }
  done = true;
  console.log(fails ? `\n${fails} FAILED (${path.basename(file)})` : `\nall passed (${path.basename(file)})`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
