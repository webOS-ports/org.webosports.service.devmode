// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The methods for the ways in (lib/access.js), the adb key questions as
	the bus has them (service.js), and who may call which: the shell (its
	bus name and its executable) or Settings' Developer Options.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const {boot, NAME} = require('./boot');
const {parsePublicKey} = require('../lib/access');
const {createBus} = require('../lib/bus');
const {createPalmbus} = require('./palmbus');

const SETTINGS = {appId: 'org.webosports.app.settings.devmodeswitcher', service: 'org.webosports.app.settings.devmodeswitcher-1234'};
const SHELL = {service: 'com.webos.surfacemanager-cardshell', exe: '/usr/bin/surface-manager'};
const OTHER_APP = {appId: 'com.example.app', service: 'com.example.app-99'};

let tokens = 0;
/*
	A call from `caller` ({appId, service, exe}); resolves with its first reply, parsed. A
	subscribed one also gets {replies, cancel()}: every reply, and the hub's cancel.
*/
function call(b, method, payload, caller = {}) {
	const h = b.pb.services[NAME];
	const token = String(++tokens);
	const replies = [];
	return new Promise(resolve => {
		const msg = {
			method: () => method,
			category: () => '/',
			payload: () => JSON.stringify(payload || {}),
			uniqueToken: () => token,
			token: () => Number(token),
			applicationID: () => caller.appId || '',
			senderServiceName: () => caller.service || '',
			senderExePath: () => caller.exe || '',
			sender: () => caller.service || '',
			isSubscription: () => !!(payload && payload.subscribe),
			respond: text => {
				replies.push(JSON.parse(text));
				if (replies.length === 1) {
					resolve(Object.defineProperties(replies[0], {
						replies: {value: replies},
						cancel: {value: () => h.emit('cancel', {uniqueToken: () => token})}
					}));
				}
				return true;
			}
		};
		h.emit('request', msg);
	});
}

// OpenSSH public keys, made here.
function sshString(b) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(b.length);
	return Buffer.concat([len, b]);
}
function mpint(b64url) {
	let b = Buffer.from(b64url, 'base64url');
	if (b[0] & 0x80) {
		b = Buffer.concat([Buffer.from([0]), b]);
	}
	return sshString(b);
}
function ed25519Key(comment = 'me@laptop') {
	const {publicKey} = crypto.generateKeyPairSync('ed25519');
	const x = Buffer.from(publicKey.export({format: 'jwk'}).x, 'base64url');
	const blob = Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(x)]);
	return 'ssh-ed25519 ' + blob.toString('base64') + (comment ? ' ' + comment : '');
}
function rsaKey(bits) {
	const {publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: bits});
	const j = publicKey.export({format: 'jwk'});
	const blob = Buffer.concat([sshString(Buffer.from('ssh-rsa')), mpint(j.e), mpint(j.n)]);
	return 'ssh-rsa ' + blob.toString('base64') + ' rsa@laptop';
}
function fingerprint(line) {
	return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(line.split(' ')[1], 'base64'))
		.digest('base64').replace(/=+$/, '');
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

test('only Developer Options may call the access methods', async () => {
	const b = boot();
	try {
		b.setState({dev: true});
		for (const m of ['setDevPassword', 'addAuthorizedKey', 'removeAuthorizedKey', 'listAuthorizedKeys',
			'sshOverWifi', 'revokeAdbKeys', 'getAccessStatus']) {
			for (const who of [OTHER_APP, SHELL, {}]) {
				const r = await call(b, m, {password: 'correct horse', enabled: true}, who);
				assert.equal(r.errorCode, 'PERMISSION_DENIED', m + ' from ' + JSON.stringify(who));
			}
		}
		await b.settle();
		assert.deepEqual(b.exec, []);
	} finally {
		b.done();
	}
});

test('setDevPassword sets root\'s password with chpasswd -c YESCRYPT, on its stdin, never logged', async () => {
	const ran = [];
	const b = boot({onSpawn: (cmd, args, child, input) => {
		ran.push([cmd, args, input]);
		setImmediate(() => child.emit('close', 0));
	}});
	try {
		b.setState({dev: true});
		const r = await call(b, 'setDevPassword', {password: 'correct horse'}, SETTINGS);
		assert.equal(r.returnValue, true);
		assert.deepEqual(ran, [['/usr/sbin/chpasswd', ['-c', 'YESCRYPT'], 'root:correct horse\n']]);
		assert.ok(!b.exec.some(e => e.join(' ').includes('correct horse')), 'the password is in an argument');
	} finally {
		b.done();
	}
});

test('setDevPassword refuses a short password, a line break, and developer mode off', async () => {
	const ran = [];
	const b = boot({onSpawn: (cmd, args, child) => {
		ran.push(cmd);
		setImmediate(() => child.emit('close', 0));
	}});
	try {
		assert.equal((await call(b, 'setDevPassword', {password: 'correct horse'}, SETTINGS)).errorCode, 'DEVMODE_OFF');
		b.setState({dev: true});
		for (const password of ['short', 'correct horse\nroot2:x', 'correct\rhorse', 'a\0bcdefghij', 42, undefined,
			'x'.repeat(513)]) {
			assert.equal((await call(b, 'setDevPassword', {password}, SETTINGS)).errorCode, 'BAD_PASSWORD', String(password));
		}
		assert.deepEqual(ran, []);
	} finally {
		b.done();
	}
});

test('a chpasswd that fails is answered as a failure, without the password', async () => {
	const b = boot({onSpawn: (cmd, args, child) => {
		child.stderr.write('chpasswd: (line 1, user root) password not changed\n');
		setImmediate(() => child.emit('close', 1));
	}});
	try {
		b.setState({dev: true});
		const r = await call(b, 'setDevPassword', {password: 'correct horse'}, SETTINGS);
		assert.equal(r.returnValue, false);
		assert.equal(r.errorCode, 'FAILED');
		assert.ok(!JSON.stringify(r).includes('correct horse'));
	} finally {
		b.done();
	}
});

test('the password is not logged, whatever happens', async () => {
	const lines = [];
	const log = {log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')), warn() {}, info() {}};
	const {start} = require('../service');
	const pb = createPalmbus(async () => ({returnValue: true}));
	const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'devmode-pw-'));
	fs.writeFileSync(dir + '/dev', '');
	const {EventEmitter} = require('events');
	const {PassThrough} = require('stream');
	const spawn = (cmd, args) => {
		const c = new EventEmitter();
		c.stdin = new PassThrough();
		c.stdout = new PassThrough();
		c.stderr = new PassThrough();
		c.stdin.on('finish', () => setImmediate(() => c.emit('close', args[0] === '-c' ? 1 : 0)));
		return c;
	};
	const s = start({palmbus: pb, idleMs: 0, log, exit() {},
		devmode: {devmodeFlag: dir + '/dev', usbFlag: dir + '/usb'},
		access: {spawn, shadow: dir + '/shadow', authorizedKeys: dir + '/ak', sshWifiFlag: dir + '/wifi'},
		adbauth: {socketPath: dir + '/sock'}});
	try {
		for (const password of ['correct horse', 'correct horse\nmore']) {
			await pb.request(NAME, 'setDevPassword', {password}, SETTINGS);
		}
		assert.ok(lines.length > 0);
		assert.ok(!lines.join('\n').includes('correct horse'), lines.join('\n'));
	} finally {
		s.adb.stop();
		s.bus.stop();
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

test('getAccessStatus says whether root has a password, without reading it out', async () => {
	const b = boot();
	try {
		const ask = async () => call(b, 'getAccessStatus', {}, SETTINGS);
		assert.deepEqual((({passwordSet, authorizedKeys, sshOverWifi}) => ({passwordSet, authorizedKeys, sshOverWifi}))(await ask()),
			{passwordSet: false, authorizedKeys: 0, sshOverWifi: false});
		for (const [shadow, set] of [['root::19000:0:99999:7:::\n', false], ['root:!:19000::::::\n', false],
			['root:*:1::::::\n', false], ['daemon:$y$j9T$x:1::::::\nroot:$y$j9T$abc$def:19000::::::\n', true]]) {
			fs.writeFileSync(b.files.shadow, shadow);
			const r = await ask();
			assert.equal(r.passwordSet, set, shadow);
			assert.ok(!JSON.stringify(r).includes('$y$'));
		}
		fs.writeFileSync(b.files.sshWifi, '');
		assert.equal((await ask()).sshOverWifi, true);
	} finally {
		b.done();
	}
});

test('addAuthorizedKey adds an Ed25519 or RSA key to root\'s authorized_keys, 0600 in a 0700 .ssh', async () => {
	const b = boot();
	try {
		b.setState({dev: true});
		const ed = ed25519Key(), rsa = rsaKey(2048);
		let r = await call(b, 'addAuthorizedKey', {key: ed + '\n'}, SETTINGS);
		assert.deepEqual([r.returnValue, r.added, r.fingerprint], [true, true, fingerprint(ed)]);
		r = await call(b, 'addAuthorizedKey', {key: rsa}, SETTINGS);
		assert.equal(r.added, true);
		// Once only.
		r = await call(b, 'addAuthorizedKey', {key: ed.replace('me@laptop', 'other')}, SETTINGS);
		assert.deepEqual([r.returnValue, r.added], [true, false]);
		assert.equal(fs.readFileSync(b.files.authorizedKeys, 'utf8'), ed + '\n' + rsa + '\n');
		assert.equal(fs.statSync(b.files.authorizedKeys).mode & 0o777, 0o600);
		assert.equal(fs.statSync(require('path').dirname(b.files.authorizedKeys)).mode & 0o777, 0o700);
		r = await call(b, 'listAuthorizedKeys', {}, SETTINGS);
		assert.deepEqual(r.keys, [{type: 'ssh-ed25519', fingerprint: fingerprint(ed), comment: 'me@laptop'},
			{type: 'ssh-rsa', fingerprint: fingerprint(rsa), comment: 'rsa@laptop'}]);
		assert.equal((await call(b, 'getAccessStatus', {}, SETTINGS)).authorizedKeys, 2);
	} finally {
		b.done();
	}
});

test('addAuthorizedKey refuses what is not one plain public key', async () => {
	const b = boot();
	try {
		const ed = ed25519Key();
		assert.equal((await call(b, 'addAuthorizedKey', {key: ed}, SETTINGS)).errorCode, 'DEVMODE_OFF');
		b.setState({dev: true});
		const [type, b64] = ed.split(' ');
		const otherType = Buffer.from(b64, 'base64');
		otherType.write('ssh-ed25518', 4);
		for (const key of [
			'command="sh" ' + ed,                         // options
			'from="*" ' + ed,
			ed + '\nssh-ed25519 AAAA evil',              // a second line
			ed.replace(' me@laptop', ' me\rx'),
			ed.replace(' me@laptop', ' me\x1b[2Jx'),          // a terminal escape in the comment
			ed.replace(' me@laptop', ' me\0x'),
			'ssh-dss ' + Buffer.concat([sshString(Buffer.from('ssh-dss')), sshString(Buffer.alloc(128, 1)),
				sshString(Buffer.alloc(20, 1)), sshString(Buffer.alloc(128, 1)), sshString(Buffer.alloc(128, 1))]).toString('base64'),
			type + ' ' + b64.slice(0, -4) + ' x',        // damaged
			type + ' ' + otherType.toString('base64'),   // blob of another type
			'ssh-dss ' + b64,
			rsaKey(1024),                                // too short
			'', 42, undefined, 'x'.repeat(20000)
		]) {
			assert.equal((await call(b, 'addAuthorizedKey', {key}, SETTINGS)).errorCode, 'BAD_KEY', String(key).slice(0, 40));
		}
		assert.equal(fs.existsSync(b.files.authorizedKeys), false);
	} finally {
		b.done();
	}
});

test('removeAuthorizedKey takes away the key with that fingerprint, and keeps lines it cannot read', async () => {
	const b = boot();
	try {
		const ed = ed25519Key(), rsa = rsaKey(2048);
		fs.mkdirSync(require('path').dirname(b.files.authorizedKeys), {recursive: true});
		fs.writeFileSync(b.files.authorizedKeys, ed + '\n# a note\nrestrict ' + rsa + '\n' + rsa + '\n');
		// Developer mode off: taking away is still allowed.
		let r = await call(b, 'removeAuthorizedKey', {fingerprint: fingerprint(rsa)}, SETTINGS);
		assert.equal(r.returnValue, true);
		assert.equal(fs.readFileSync(b.files.authorizedKeys, 'utf8'), ed + '\n# a note\nrestrict ' + rsa + '\n');
		r = await call(b, 'removeAuthorizedKey', {fingerprint: fingerprint(rsa)}, SETTINGS);
		assert.equal(r.errorCode, 'NO_SUCH_KEY');
		r = await call(b, 'removeAuthorizedKey', {fingerprint: 'MD5:aa'}, SETTINGS);
		assert.equal(r.errorCode, 'BAD_ARGS');
	} finally {
		b.done();
	}
});

test('sshOverWifi calls the firewall helper, and needs developer mode to turn on', async () => {
	const ran = [];
	let code = 0;
	const b = boot({onSpawn: (cmd, args, child) => {
		ran.push([cmd].concat(args));
		setImmediate(() => child.emit('close', code));
	}});
	try {
		assert.equal((await call(b, 'sshOverWifi', {enabled: true}, SETTINGS)).errorCode, 'DEVMODE_OFF');
		assert.equal((await call(b, 'sshOverWifi', {enabled: false}, SETTINGS)).returnValue, true);
		b.setState({dev: true});
		assert.deepEqual(await call(b, 'sshOverWifi', {enabled: true}, SETTINGS).then(r => [r.returnValue, r.sshOverWifi]), [true, true]);
		assert.equal((await call(b, 'sshOverWifi', {enabled: 'yes'}, SETTINGS)).errorCode, 'BAD_ARGS');
		code = 1;
		assert.equal((await call(b, 'sshOverWifi', {enabled: true}, SETTINGS)).errorCode, 'FAILED');
		assert.deepEqual(ran, [
			['/usr/sbin/luneos-devmode-firewall', 'ssh-wifi', 'off'],
			['/usr/sbin/luneos-devmode-firewall', 'ssh-wifi', 'on'],
			['/usr/sbin/luneos-devmode-firewall', 'ssh-wifi', 'on']]);
	} finally {
		b.done();
	}
});

test('turning developer mode off turns SSH over Wi-Fi off when it was on', async () => {
	const ran = [];
	const b = boot({onSpawn: (cmd, args, child) => {
		ran.push([cmd].concat(args));
		setImmediate(() => child.emit('close', 0));
	}});
	try {
		b.setState({dev: true});
		await b.ask('setStatus', '{"status":"disabled"}');
		assert.deepEqual(ran, []);
		b.setState({dev: true});
		fs.writeFileSync(b.files.sshWifi, '');
		await b.ask('setStatus', '{"status":"disabled"}');
		assert.deepEqual(ran, [['/usr/sbin/luneos-devmode-firewall', 'ssh-wifi', 'off']]);
		await b.settle();
	} finally {
		b.done();
	}
});

test('the adb key questions are the shell\'s alone: its name and its executable', async () => {
	const b = boot();
	try {
		for (const who of [SETTINGS, OTHER_APP, {service: SHELL.service, exe: '/usr/bin/luna-send'},
			{service: SHELL.service}, {service: 'com.webos.surfacemanagerx', exe: '/usr/bin/luna-send'},
			{service: 'org.example', exe: SHELL.exe}]) {
			for (const m of ['adbAuthRequests', 'respondAdbAuth']) {
				const r = await call(b, m, {subscribe: true, fingerprint: 'x', allow: true}, who);
				assert.equal(r.errorCode, 'PERMISSION_DENIED', m + ' from ' + JSON.stringify(who));
			}
		}
	} finally {
		b.done();
	}
});

test('USB debugging connects to adbd; the shell is told of its questions and answers them', async () => {
	const b = boot();
	const heard = [];
	let peer = null;
	const server = net.createServer(c => {
		peer = c;
		c.on('data', d => heard.push(d.toString()));
	});
	await new Promise(r => server.listen(b.files.socket, r));
	try {
		// Not before USB debugging is on.
		await new Promise(r => setTimeout(r, 50));
		assert.equal(peer, null);
		b.setState({dev: true});
		await b.ask('setStatus', '{"usbDebugging":"enabled"}');
		await until(() => peer);
		assert.equal(b.service.adb.active, true);

		const sub = await call(b, 'adbAuthRequests', {subscribe: true}, SHELL);
		assert.deepEqual([sub.returnValue, sub.subscribed, sub.request], [true, true, null]);

		// The display says unlocked (the stand-in bus answers every call {returnValue:true}, so say so).
		const display = createPalmbus(async u => (u.endsWith('/lockStatus') ?
			{returnValue: true, lockState: 'unlocked'} : {returnValue: true}));
		b.pb.services[NAME].call = function (uri, payload) {
			return display.Handle.prototype.call.call(this, uri, payload);
		};
		b.pb.services[NAME].subscribe = b.pb.services[NAME].call;
		const raw = Buffer.alloc(524);
		raw.writeUInt32LE(64, 0);
		raw.fill(7, 8, 200);
		const key = raw.toString('base64');
		peer.write('PK' + key + ' dev@laptop');
		await until(() => sub.replies.length > 1);
		const fp = sub.replies.at(-1).request.fingerprint;
		assert.match(fp, /^SHA256:/);

		const r = await call(b, 'respondAdbAuth', {fingerprint: fp, allow: true, always: true}, SHELL);
		assert.deepEqual([r.returnValue, r.remembered], [true, true]);
		await until(() => heard.length);
		assert.deepEqual(heard, ['OK']);
		assert.equal(fs.readFileSync(b.files.adbKeys, 'latin1'), key + ' dev@laptop\n');
		await until(() => sub.replies.at(-1).request === null);
		assert.equal((await call(b, 'respondAdbAuth', {fingerprint: fp, allow: true}, SHELL)).errorCode, 'NO_SUCH_REQUEST');
		assert.equal((await call(b, 'respondAdbAuth', {fingerprint: fp, allow: 'yes'}, SHELL)).errorCode, 'BAD_ARGS');

		// The shell cancels: no more replies to it.
		sub.cancel();
		const n = sub.replies.length;
		peer.write('PK' + key.replace('B', 'C') + ' x');
		await new Promise(r => setTimeout(r, 50));
		assert.equal(sub.replies.length, n);

		// Revoked from Settings.
		assert.equal((await call(b, 'revokeAdbKeys', {}, SETTINGS)).returnValue, true);
		assert.equal(fs.existsSync(b.files.adbKeys), false);

		await b.ask('setStatus', '{"usbDebugging":"disabled"}');
		assert.equal(b.service.adb.active, false);
		await b.settle();
	} finally {
		b.done();
		await new Promise(r => server.close(r));
	}
});

test('the service stays while USB debugging is on, and leaves when idle otherwise', async () => {
	for (const keep of [true, false]) {
		let exited = false;
		const pb = createPalmbus(async () => ({returnValue: true}));
		const bus = createBus({palmbus: pb, name: 'x.test', idleMs: 20, log: {log() {}, error() {}},
			exit: () => { exited = true; }, keepAlive: () => keep});
		bus.serve({});
		await new Promise(r => setTimeout(r, 120));
		assert.equal(exited, !keep);
		bus.stop();
	}
});

test('a key line is read as OpenSSH writes it', () => {
	const ed = ed25519Key('a comment with spaces');
	const k = parsePublicKey(ed);
	assert.equal(k.comment, 'a comment with spaces');
	assert.equal(parsePublicKey(ed.replace(/ /g, '\t')).type, 'ssh-ed25519');
	assert.equal(parsePublicKey(ed25519Key('')).comment, '');
});
