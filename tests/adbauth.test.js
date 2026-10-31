// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	lib/adbauth.js against a stand-in adbd: a unix socket of its own (under
	os.tmpdir(); set TMPDIR to put it elsewhere) that sends "PK<key>" as the
	patched adbd does and records the answers.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {createAdbAuth, parseRequest, KEY_BYTES} = require('../lib/adbauth');

const quiet = {log() {}, warn() {}, error() {}, info() {}};

// An adb public key as the host sends it: mincrypt's RSAPublicKey (len 64, n0inv, n, rr, e), base64.
function adbKey(seed = 1) {
	const raw = Buffer.alloc(KEY_BYTES);
	raw.writeUInt32LE(64, 0);
	crypto.createHash('sha512').update(String(seed)).digest().copy(raw, 8);
	raw.writeUInt32LE(65537, KEY_BYTES - 4);
	return raw.toString('base64');
}

function fp(b64) {
	return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '');
}

const until = async (check, ms = 2000) => {
	for (let t = 0; t < ms; t += 5) {
		if (check()) {
			return;
		}
		await new Promise(r => setTimeout(r, 5));
	}
	throw new Error('not in time');
};

// A stand-in adbd and the service's side, connected.
async function setup(opts = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmode-adb-'));
	const sock = path.join(dir, 'auth');
	const heard = [];
	let peer = null;
	const server = net.createServer(c => {
		peer = c;
		c.on('data', d => heard.push(d.toString()));
	});
	await new Promise(r => server.listen(sock, r));
	const state = {locked: false, devmode: true, lockWatchers: [], now: 1000000};
	const events = [];
	const adb = createAdbAuth(Object.assign({
		socketPath: sock, keysPath: path.join(dir, 'adbd', 'adb_keys'), log: quiet, reconnectMs: 20,
		locked: async () => state.locked,
		watchLock: fn => {
			state.lockWatchers.push(fn);
			return () => { state.lockWatchers = state.lockWatchers.filter(f => f !== fn); };
		},
		devmodeOn: () => state.devmode,
		now: () => state.now
	}, opts));
	adb.subscribe(ev => events.push(ev));
	adb.start();
	await until(() => peer);
	return {
		dir, adb, heard, events, state, server,
		get peer() { return peer; },
		ask(text) { peer.write(text); },
		async askKey(b64, comment = 'dev@laptop') {
			const n = events.length, h = heard.length;
			peer.write('PK' + b64 + ' ' + comment);
			await until(() => events.length > n || heard.length > h);
		},
		async done() {
			adb.stop();
			await new Promise(r => server.close(r));
			fs.rmSync(dir, {recursive: true, force: true});
		}
	};
}

test('a key adbd sends is read; anything else is not', () => {
	const k = adbKey();
	const r = parseRequest('PK' + k + ' dev@laptop');
	assert.equal(r.b64, k);
	assert.equal(r.comment, 'dev@laptop');
	assert.equal(r.fingerprint, fp(k));
	assert.equal(parseRequest('PK' + k + '\0').comment, 'unknown');
	// The host's comment cannot carry a line of its own into adb_keys.
	assert.equal(parseRequest('PK' + k + ' a b\tc;$(x)').comment, 'a_b_c___x_');
	assert.equal(parseRequest('PK' + k + ' a\nAAAA'), null);
	assert.equal(parseRequest('OK'), null);
	assert.equal(parseRequest('PK'), null);
	assert.equal(parseRequest('PK' + k.slice(0, -8) + ' x'), null);
	// Not a 2048-bit key (len is not 64 words).
	const raw = Buffer.from(k, 'base64');
	raw.writeUInt32LE(32, 0);
	assert.equal(parseRequest('PK' + raw.toString('base64')), null);
	assert.equal(parseRequest('PK' + k + 'x'), null);
	assert.equal(parseRequest(42), null);
});

test('the shell is told the key\'s fingerprint, and "allow" lets the host in once', async () => {
	const t = await setup();
	try {
		const k = adbKey();
		await t.askKey(k);
		assert.equal(t.events.at(-1).request.fingerprint, fp(k));
		assert.ok(t.events.at(-1).request.timeoutMs > 0);
		assert.ok(!JSON.stringify(t.events).includes(k), 'the key itself was handed out');
		assert.deepEqual(await t.adb.respond({fingerprint: fp(k), allow: true, always: false}), {remembered: false});
		await until(() => t.heard.length);
		assert.deepEqual(t.heard, ['OK']);
		assert.deepEqual(t.events.at(-1), {request: null});
		assert.equal(fs.existsSync(path.join(t.dir, 'adbd', 'adb_keys')), false);
	} finally {
		await t.done();
	}
});

test('"always" remembers the key in adb_keys, 0600 in a 0700 directory, once', async () => {
	const t = await setup();
	try {
		const k = adbKey();
		for (let i = 0; i < 2; i++) {
			await t.askKey(k);
			assert.deepEqual(await t.adb.respond({fingerprint: fp(k), allow: true, always: true}), {remembered: true});
		}
		const file = path.join(t.dir, 'adbd', 'adb_keys');
		assert.equal(fs.readFileSync(file, 'latin1'), k + ' dev@laptop\n');
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
		await until(() => t.heard.length === 2);
		assert.deepEqual(t.heard, ['OK', 'OK']);
		await t.adb.revoke();
		assert.equal(fs.existsSync(file), false);
	} finally {
		await t.done();
	}
});

test('while the screen is locked a key is refused without asking', async () => {
	const t = await setup();
	try {
		t.state.locked = true;
		await t.askKey(adbKey());
		assert.deepEqual(t.heard, ['NO']);
		assert.equal(t.events.length, 0);
	} finally {
		await t.done();
	}
});

test('a lock state that cannot be read counts as locked', async () => {
	const t = await setup({locked: async () => { throw new Error('no displaymanager'); }});
	try {
		await t.askKey(adbKey());
		assert.deepEqual(t.heard, ['NO']);
		assert.equal(t.events.length, 0);
	} finally {
		await t.done();
	}
});

test('a question open when the screen locks is refused', async () => {
	const t = await setup();
	try {
		const k = adbKey();
		await t.askKey(k);
		t.state.lockWatchers.forEach(fn => fn(true));
		await until(() => t.heard.length);
		assert.deepEqual(t.heard, ['NO']);
		assert.deepEqual(t.events.at(-1), {request: null});
		assert.equal(t.state.lockWatchers.length, 0, 'the lock is still watched');
		await assert.rejects(t.adb.respond({fingerprint: fp(k), allow: true}), /No such request/);
	} finally {
		await t.done();
	}
});

test('with developer mode off a key is refused without asking', async () => {
	const t = await setup();
	try {
		t.state.devmode = false;
		await t.askKey(adbKey());
		assert.deepEqual(t.heard, ['NO']);
		assert.equal(t.events.length, 0);
	} finally {
		await t.done();
	}
});

test('a key the user refused is refused again, without asking, for a while', async () => {
	const t = await setup({denyQuietMs: 30000});
	try {
		const k = adbKey();
		await t.askKey(k);
		await t.adb.respond({fingerprint: fp(k), allow: false});
		await until(() => t.heard.length === 1);
		const n = t.events.length;
		await t.askKey(k);
		assert.deepEqual(t.heard, ['NO', 'NO']);
		assert.equal(t.events.length, n);
		// Another key is asked about meanwhile.
		await t.askKey(adbKey(2));
		assert.equal(t.events.at(-1).request.fingerprint, fp(adbKey(2)));
		t.adb.stop();
		t.adb.start();
		await until(() => t.adb.connected);
		t.state.now += 30001;
		await t.askKey(k);
		assert.equal(t.events.at(-1).request.fingerprint, fp(k));
	} finally {
		await t.done();
	}
});

test('a question not answered in time is refused', async () => {
	const t = await setup({timeoutMs: 50});
	try {
		const k = adbKey();
		await t.askKey(k);
		await until(() => t.heard.length);
		assert.deepEqual(t.heard, ['NO']);
		assert.deepEqual(t.events.at(-1), {request: null});
		await assert.rejects(t.adb.respond({fingerprint: fp(k), allow: true}), /No such request/);
	} finally {
		await t.done();
	}
});

test('an answer for another key, or with no question open, is refused and changes nothing', async () => {
	const t = await setup();
	try {
		await assert.rejects(t.adb.respond({fingerprint: fp(adbKey()), allow: true}), e => e.errorCode === 'NO_SUCH_REQUEST');
		const k = adbKey();
		await t.askKey(k);
		await assert.rejects(t.adb.respond({fingerprint: fp(adbKey(2)), allow: true}), /No such request/);
		await assert.rejects(t.adb.respond({fingerprint: undefined, allow: true}), /No such request/);
		assert.equal(t.adb.current().request.fingerprint, fp(k));
		assert.deepEqual(t.heard, []);
	} finally {
		await t.done();
	}
});

test('something from adbd that is not a key is answered no', async () => {
	const t = await setup();
	try {
		t.ask('hello');
		await until(() => t.heard.length);
		assert.deepEqual(t.heard, ['NO']);
		assert.equal(t.events.length, 0);
	} finally {
		await t.done();
	}
});

test('a newer key replaces the question open; the same key again does not', async () => {
	const t = await setup();
	try {
		await t.askKey(adbKey(1));
		const n = t.events.length;
		t.ask('PK' + adbKey(1) + ' x');
		await new Promise(r => setTimeout(r, 30));
		assert.equal(t.events.length, n);
		await t.askKey(adbKey(2));
		assert.equal(t.adb.current().request.fingerprint, fp(adbKey(2)));
		await assert.rejects(t.adb.respond({fingerprint: fp(adbKey(1)), allow: true}), /No such request/);
	} finally {
		await t.done();
	}
});

test('when adbd goes, its question goes; the service connects again once it is back', async () => {
	const t = await setup();
	try {
		await t.askKey(adbKey());
		t.peer.destroy();
		await until(() => t.events.at(-1).request === null);
		const old = t.peer;
		await until(() => t.peer !== old);
		await t.askKey(adbKey(3));
		assert.equal(t.adb.current().request.fingerprint, fp(adbKey(3)));
	} finally {
		await t.done();
	}
});

test('USB debugging going off refuses the question open and lets go of adbd', async () => {
	const t = await setup();
	try {
		await t.askKey(adbKey());
		const peer = t.peer;
		const closed = new Promise(r => peer.on('end', r));
		t.adb.stop();
		await closed;
		assert.deepEqual(t.heard, ['NO']);
		assert.equal(t.adb.active, false);
		assert.deepEqual(t.events.at(-1), {request: null});
	} finally {
		await t.done();
	}
});

test('a revoke is logged with how many computers it forgot, and not the keys', async () => {
	const lines = [];
	const log = {log: s => lines.push(s), error: s => lines.push(s), warn() {}, info() {}};
	const t = await setup({log});
	try {
		const k1 = adbKey(1), k2 = adbKey(2);
		for (const k of [k1, k2]) {
			await t.askKey(k);
			await t.adb.respond({fingerprint: fp(k), allow: true, always: true});
		}
		lines.length = 0;
		await t.adb.revoke();
		assert.deepEqual(lines, ['devmode: USB debugging authorisations revoked: 2 remembered computers forgotten']);
		await t.adb.revoke();
		assert.deepEqual(lines.slice(1), ['devmode: USB debugging authorisations revoked: 0 remembered computers forgotten']);
		assert.ok(!lines.join('\n').includes(k1.slice(0, 40)));
	} finally {
		await t.done();
	}
});

test('the key is never logged', async () => {
	const lines = [];
	const log = {log: s => lines.push(s), error: s => lines.push(s), warn() {}, info() {}};
	const t = await setup({log});
	try {
		const k = adbKey();
		await t.askKey(k);
		await t.adb.respond({fingerprint: fp(k), allow: true, always: true});
		assert.ok(lines.length > 0);
		assert.ok(!lines.join('\n').includes(k.slice(0, 40)));
	} finally {
		await t.done();
	}
});
