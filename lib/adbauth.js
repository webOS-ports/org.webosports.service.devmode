// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	USB debugging's key authorisation: what Android's UsbDebuggingManager does
	for adbd, here for the shell.

	adbd (meta-luneos' android-tools patch) asks for every host whose key is
	not in /var/lib/adbd/adb_keys yet: on its socket, /run/adbd/auth (root's
	only), it sends "PK<base64 key> <user@host>", and takes "OK" (let it in)
	or "NO". This connects to that socket while USB debugging is on, and
	hands each question to the shell, which subscribes to adbAuthRequests and
	answers with respondAdbAuth once the user has.

	Refused without asking the user:
	- while the screen is locked (luna-displaymanager's lockStatus; one that
	  cannot be read counts as locked), and a question open when the screen
	  locks is refused then;
	- while developer mode is off;
	- a key that is not a 2048-bit adb RSA key;
	- for DENY_QUIET_MS after the user said no to the same key, so a host
	  cannot keep putting the question.
	A question not answered within TIMEOUT_MS is refused.

	Keys are told by their fingerprint, SHA256:<base64 of the SHA-256 of the
	decoded key> as ssh-keygen -l prints one; on the computer:
	  awk '{print $1}' ~/.android/adbkey.pub | base64 -d | openssl dgst -sha256 -binary | base64
	The key itself is never logged.
*/

const crypto = require('crypto');
const path = require('path');

const SOCKET = '/run/adbd/auth';
const KEYS = '/var/lib/adbd/adb_keys';
const TIMEOUT_MS = 60000;
const DENY_QUIET_MS = 30000;
const RECONNECT_MS = 2000;
// mincrypt's RSAPublicKey for a 2048-bit key: len, n0inv, n[64], rr[64], exponent.
const RSANUMWORDS = 64;
const KEY_BYTES = 4 + 4 + RSANUMWORDS * 4 * 2 + 4;
// adbd's MAX_PAYLOAD, and the "PK" before it.
const MAX_MESSAGE = 4096 + 2;

// "PK<base64> <comment>" -> {b64, comment, fingerprint}, or null for anything else.
function parseRequest(text) {
	if (typeof text !== 'string' || text.length > MAX_MESSAGE || !text.startsWith('PK')) {
		return null;
	}
	const body = text.slice(2).replace(/\0+$/, '');
	const m = /^([A-Za-z0-9+/]+={0,2})(?:[ \t]+([^\0\r\n]*))?$/.exec(body);
	if (!m) {
		return null;
	}
	const raw = Buffer.from(m[1], 'base64');
	if (raw.length !== KEY_BYTES || raw.toString('base64') !== m[1] || raw.readUInt32LE(0) !== RSANUMWORDS) {
		return null;
	}
	return {b64: m[1], comment: cleanComment(m[2] || ''), fingerprint: fingerprint(raw)};
}

// ssh-keygen -l's form.
function fingerprint(raw) {
	return 'SHA256:' + crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
}

// The host's "user@host", kept in adb_keys next to the key; nothing that could end its line.
function cleanComment(c) {
	const s = String(c).replace(/[^A-Za-z0-9@._+-]/g, '_').slice(0, 64);
	return s || 'unknown';
}

/*
	fs and net are passed in, with the paths, for the tests. locked() -> a
	promise of true unless the screen is known to be unlocked; watchLock(fn)
	calls fn(locked) when that changes and returns what stops it.
	devmodeOn() says whether developer mode is on.
*/
function createAdbAuth({fs = require('fs'), net = require('net'), socketPath = SOCKET, keysPath = KEYS,
	locked = async () => true, watchLock = () => () => {}, devmodeOn = () => false, log = console,
	timeoutMs = TIMEOUT_MS, denyQuietMs = DENY_QUIET_MS, reconnectMs = RECONNECT_MS,
	now = () => Date.now()} = {}) {

	let wanted = false;
	let sock = null;
	let retry = null;
	let pending = null;           // {b64, comment, fingerprint, expires, timer, stopWatch}
	let seq = 0;                  // the question being looked at; a newer one supersedes it
	const refused = new Map();    // fingerprint -> until
	const listeners = new Set();

	function emit() {
		const ev = current();
		for (const fn of listeners) {
			try {
				fn(ev);
			} catch (e) {
				log.error('devmode: adbAuthRequests listener: ' + e.message);
			}
		}
	}

	// What a subscriber is told: the question open, or null.
	function current() {
		if (!pending) {
			return {request: null};
		}
		return {request: {fingerprint: pending.fingerprint, timeoutMs: Math.max(0, pending.expires - now())}};
	}

	function answer(word) {
		if (sock && !sock.destroyed) {
			sock.write(word);
		}
	}

	function close(word, why) {
		if (!pending) {
			return;
		}
		const p = pending;
		pending = null;
		clearTimeout(p.timer);
		p.stopWatch();
		log.log('devmode: adb key ' + p.fingerprint + ' ' + (word === 'OK' ? 'allowed' : 'refused') + ' (' + why + ')');
		if (word) {
			answer(word);
		}
		emit();
	}

	async function onMessage(text) {
		const req = parseRequest(text);
		const mine = ++seq;
		if (!req) {
			log.error('devmode: adbd sent something that is not a key; refused');
			answer('NO');
			return;
		}
		// A newer question replaces one still open: adbd asks for one host at a time.
		if (pending && pending.fingerprint === req.fingerprint) {
			return;
		}
		close(null, 'superseded');
		const until = refused.get(req.fingerprint);
		if (until !== undefined && until > now()) {
			log.log('devmode: adb key ' + req.fingerprint + ' refused again (refused ' +
				Math.round((until - now()) / 1000) + ' s ago or less)');
			answer('NO');
			return;
		}
		refused.delete(req.fingerprint);
		if (!devmodeOn()) {
			log.log('devmode: adb key ' + req.fingerprint + ' refused: developer mode is off');
			answer('NO');
			return;
		}
		let isLocked = true;
		try {
			isLocked = await locked();
		} catch (e) {
			isLocked = true;
		}
		if (mine !== seq) {
			return;
		}
		if (isLocked !== false) {
			log.log('devmode: adb key ' + req.fingerprint + ' refused: the screen is locked');
			answer('NO');
			return;
		}
		pending = Object.assign(req, {expires: now() + timeoutMs, stopWatch: () => {}});
		pending.timer = setTimeout(() => close('NO', 'not answered in time'), timeoutMs);
		const p = pending;
		const stop = watchLock(isNowLocked => {
			if (isNowLocked && pending === p) {
				close('NO', 'the screen locked');
			}
		});
		if (pending === p) {
			p.stopWatch = stop;
		} else {
			stop();
		}
		log.log('devmode: adb key ' + req.fingerprint + ' asks to be allowed');
		emit();
	}

	function connect() {
		retry = null;
		if (!wanted || sock) {
			return;
		}
		const s = net.createConnection(socketPath);
		sock = s;
		s.on('connect', () => log.log('devmode: connected to adbd'));
		s.on('data', buf => {
			if (sock === s) {
				onMessage(buf.toString('latin1'));
			}
		});
		s.on('error', () => {});
		s.on('close', () => {
			if (sock !== s) {
				return;
			}
			sock = null;
			// adbd went (or is not up yet): its question went with it.
			close(null, 'adbd went away');
			if (wanted && !retry) {
				retry = setTimeout(connect, reconnectMs);
			}
		});
	}

	// While USB debugging is on: adbd may come and go, and is connected to whenever it is up.
	function start() {
		wanted = true;
		connect();
	}

	function stop() {
		wanted = false;
		if (retry) {
			clearTimeout(retry);
			retry = null;
		}
		close(sock ? 'NO' : null, 'USB debugging turned off');
		if (sock) {
			const s = sock;
			sock = null;
			s.destroy();
		}
	}

	/*
		The user's answer. allow: let the host in; always: and remember its
		key, so it is not asked again. Throws for a question that is not the
		one open (answered already, timed out, or another key).
	*/
	async function respond({fingerprint: fp, allow, always}) {
		if (!pending || typeof fp !== 'string' || fp !== pending.fingerprint) {
			const e = new Error('No such request');
			e.errorCode = 'NO_SUCH_REQUEST';
			throw e;
		}
		const p = pending;
		if (!allow) {
			refused.set(p.fingerprint, now() + denyQuietMs);
			close('NO', 'the user said no');
			return {remembered: false};
		}
		let remembered = false;
		if (always) {
			try {
				await remember(p);
				remembered = true;
			} catch (e) {
				log.error('devmode: could not remember adb key ' + p.fingerprint + ': ' + e.message);
			}
		}
		// Still the question open: it may have timed out, or adbd gone, while the file was written.
		if (pending !== p) {
			const e = new Error('No such request');
			e.errorCode = 'NO_SUCH_REQUEST';
			throw e;
		}
		close('OK', always ? 'always' : 'this once');
		return {remembered};
	}

	// adb_keys gets the key unless it has it: written whole beside it, then renamed over it.
	async function remember(p) {
		const dir = path.dirname(keysPath);
		await fs.promises.mkdir(dir, {recursive: true, mode: 0o700});
		await fs.promises.chmod(dir, 0o700);
		let old = '';
		try {
			old = await fs.promises.readFile(keysPath, 'latin1');
		} catch (e) {
			if (e.code !== 'ENOENT') {
				throw e;
			}
		}
		const lines = old.split('\n').filter(l => l.trim() !== '');
		if (lines.some(l => l.split(/[ \t]/)[0] === p.b64)) {
			return;
		}
		lines.push(p.b64 + ' ' + p.comment);
		await writeAtomic(keysPath, lines.join('\n') + '\n');
	}

	async function writeAtomic(file, text) {
		const tmp = file + '.new-' + process.pid;
		const fh = await fs.promises.open(tmp, 'w', 0o600);
		try {
			await fh.writeFile(text, 'latin1');
			await fh.chmod(0o600);
			await fh.sync();
		} finally {
			await fh.close();
		}
		await fs.promises.rename(tmp, file);
	}

	/*
		Settings' "Revoke USB debugging authorisations": every remembered key
		goes. Logged, with how many, so a revoke can be told from adb_keys
		never having been written; the keys themselves are not.
	*/
	async function revoke() {
		let count = 0;
		try {
			count = (await fs.promises.readFile(keysPath, 'latin1')).split('\n').filter(l => l.trim() !== '').length;
			await fs.promises.unlink(keysPath);
		} catch (e) {
			if (e.code !== 'ENOENT') {
				log.error('devmode: could not revoke USB debugging authorisations: ' + e.code);
				throw e;
			}
		}
		log.log('devmode: USB debugging authorisations revoked: ' + count + ' remembered ' +
			(count === 1 ? 'computer' : 'computers') + ' forgotten');
	}

	return {
		start, stop, respond, revoke, current,
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		get active() {
			return wanted;
		},
		get connected() {
			return !!sock && !sock.connecting;
		},
		// tests
		_onMessage: onMessage
	};
}

module.exports = {createAdbAuth, parseRequest, fingerprint, cleanComment, SOCKET, KEYS, TIMEOUT_MS,
	DENY_QUIET_MS, KEY_BYTES};
