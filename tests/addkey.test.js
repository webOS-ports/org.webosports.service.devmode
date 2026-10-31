// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	bin/luneos-ssh-addkey: one key on stdin, through lib/access.js, as
	Settings adds one.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {addKey, MAX_INPUT} = require('../bin/luneos-ssh-addkey');
const {createAccess} = require('../lib/access');
const {DEVMODE_FLAG} = require('../lib/devmode');

const SCRIPT = path.join(__dirname, '..', 'bin', 'luneos-ssh-addkey');

function sshString(b) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(b.length);
	return Buffer.concat([len, b]);
}

function ed25519Key(comment = 'me@laptop') {
	const {publicKey} = crypto.generateKeyPairSync('ed25519');
	const x = Buffer.from(publicKey.export({format: 'jwk'}).x, 'base64url');
	return 'ssh-ed25519 ' + Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(x)]).toString('base64') + ' ' + comment;
}

function fingerprint(line) {
	return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(line.split(' ')[1], 'base64')).digest('base64').replace(/=+$/, '');
}

function setup({devmode = true} = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmode-addkey-'));
	const home = path.join(dir, 'root');
	fs.mkdirSync(home, {mode: 0o700});
	fs.mkdirSync(path.join(dir, 'home', 'root'), {recursive: true});
	const lines = [];
	const access = createAccess({
		log: {log: m => lines.push(m), error: m => lines.push(m), warn() {}, info() {}},
		devmodeOn: () => devmode, ownerUid: process.getuid(),
		userInfo: () => ({uid: 0, username: 'root', homedir: home})
	});
	return {dir, home, access, lines, ak: path.join(home, '.ssh', 'authorized_keys'),
		done() { fs.rmSync(dir, {recursive: true, force: true}); }};
}

test('a key on stdin is added to root\'s authorized_keys, and its fingerprint printed', async () => {
	const t = setup();
	try {
		const k = ed25519Key();
		let r = await addKey(k + '\n', t.access);
		assert.deepEqual(r, {code: 0, out: 'added ' + fingerprint(k) + '\n', err: ''});
		assert.equal(fs.readFileSync(t.ak, 'utf8'), k + '\n');
		assert.equal(fs.statSync(t.ak).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.dirname(t.ak)).mode & 0o777, 0o700);
		assert.deepEqual(fs.readdirSync(path.join(t.dir, 'home', 'root')), []);
		// Once.
		r = await addKey(k.replace('me@laptop', 'other') + '\r\n', t.access);
		assert.deepEqual(r, {code: 0, out: 'already there: ' + fingerprint(k) + '\n', err: ''});
		assert.equal(fs.readFileSync(t.ak, 'utf8'), k + '\n');
	} finally {
		t.done();
	}
});

test('anything but one public key line is refused, and nothing is written', async () => {
	const t = setup();
	try {
		const k = ed25519Key();
		for (const text of [k + '\n' + ed25519Key('two') + '\n', 'command="sh" ' + k, 'from="*" ' + k,
			'-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
			k.replace('me@laptop', 'me\x1b[2J'), 'ssh-ed25519 AAAA x']) {
			const r = await addKey(text, t.access);
			assert.equal(r.code, 1, JSON.stringify(text.slice(0, 40)));
			assert.equal(r.out, '');
			assert.match(r.err, /^luneos-ssh-addkey: /);
		}
		// Not read on into memory: a key with a comment past MAX_INPUT is not one line someone pasted.
		const long = await addKey(k + 'x'.repeat(MAX_INPUT), t.access);
		assert.deepEqual([long.code, long.err], [1, 'luneos-ssh-addkey: that is not one public key line (too long)\n']);
		for (const text of ['', '\n', '   ', undefined]) {
			assert.equal((await addKey(text, t.access)).code, 2);
		}
		assert.equal(fs.existsSync(t.ak), false);
	} finally {
		t.done();
	}
});

test('it needs developer mode, as Settings does', async () => {
	const t = setup({devmode: false});
	try {
		const r = await addKey(ed25519Key(), t.access);
		assert.equal(r.code, 1);
		assert.match(r.err, /developer mode/i);
		assert.equal(fs.existsSync(t.ak), false);
	} finally {
		t.done();
	}
});

test('the script reads stdin and answers with its exit status', () => {
	// Not root here: it must fail closed on root's home, not write anywhere.
	const k = ed25519Key();
	let r = spawnSync(process.execPath, [SCRIPT], {input: k + '\n', encoding: 'utf8'});
	if (process.getuid() !== 0) {
		assert.equal(r.status, 1, r.stderr);
		// Developer mode is asked first, from its flag, as Settings asks it.
		assert.match(r.stderr, fs.existsSync(DEVMODE_FLAG) ? /luneos-ssh-addkey: Root's home directory could not be found/ :
			/^luneos-ssh-addkey: Turn developer mode on first\n$/);
	}
	r = spawnSync(process.execPath, [SCRIPT], {input: '', encoding: 'utf8'});
	assert.equal(r.status, 2);
	assert.match(r.stderr, /^usage: luneos-ssh-addkey/);
	assert.equal(fs.statSync(SCRIPT).mode & 0o111, 0o111);
	assert.match(fs.readFileSync(SCRIPT, 'utf8'), /^#!\/usr\/bin\/env node\n/);
});
