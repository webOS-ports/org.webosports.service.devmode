// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The ways into a device in developer mode besides adb: root's password and
	its ssh keys, and whether sshd may be reached beyond the USB gadget.

	Images no longer ship a root without a password (audit C1), and sshd
	lets root in with a key only (PermitRootLogin prohibit-password, from
	meta-webos-ports). So for ssh the Developer Options page either adds a
	key to /home/root/.ssh/authorized_keys, or sets a root password, which
	is what serial and local logins take.

	- setDevPassword: chpasswd -c YESCRYPT, the password on its stdin. It is
	  never logged, nor put in an argument (visible in /proc).
	- addAuthorizedKey / removeAuthorizedKey / listAuthorizedKeys: one
	  OpenSSH public key a line, with no options; a key is told by its
	  fingerprint, as ssh-keygen -l prints it.
	- sshOverWifi: meta-webos-ports' /usr/sbin/luneos-devmode-firewall
	  ssh-wifi on|off, which also keeps the choice
	  (/var/luna/ssh-wifi-enabled, read here, written only by it).

	Adding anything needs developer mode on; taking away does not.
*/

const crypto = require('crypto');
const path = require('path');

const AUTHORIZED_KEYS = '/home/root/.ssh/authorized_keys';
const SHADOW = '/etc/shadow';
const CHPASSWD = '/usr/sbin/chpasswd';
const FIREWALL = '/usr/sbin/luneos-devmode-firewall';
const SSH_WIFI_FLAG = '/var/luna/ssh-wifi-enabled';

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 512;
const MAX_KEY_LINE = 16384;
const MIN_RSA_BITS = 2048;

// The key types sshd takes, and for the ECDSA ones their curve.
const KEY_TYPES = {
	'ssh-ed25519': null,
	'ssh-rsa': null,
	'ecdsa-sha2-nistp256': 'nistp256',
	'ecdsa-sha2-nistp384': 'nistp384',
	'ecdsa-sha2-nistp521': 'nistp521',
	'sk-ssh-ed25519@openssh.com': null,
	'sk-ecdsa-sha2-nistp256@openssh.com': 'nistp256'
};

class AccessError extends Error {
	constructor(code, text) {
		super(text);
		this.errorCode = code;
		this.errorText = text;
	}
}

// The SSH wire format's strings: length-prefixed, big-endian.
function readStrings(buf) {
	const out = [];
	let off = 0;
	while (off < buf.length) {
		if (off + 4 > buf.length) {
			return null;
		}
		const n = buf.readUInt32BE(off);
		off += 4;
		if (n > buf.length - off) {
			return null;
		}
		out.push(buf.subarray(off, off + n));
		off += n;
	}
	return out;
}

// An mpint's size in bits (a leading zero byte keeps it positive).
function mpintBits(b) {
	let i = 0;
	while (i < b.length && b[i] === 0) {
		i++;
	}
	if (i === b.length) {
		return 0;
	}
	return (b.length - i - 1) * 8 + (32 - Math.clz32(b[i]));
}

function sshFingerprint(blob) {
	return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/*
	One public key line -> {type, b64, comment, fingerprint}, or throws. Only
	"type base64 [comment]": options (from=, command=...) are refused, since
	none of them would make a key added from Settings safer, and some make
	it something else.
*/
function parsePublicKey(line) {
	if (typeof line !== 'string' || line.length === 0 || line.length > MAX_KEY_LINE) {
		throw new AccessError('BAD_KEY', 'The key must be one OpenSSH public key line');
	}
	const text = line.trim();
	// Nothing that could end the line or hide in it.
	if (/[\0-\x1f\x7f]/.test(text.replace(/\t/g, ' '))) {
		throw new AccessError('BAD_KEY', 'The key must be one line of printable text');
	}
	const m = /^(\S+) +([A-Za-z0-9+/]+={0,2})(?: +(.*))?$/.exec(text.replace(/\t/g, ' '));
	if (!m || !Object.prototype.hasOwnProperty.call(KEY_TYPES, m[1])) {
		throw new AccessError('BAD_KEY', 'Not an OpenSSH public key (ssh-ed25519, ecdsa-sha2-*, ssh-rsa or sk-*), or it has options');
	}
	const [, type, b64] = m;
	const blob = Buffer.from(b64, 'base64');
	if (blob.toString('base64') !== b64) {
		throw new AccessError('BAD_KEY', 'The key\'s base64 is damaged');
	}
	const parts = readStrings(blob);
	if (!parts || parts.length < 2 || parts[0].toString('latin1') !== type) {
		throw new AccessError('BAD_KEY', 'The key\'s data does not match its type');
	}
	if (type === 'ssh-rsa') {
		if (parts.length !== 3 || mpintBits(parts[2]) < MIN_RSA_BITS) {
			throw new AccessError('BAD_KEY', 'RSA keys must be at least ' + MIN_RSA_BITS + ' bits');
		}
	} else if (type === 'ssh-ed25519') {
		if (parts.length !== 2 || parts[1].length !== 32) {
			throw new AccessError('BAD_KEY', 'The Ed25519 key is damaged');
		}
	} else if (KEY_TYPES[type]) {
		if (parts.length < 3 || parts[1].toString('latin1') !== KEY_TYPES[type]) {
			throw new AccessError('BAD_KEY', 'The ECDSA key\'s curve does not match its type');
		}
	}
	const comment = (m[3] || '').slice(0, 256);
	return {type, b64, comment, fingerprint: sshFingerprint(blob)};
}

function createAccess({fs = require('fs'), spawn = require('child_process').spawn, log = console,
	authorizedKeys = AUTHORIZED_KEYS, shadow = SHADOW, chpasswd = CHPASSWD, firewall = FIREWALL,
	sshWifiFlag = SSH_WIFI_FLAG, devmodeOn = () => false} = {}) {

	// A command run to its end -> its exit code (-1 when it could not be started). input goes to its
	// stdin and is never logged; stdout is kept for the caller, stderr is logged.
	function run(cmd, args, input) {
		return new Promise(resolve => {
			let child;
			try {
				child = spawn(cmd, args, {stdio: ['pipe', 'pipe', 'pipe']});
			} catch (e) {
				log.error('devmode: ' + cmd + ': ' + e.message);
				resolve({code: -1, out: ''});
				return;
			}
			let out = '', err = '', done = false;
			const finish = code => {
				if (done) {
					return;
				}
				done = true;
				if (err.trim()) {
					log.error('devmode: ' + cmd + ': ' + err.trim().slice(0, 300));
				}
				resolve({code, out});
			};
			child.on('error', e => {
				log.error('devmode: ' + cmd + ': ' + e.message);
				finish(-1);
			});
			if (child.stdout) {
				child.stdout.on('data', d => { out += d; });
			}
			if (child.stderr) {
				child.stderr.on('data', d => { err += d; });
			}
			child.on('close', code => finish(code === null ? -1 : code));
			if (child.stdin) {
				child.stdin.on('error', () => {});
				child.stdin.end(input === undefined ? '' : input);
			}
		});
	}

	function needDevmode() {
		if (!devmodeOn()) {
			throw new AccessError('DEVMODE_OFF', 'Turn developer mode on first');
		}
	}

	async function setDevPassword(args) {
		needDevmode();
		const pw = args && args.password;
		if (typeof pw !== 'string' || pw.length < MIN_PASSWORD || pw.length > MAX_PASSWORD) {
			throw new AccessError('BAD_PASSWORD', 'The password must be ' + MIN_PASSWORD + ' to ' + MAX_PASSWORD + ' characters');
		}
		// chpasswd reads "user:password" lines: a line break would start another.
		if (/[\0\r\n]/.test(pw)) {
			throw new AccessError('BAD_PASSWORD', 'The password must not contain line breaks');
		}
		const {code} = await run(chpasswd, ['-c', 'YESCRYPT'], 'root:' + pw + '\n');
		if (code !== 0) {
			throw new AccessError('FAILED', 'The password could not be set');
		}
		log.log('devmode: root\'s password was set');
		return {};
	}

	// Whether root has a password one can log in with (not empty, not locked). The hash is not read out.
	async function passwordSet() {
		let text;
		try {
			text = await fs.promises.readFile(shadow, 'utf8');
		} catch (e) {
			return false;
		}
		for (const line of text.split('\n')) {
			const f = line.split(':');
			if (f[0] === 'root') {
				return f.length > 1 && f[1] !== '' && !f[1].startsWith('!') && !f[1].startsWith('*');
			}
		}
		return false;
	}

	async function readKeys() {
		try {
			return await fs.promises.readFile(authorizedKeys, 'utf8');
		} catch (e) {
			if (e.code === 'ENOENT') {
				return '';
			}
			throw e;
		}
	}

	// authorized_keys written whole beside itself (0600, in a 0700 .ssh) and renamed over the old one.
	async function writeKeys(lines) {
		const dir = path.dirname(authorizedKeys);
		await fs.promises.mkdir(dir, {recursive: true, mode: 0o700});
		await fs.promises.chmod(dir, 0o700);
		const tmp = authorizedKeys + '.new-' + process.pid;
		const fh = await fs.promises.open(tmp, 'w', 0o600);
		try {
			await fh.writeFile(lines.length ? lines.join('\n') + '\n' : '');
			await fh.chmod(0o600);
			await fh.sync();
		} finally {
			await fh.close();
		}
		await fs.promises.rename(tmp, authorizedKeys);
	}

	// The key in a line of authorized_keys, or null for one this cannot read (it is kept as it is).
	function lineKey(line) {
		try {
			return parsePublicKey(line);
		} catch (e) {
			return null;
		}
	}

	async function listAuthorizedKeys() {
		const keys = [];
		for (const line of (await readKeys()).split('\n')) {
			const k = line.trim() ? lineKey(line) : null;
			if (k) {
				keys.push({type: k.type, fingerprint: k.fingerprint, comment: k.comment});
			}
		}
		return {keys};
	}

	async function addAuthorizedKey(args) {
		needDevmode();
		const k = parsePublicKey(args && args.key);
		const lines = (await readKeys()).split('\n').filter(l => l.trim() !== '');
		if (lines.some(l => {
			const o = lineKey(l);
			return o && o.fingerprint === k.fingerprint;
		})) {
			return {fingerprint: k.fingerprint, added: false};
		}
		lines.push(k.type + ' ' + k.b64 + (k.comment ? ' ' + k.comment : ''));
		await writeKeys(lines);
		log.log('devmode: ssh key ' + k.fingerprint + ' added for root');
		return {fingerprint: k.fingerprint, added: true};
	}

	async function removeAuthorizedKey(args) {
		const fp = args && args.fingerprint;
		if (typeof fp !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fp)) {
			throw new AccessError('BAD_ARGS', 'fingerprint must be a SHA256: fingerprint');
		}
		const lines = (await readKeys()).split('\n').filter(l => l.trim() !== '');
		const kept = lines.filter(l => {
			const o = lineKey(l);
			return !(o && o.fingerprint === fp);
		});
		if (kept.length === lines.length) {
			throw new AccessError('NO_SUCH_KEY', 'No such key');
		}
		await writeKeys(kept);
		log.log('devmode: ssh key ' + fp + ' removed for root');
		return {};
	}

	function sshOverWifiOn() {
		try {
			fs.accessSync(sshWifiFlag);
			return true;
		} catch (e) {
			return false;
		}
	}

	async function sshOverWifi(args) {
		const on = args && args.enabled;
		if (typeof on !== 'boolean') {
			throw new AccessError('BAD_ARGS', 'enabled must be true or false');
		}
		if (on) {
			needDevmode();
		}
		const {code} = await run(firewall, ['ssh-wifi', on ? 'on' : 'off']);
		if (code !== 0) {
			throw new AccessError('FAILED', 'The firewall could not be changed');
		}
		return {sshOverWifi: on};
	}

	// Developer mode going off: SSH over Wi-Fi goes with it (and is asked for again next time).
	async function devmodeOff() {
		if (sshOverWifiOn()) {
			await run(firewall, ['ssh-wifi', 'off']);
		}
	}

	return {setDevPassword, passwordSet, listAuthorizedKeys, addAuthorizedKey, removeAuthorizedKey,
		sshOverWifi, sshOverWifiOn, devmodeOff};
}

module.exports = {createAccess, parsePublicKey, sshFingerprint, AccessError, AUTHORIZED_KEYS, SHADOW,
	CHPASSWD, FIREWALL, SSH_WIFI_FLAG, MIN_PASSWORD};
