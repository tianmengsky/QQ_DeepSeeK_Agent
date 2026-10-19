import assert from 'node:assert/strict';
import { attach } from '../tools/snowluma-account-loader.mjs';

let passed = 0;
async function scenario(name, setup, verify) {
  const loads = [];
  const states = [];
  let enumerations = 0;
  let probes = 0;
  const fixture = setup();
  const manager = {
    listProcesses: async () => fixture.processes,
    probeProcessLoginInfo: async (pid) => { probes++; return fixture.identities.get(pid); },
    loadProcess: async (pid) => { loads.push(pid); if (fixture.failLoad) throw new Error('failure'); },
  };
  const loader = attach({ hookManager: manager, uin: '3667925015',
    enumerateOsProcesses: async () => { enumerations++; return fixture.os; }, writeState: (s) => states.push(s), report: () => {}, intervalMs: 1e8 });
  try {
    // Drain startup tick, then explicitly check repeated decisions.
    await new Promise((r) => setImmediate(r));
    await loader.tick();
    await verify({ loads, states, fixture, loader, enumerations, probes });
    passed++;
    console.log('PASS ' + name);
  } finally { loader.stop(); }
}
function base() {
  return { processes: [{ pid: 1, status: 'available' }, { pid: 2, status: 'available' }],
    os: [{ pid: 1, parentPid: 0, name: 'QQ.exe' }, { pid: 2, parentPid: 0, name: 'QQ.exe' }],
    identities: new Map([[1, { identityKnown: true, uin: '1056612947' }], [2, { identityKnown: true, uin: '3667925015' }]]) };
}
await scenario('only robot account is injected, once', base, ({ loads }) => assert.deepEqual(loads, [2]));
await scenario('unknown identity is never guessed', () => { const f = base(); f.identities.set(2, null); return f; }, ({ loads, states }) => {
  assert.deepEqual(loads, []); assert.equal(states.at(-1).state, 'waiting-login');
});
await scenario('legacy adapter descendant is excluded', () => { const f = base(); f.os.push({ pid: 9, name: 'NapCatWinBootMain.exe' }); f.os[1].parentPid = 9; return f; }, ({ loads }) => assert.deepEqual(loads, []));
await scenario('two matching sessions require resolution', () => { const f = base(); f.identities.set(1, f.identities.get(2)); return f; }, ({ loads, states }) => {
  assert.deepEqual(loads, []); assert.equal(states.at(-1).state, 'ambiguous-account');
});
await scenario('already connected account is reused without shell probes', () => { const f = base(); Object.assign(f.processes[1], { loggedIn: true, uin: '3667925015' }); return f; }, ({ loads, states, enumerations, probes }) => {
  assert.deepEqual(loads, []); assert.equal(states.at(-1).state, 'connected');
  assert.equal(enumerations, 0); assert.equal(probes, 0);
});
await scenario('account disconnect resumes identity checks before reconnecting', () => { const f = base(); Object.assign(f.processes[1], { loggedIn: true, uin: '3667925015' }); return f; }, async ({ loads, fixture, loader }) => {
  assert.deepEqual(loads, []);
  fixture.processes[1].loggedIn = false;
  fixture.identities.set(2, { identityKnown: true, uin: '1056612947' });
  await loader.tick();
  assert.deepEqual(loads, []);
  fixture.identities.set(2, { identityKnown: true, uin: '3667925015' });
  await loader.tick();
  assert.deepEqual(loads, [2]);
});
await scenario('failed injection does not repeat every tick', () => ({ ...base(), failLoad: true }), ({ loads }) => assert.deepEqual(loads, [2]));
await scenario('Electron child is excluded even when identity matches', () => { const f = base(); f.os[1].commandLine = 'QQ.exe --type=renderer'; return f; }, ({ loads }) => assert.deepEqual(loads, []));
await scenario('running QQ with unidentifiable accounts reports probe failure without injection', () => {
  const f = base(); f.identities.set(1, null); f.identities.set(2, null); return f;
}, ({ loads, states }) => {
  assert.deepEqual(loads, []);
  assert.equal(states.at(-1).state, 'identity-unavailable');
  assert.deepEqual(states.at(-1).candidates.map((p) => p.pid), [1, 2]);
});
console.log(`${passed} passed, 0 failed`);
