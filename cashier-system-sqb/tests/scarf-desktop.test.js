import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('desktop sandbox exposes the six scarf operations and still rejects arbitrary IPC', async () => {
  let bridge;
  const calls = [];
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'sqb'); bridge = value; } },
    ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve({ ok: true }); } },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return electron; },
  });
  for (const suffix of ['config', 'connect', 'snapshot', 'update', 'export-connection', 'import-connection']) {
    const action = 'scarf-' + suffix;
    await bridge.call(action, { marker: action });
    assert.equal(calls.at(-1)[0], 'sqb:call');
    assert.equal(calls.at(-1)[1], action);
    assert.equal(calls.at(-1)[2].marker, action);
  }
  await assert.rejects(bridge.call('scarf-eval'), /不支持/);
  await assert.rejects(bridge.call('arbitrary-filesystem-read'), /不支持/);
  assert.equal(calls.length, 6);
});
