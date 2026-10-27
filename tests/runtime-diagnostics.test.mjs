import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeDiagnostics } from '../packages/dsh-dafeiyu/src/runtime-diagnostics.js';

const PRIVATE = 'PRIVATE_ADB_ERROR_CANARY';
function fixture(options = {}) {
  const state = { authorized: true, busy: false, phone: { enabled: true, device: 'fixture-phone:5555', adbPath: '/fixture/adb' }, calls: [] };
  const diagnostics = new RuntimeDiagnostics({ getRuntime: () => ({ phoneTools: state.phone }), getBusy: () => state.busy,
    timeoutMs: options.timeoutMs, now: options.now,
    execFileImpl: async (...args) => { state.calls.push(args); return options.exec ? options.exec(...args) : { stdout: 'device\n', stderr: PRIVATE }; } });
  return { state, diagnostics, authorization: { authorize: () => state.authorized } };
}

test('passive phone status never enumerates, reconnects, records, screenshots or launches commands', () => {
  const f = fixture(); assert.equal(f.diagnostics.phone().state, 'not-probed');
  assert.equal(f.state.calls.length, 0); assert.equal(f.diagnostics.phone().checkedAt, null);
});

test('explicit phone check runs only the configured device get-state with bounded read-only arguments', async () => {
  const f = fixture(), result = await f.diagnostics.checkPhone(f.authorization);
  assert.equal(result.state, 'online'); assert.ok(result.checkedAt);
  assert.equal(f.state.calls.length, 1);
  const [file, args, options] = f.state.calls[0];
  assert.equal(file, '/fixture/adb'); assert.deepEqual(args, ['-s', 'fixture-phone:5555', 'get-state']);
  assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 8192);
  assert.equal(options.shell, undefined);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test('disabled, absent-device and unauthenticated checks execute no commands', async () => {
  for (const mode of ['disabled', 'no-device', 'unauthenticated']) {
    const f = fixture();
    if (mode === 'disabled') f.state.phone.enabled = false;
    if (mode === 'no-device') f.state.phone.device = '';
    if (mode === 'unauthenticated') f.state.authorized = false;
    await assert.rejects(f.diagnostics.checkPhone(f.authorization), (error) => ['UNAVAILABLE', 'FORBIDDEN'].includes(error.code));
    assert.equal(f.state.calls.length, 0);
  }
});

test('offline and malformed replies or process failures never become online or expose raw output', async () => {
  for (const output of ['offline\n', 'unauthorized\n', PRIVATE, null]) {
    const f = fixture({ exec: async () => {
      if (output === null) throw new Error(PRIVATE);
      return { stdout: output, stderr: PRIVATE };
    } });
    const result = await f.diagnostics.checkPhone(f.authorization);
    assert.equal(result.state, 'offline'); assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  }
});

test('device, host ADB and connection failures receive fixed private-safe diagnoses instead of one generic offline explanation', async () => {
  const cases = [
    [{ stdout: 'offline\n' }, null, 'device_offline'],
    [{ stdout: 'unauthorized\n' }, null, 'unauthorized'],
    [null, { stderr: 'error: device unauthorized. ' + PRIVATE }, 'unauthorized'],
    [null, { stderr: "error: device 'fixture-phone:5555' not found " + PRIVATE }, 'device_not_found'],
    [null, { stderr: 'failed to authenticate to fixture-phone:5555 ' + PRIVATE }, 'authentication_failed'],
    [null, { code: 'ENOENT', message: PRIVATE }, 'adb_missing'],
    [null, { code: 'EACCES', message: PRIVATE }, 'adb_not_executable'],
    [null, { stderr: 'cannot connect to daemon at tcp:5037: Connection refused ' + PRIVATE }, 'adb_server_unavailable'],
    [null, { stderr: 'insufficient permissions for device ' + PRIVATE }, 'device_permission_denied'],
    [null, { code: 'ENETUNREACH', message: PRIVATE }, 'network_unreachable'],
    [null, { code: 'ECONNREFUSED', message: PRIVATE }, 'connection_refused'],
    [null, { code: 'ETIMEDOUT', message: PRIVATE }, 'check_timeout'],
    [null, { code: 'ENOTFOUND', message: PRIVATE }, 'address_unresolved'],
    [{ stdout: PRIVATE }, null, 'check_failed'],
  ];
  for (const [result, error, expected] of cases) {
    const f = fixture({ exec: async () => { if (error) throw Object.assign(new Error(error.message || PRIVATE), error); return result; } });
    const state = await f.diagnostics.checkPhone(f.authorization);
    assert.equal(state.reasonCode, expected); assert.equal(state.state, 'offline');
    assert.ok(state.note); assert.ok(state.nextStep); assert.ok(state.checkedAt);
    assert.equal(JSON.stringify(state).includes(PRIVATE), false);
    assert.deepEqual(f.state.calls[0][1], ['-s', 'fixture-phone:5555', 'get-state']);
  }
});

test('a specific failed connect survives stale local device entries, while verified online or authorization state takes priority', async () => {
  for (const [connectMessage, expected] of [
    ['failed to connect: No route to host', 'network_unreachable'],
    ['cannot connect: Connection refused', 'connection_refused'],
    ['failed to connect: Connection timed out', 'connect_timeout'],
  ]) {
    for (const stateText of ['offline', "error: device 'fixture-phone:5555' not found"]) {
      const f = fixture({ exec: async (_file, args) => args[0] === 'connect'
        ? { stdout: connectMessage + '\n' + PRIVATE } : { stdout: stateText, stderr: PRIVATE } });
      const state = await f.diagnostics.connectPhone(f.authorization);
      assert.equal(state.reasonCode, expected); assert.equal(state.state, 'offline'); assert.equal(f.state.calls.length, 2);
      assert.equal(JSON.stringify(state).includes(PRIVATE), false);
      assert.doesNotMatch(state.note, /未配对|配对失败|端口已变/);
    }
  }
  for (const [stateText, expected] of [['device', 'online'], ['unauthorized', 'unauthorized']]) {
    const f = fixture({ exec: async (_file, args) => args[0] === 'connect'
      ? { stdout: 'failed to connect: Connection refused ' + PRIVATE } : { stdout: stateText } });
    const state = await f.diagnostics.connectPhone(f.authorization);
    assert.equal(state.reasonCode, expected); assert.equal(state.state, stateText === 'device' ? 'online' : 'offline');
  }
});

test('an internal connect timeout is diagnosed without inventing a pairing failure or leaking the timed-out command', async () => {
  const f = fixture({ timeoutMs: 10, exec: (_file, args) => args[0] === 'connect'
    ? new Promise(() => {}) : Promise.resolve({ stdout: 'offline', stderr: PRIVATE }) });
  const result = await f.diagnostics.connectPhone(f.authorization);
  assert.equal(result.reasonCode, 'connect_timeout'); assert.equal(result.state, 'offline');
  assert.match(result.nextStep, /超时不能证明配对失败/); assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(f.diagnostics.active, 0);
});

test('revoked authorization during awaited get-state prevents storing or returning the observation', async () => {
  const f = fixture({ exec: async () => { f.state.authorized = false; return { stdout: 'device' }; } });
  await assert.rejects(f.diagnostics.checkPhone(f.authorization), (error) => error.code === 'FORBIDDEN');
  assert.equal(f.diagnostics.phone().state, 'not-probed'); assert.equal(f.diagnostics.phone().checkedAt, null);
});

test('runtime replacement, device changes or disabling during a probe invalidate the pending observation', async () => {
  for (const mode of ['replacement', 'device', 'disable']) {
    const f = fixture({ exec: async () => {
      if (mode === 'replacement') f.state.phone = { ...f.state.phone };
      if (mode === 'device') f.state.phone.device = 'different-phone';
      if (mode === 'disable') f.state.phone.enabled = false;
      return { stdout: 'device' };
    } });
    await assert.rejects(f.diagnostics.checkPhone(f.authorization), (error) => error.code === 'CONFLICT');
    assert.equal(f.diagnostics.phone().checkedAt, null);
  }
});

test('a new phone runtime with the same serial does not inherit the previous runtime online proof', async () => {
  const f = fixture(); await f.diagnostics.checkPhone(f.authorization);
  f.state.phone = { ...f.state.phone };
  assert.equal(f.diagnostics.phone().state, 'not-probed'); assert.equal(f.diagnostics.phone().checkedAt, null);
});

test('an adb executable change during the check invalidates the pending proof', async () => {
  const f = fixture({ exec: async () => { f.state.phone.adbPath = '/different/adb'; return { stdout: 'device' }; } });
  await assert.rejects(f.diagnostics.checkPhone(f.authorization), (error) => error.code === 'CONFLICT');
  assert.equal(f.diagnostics.phone().checkedAt, null);
});

test('explicit wireless connect targets only the configured TCP device, then verifies exact get-state', async () => {
  const f = fixture(), result = await f.diagnostics.connectPhone(f.authorization);
  assert.equal(result.state, 'online'); assert.equal(result.checking, false);
  assert.equal(result.canConnect, true); assert.equal(f.diagnostics.active, 0);
  assert.deepEqual(f.state.calls.map(([file, args]) => [file, args]), [
    ['/fixture/adb', ['connect', 'fixture-phone:5555']],
    ['/fixture/adb', ['-s', 'fixture-phone:5555', 'get-state']],
  ]);
  for (const [, , options] of f.state.calls) {
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 8192);
    assert.equal(options.shell, undefined); assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test('connect success text never proves online; actual get-state remains required after connect fails', async () => {
  for (const online of [false, true]) {
    let count = 0;
    const f = fixture({ exec: async () => {
      count++;
      if (count === 1) {
        if (online) throw new Error(PRIVATE);
        return { stdout: 'connected to fixture-phone:5555', stderr: PRIVATE };
      }
      return { stdout: online ? 'device\n' : 'offline\n', stderr: PRIVATE };
    } });
    const result = await f.diagnostics.connectPhone(f.authorization);
    assert.equal(count, 2); assert.equal(result.state, online ? 'online' : 'offline');
    assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  }
});

test('wireless connect accepts only explicit IPv4, DNS or bracketed IPv6 with valid TCP port', async () => {
  for (const device of ['192.0.2.1:5555', 'phone.lan:37123', 'localhost:1', '[2001:db8::1]:65535']) {
    const f = fixture(); f.state.phone.device = device;
    assert.equal(f.diagnostics.phone().canConnect, true, device);
    await f.diagnostics.connectPhone(f.authorization);
    assert.deepEqual(f.state.calls[0][1], ['connect', device]);
    assert.deepEqual(f.state.calls[1][1], ['-s', device, 'get-state']);
  }
  for (const device of ['USB_SERIAL', '--help', 'phone', 'phone:0', 'phone:65536', 'phone:-1', 'phone:5555 ',
    ' phone:5555', 'phone:5555\n', 'phone:5555/other', '192.0.2.999:5555', '-phone:5555', 'phone..lan:5555',
    'phone_:5555', '[invalid]:5555', '2001:db8::1:5555', 'tcp://phone:5555', `phone;${PRIVATE}:5555`]) {
    const f = fixture(); f.state.phone.device = device;
    assert.equal(f.diagnostics.phone().canConnect, false, device);
    await assert.rejects(f.diagnostics.connectPhone(f.authorization), (error) => error.code === 'INVALID_CONFIG');
    assert.equal(f.state.calls.length, 0, device);
  }
  const usb = fixture(); usb.state.phone.device = 'USB_SERIAL';
  assert.equal((await usb.diagnostics.checkPhone(usb.authorization)).state, 'online');
  assert.deepEqual(usb.state.calls[0][1], ['-s', 'USB_SERIAL', 'get-state']);
});

test('disabled or unauthorized wireless connect never enables permission or runs adb', async () => {
  for (const mode of ['disabled', 'no-device', 'unauthenticated']) {
    const f = fixture();
    if (mode === 'disabled') f.state.phone.enabled = false;
    if (mode === 'no-device') f.state.phone.device = '';
    if (mode === 'unauthenticated') f.state.authorized = false;
    const before = { ...f.state.phone };
    await assert.rejects(f.diagnostics.connectPhone(f.authorization), (error) => ['UNAVAILABLE', 'FORBIDDEN'].includes(error.code));
    assert.deepEqual(f.state.phone, before); assert.equal(f.state.calls.length, 0);
  }
});

test('authorization or identity changes during connect cancel verification and leave no cached proof', async () => {
  for (const mode of ['authorization', 'replacement', 'device', 'adbPath', 'disable']) {
    const f = fixture({ exec: async () => {
      if (mode === 'authorization') f.state.authorized = false;
      if (mode === 'replacement') f.state.phone = { ...f.state.phone };
      if (mode === 'device') f.state.phone.device = 'other-phone:5555';
      if (mode === 'adbPath') f.state.phone.adbPath = '/other/adb';
      if (mode === 'disable') f.state.phone.enabled = false;
      return { stdout: 'connected' };
    } });
    await assert.rejects(f.diagnostics.connectPhone(f.authorization), (error) => error.code === (mode === 'authorization' ? 'FORBIDDEN' : 'CONFLICT'));
    assert.equal(f.state.calls.length, 1, mode); assert.equal(f.diagnostics.phone().checkedAt, null, mode);
    assert.equal(f.diagnostics.active, 0);
  }
});

test('check and connect share one gate and reject concurrent operations or an externally busy runtime', async () => {
  for (const method of ['checkPhone', 'connectPhone']) {
    const busy = fixture(); busy.state.busy = true;
    await assert.rejects(busy.diagnostics[method](busy.authorization), (error) => error.code === 'BUSY');
    assert.equal(busy.state.calls.length, 0);
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const f = fixture({ exec: () => pending });
    const running = f.diagnostics[method](f.authorization);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.diagnostics.active, 1); assert.equal(f.diagnostics.phone().checking, true);
    for (const other of ['checkPhone', 'connectPhone']) {
      await assert.rejects(f.diagnostics[other](f.authorization), (error) => error.code === 'BUSY');
    }
    assert.equal(f.state.calls.length, 1);
    release({ stdout: 'device' }); await running;
    assert.equal(f.diagnostics.active, 0); assert.equal(f.diagnostics.phone().checking, false);
  }
});

test('timeouts settle even if exec ignores abort, and do not expose command output or claim online', async () => {
  const f = fixture({ timeoutMs: 10, exec: () => new Promise(() => {}) });
  const result = await f.diagnostics.connectPhone(f.authorization);
  assert.equal(result.state, 'offline'); assert.equal(f.state.calls.length, 2);
  assert.ok(f.state.calls.every(([, , options]) => options.signal.aborted));
  assert.equal(f.diagnostics.active, 0); assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test('dispose aborts pending connect, prevents subsequent get-state and revokes captured methods', async () => {
  const f = fixture({ exec: () => new Promise(() => {}) });
  const pending = f.diagnostics.connectPhone(f.authorization);
  await new Promise((resolve) => setImmediate(resolve));
  f.diagnostics.dispose();
  await assert.rejects(pending, (error) => error.code === 'UNAVAILABLE');
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.calls[0][2].signal.aborted, true);
  assert.equal(f.diagnostics.phone().checkedAt, null); assert.equal(f.diagnostics.phone().canConnect, false);
  for (const method of ['checkPhone', 'connectPhone']) {
    await assert.rejects(f.diagnostics[method](f.authorization), (error) => error.code === 'UNAVAILABLE');
  }
});

test('phone observations expire after sixty seconds and connection configuration changes invalidate proof', async () => {
  let now = Date.now(); const f = fixture({ now: () => now });
  await f.diagnostics.connectPhone(f.authorization);
  assert.equal(f.diagnostics.phone().state, 'online');
  now += 60001;
  assert.equal(f.diagnostics.phone().state, 'not-probed');
  assert.equal(f.diagnostics.phone().reasonCode, 'stale');
  assert.match(f.diagnostics.phone().note, /过期/);
  f.state.phone.adbPath = '/changed/adb';
  assert.equal(f.diagnostics.phone().checkedAt, null);
  assert.equal(f.state.calls.length, 2, 'passive status never reconnects');
});

test('revocation or configuration changes before the exec microtask prevent every adb command', async () => {
  for (const method of ['checkPhone', 'connectPhone']) {
    for (const mode of ['authorization', 'replacement', 'device', 'adbPath', 'disable', 'dispose']) {
      const f = fixture();
      const pending = f.diagnostics[method](f.authorization);
      if (mode === 'authorization') f.state.authorized = false;
      if (mode === 'replacement') f.state.phone = { ...f.state.phone };
      if (mode === 'device') f.state.phone.device = 'changed-phone:5555';
      if (mode === 'adbPath') f.state.phone.adbPath = '/changed/adb';
      if (mode === 'disable') f.state.phone.enabled = false;
      if (mode === 'dispose') f.diagnostics.dispose();
      await assert.rejects(pending, (error) => error.code === (mode === 'authorization' ? 'FORBIDDEN' : mode === 'dispose' ? 'UNAVAILABLE' : 'CONFLICT'));
      assert.equal(f.state.calls.length, 0, `${method}: ${mode}`);
      assert.equal(f.diagnostics.phone().checkedAt, null);
    }
  }
});
