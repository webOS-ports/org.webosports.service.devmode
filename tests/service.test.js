// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	What the VM cases (stock.test.js) cannot send: payloads luna-send will
	not, an $activity, and the start-up.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const {boot} = require('./boot');

test('a payload that is not JSON fails before the command runs, as mojoservice failed it', async () => {
	const b = boot();
	try {
		b.setState({dev: true, usb: false});
		const text = await b.send('setStatus', '{"status":"disabled"');
		assert.equal(text, '{"returnValue":false,"errorCode":-9999,"errorText":"MojoService: no errorCode supplied "}');
		await b.settle();
		assert.deepEqual(b.exec, []);
		assert.deepEqual(b.state(), {dev: true, usb: false});
	} finally {
		b.done();
	}
});

test('null, false, 0 and "" are taken as {}', async () => {
	const b = boot();
	try {
		for (const p of ['null', 'false', '0', '""']) {
			assert.equal(await b.send('setStatus', p), '{"returnValue":true,"errorText":"","errorCode":0}', p);
			assert.equal(await b.send('getStatus', p),
				'{"returnValue":true,"status":"disabled","usbDebugging":"disabled"}', p);
		}
	} finally {
		b.done();
	}
});

test('an $activity an app passes is monitored, as mojoservice did', async () => {
	const b = boot();
	const calls = [];
	const call = b.pb.Handle.prototype.call;
	b.pb.Handle.prototype.subscribe = function (uri, payload) {
		calls.push([uri, JSON.parse(payload)]);
		return call.call(this, uri, payload);
	};
	try {
		const r = await b.ask('getStatus', '{"$activity":{"activityId":42}}');
		assert.equal(r.returnValue, true);
		assert.deepEqual(calls, [['luna://com.palm.activitymanager/monitor', {activityId: 42, subscribe: true}]]);
	} finally {
		b.pb.Handle.prototype.subscribe = call;
		b.done();
	}
});

test('it registers its methods and the bus\'s quit and info', () => {
	const b = boot();
	try {
		assert.deepEqual(b.pb.services['org.webosports.service.devmode'].methods.sort(),
			['/adbAuthRequests', '/addAuthorizedKey', '/getAccessStatus', '/getStatus', '/info',
				'/listAuthorizedKeys', '/quit', '/removeAuthorizedKey', '/respondAdbAuth', '/revokeAdbKeys',
				'/setDevPassword', '/setStatus', '/sshOverWifi']);
	} finally {
		b.done();
	}
});

test('D3: an invalid usbDebugging is answered as one', async () => {
	const b = boot();
	try {
		const r = await b.ask('setStatus', '{"usbDebugging":"on"}');
		assert.equal(r.errorText, 'Invalid value provided for usbDebugging');
		assert.equal((await b.ask('setStatus', '{"status":"on"}')).errorText, 'Invalid value provided for status');
	} finally {
		b.done();
	}
});

test('D4: a valid status with an invalid usbDebugging changes nothing', async () => {
	const b = boot();
	try {
		b.setState({dev: true, usb: true});
		const r = await b.ask('setStatus', '{"status":"disabled","usbDebugging":"off"}');
		assert.equal(r.errorText, 'Invalid value provided for usbDebugging');
		await b.settle();
		assert.deepEqual(b.state(), {dev: true, usb: true});
		assert.deepEqual(b.exec, []);
	} finally {
		b.done();
	}
});

test('D1: an invalid value is answered returnValue:false, everything else true', async () => {
	const b = boot();
	try {
		assert.equal(await b.send('setStatus', '{"status":"on"}'),
			'{"returnValue":false,"errorText":"Invalid value provided for status","errorCode":0}');
		assert.equal(await b.send('setStatus', '{"usbDebugging":"disabled"}'),
			'{"returnValue":true,"errorText":"","errorCode":0}');
		assert.equal(await b.send('setStatus', '{}'), '{"returnValue":true,"errorText":"","errorCode":0}');
		await b.settle();
	} finally {
		b.done();
	}
});

test('D2: a getStatus sent the moment setStatus answers sees the change', async () => {
	const b = boot();
	try {
		for (const [payload, status, usb] of [['{"status":"enabled","usbDebugging":"enabled"}', 'enabled', 'enabled'],
			['{"usbDebugging":"disabled"}', 'enabled', 'disabled'], ['{"status":"disabled"}', 'disabled', 'disabled']]) {
			await b.ask('setStatus', payload);
			const r = await b.ask('getStatus', '{}');
			assert.deepEqual([r.status, r.usbDebugging], [status, usb], payload);
		}
		await b.settle();
	} finally {
		b.done();
	}
});

test('D6: a flag that cannot be written or removed is answered as a failure', {skip: process.getuid && process.getuid() === 0 ?
	'root writes into a read-only directory' : false}, async () => {
	const b = boot();
	const luna = require('path').dirname(b.flags.dev);
	try {
		require('fs').chmodSync(luna, 0o555);
		let r = await b.ask('setStatus', '{"status":"enabled","usbDebugging":"enabled"}');
		assert.deepEqual(r, {returnValue: false, errorText: 'Could not write ' + b.flags.dev, errorCode: 0});
		assert.deepEqual(b.state(), {dev: false, usb: false}, 'usbDebugging is not acted on after it');
		require('fs').chmodSync(luna, 0o755);
		b.setState({dev: true, usb: false});
		require('fs').chmodSync(luna, 0o555);
		r = await b.ask('setStatus', '{"status":"disabled"}');
		assert.deepEqual(r, {returnValue: false, errorText: 'Could not remove ' + b.flags.dev, errorCode: 0});
		await b.settle();
	} finally {
		require('fs').chmodSync(luna, 0o755);
		b.done();
	}
});

test('D6: the USB flag\'s open or unlink failing is answered as a failure; a flag not there is off', async () => {
	const fail = code => Object.assign(new Error(code + ': refused'), {code});
	const b = boot({fsWrap: real => Object.assign(Object.create(real), {
		open: (p, mode, cb) => setImmediate(() => cb(fail('EACCES'))),
		unlink: (p, cb) => setImmediate(() => cb(p.endsWith('usb-debugging-enabled') && real.existsSync(p) ? fail('EPERM') :
			Object.assign(new Error('ENOENT'), {code: 'ENOENT'})))
	})});
	try {
		let r = await b.ask('setStatus', '{"usbDebugging":"enabled"}');
		assert.equal(r.returnValue, false);
		assert.equal(r.errorText, 'Could not write ' + b.flags.usb + ': EACCES: refused');
		b.setState({dev: false, usb: true});
		r = await b.ask('setStatus', '{"usbDebugging":"disabled"}');
		assert.equal(r.errorText, 'Could not remove ' + b.flags.usb + ': EPERM: refused');
		b.setState({dev: false, usb: false});
		r = await b.ask('setStatus', '{"usbDebugging":"disabled"}');
		assert.deepEqual(r, {returnValue: true, errorText: '', errorCode: 0});
		await b.settle();
		assert.deepEqual(b.exec, [['/bin/systemctl', 'stop', 'android-tools-adbd']],
			'adbd is not started; it is stopped only by the call that found no flag (D7)');
	} finally {
		b.done();
	}
});

test('D6: a touch, rm or systemctl that is not there does not end the service', async () => {
	const b = boot({missing: ['/bin/touch', '/bin/rm'], systemctl: (args, child) => setImmediate(() => {
		child.emit('error', Object.assign(new Error('spawn /bin/systemctl ENOENT'), {code: 'ENOENT'}));
		child.emit('exit', -2, null);
	})});
	try {
		let r = await b.ask('setStatus', '{"status":"enabled"}');
		assert.deepEqual(r, {returnValue: false, errorText: 'Could not write ' + b.flags.dev, errorCode: 0});
		b.setState({dev: true, usb: false});
		r = await b.ask('setStatus', '{"status":"disabled"}');
		assert.deepEqual(r, {returnValue: false, errorText: 'Could not remove ' + b.flags.dev, errorCode: 0});
		r = await b.ask('setStatus', '{"usbDebugging":"enabled"}');
		assert.deepEqual(r, {returnValue: true, errorText: '', errorCode: 0});
		await b.settle();
		assert.deepEqual((await b.ask('getStatus', '{}')).usbDebugging, 'enabled');
	} finally {
		b.done();
	}
});

test('D5: turning developer mode off turns USB debugging off with it', async () => {
	const b = boot();
	try {
		b.setState({dev: true, usb: true});
		assert.deepEqual(await b.ask('setStatus', '{"status":"disabled"}'), {returnValue: true, errorText: '', errorCode: 0});
		const r = await b.ask('getStatus', '{}');
		assert.deepEqual([r.status, r.usbDebugging], ['disabled', 'disabled']);
		await b.settle();
		assert.deepEqual(b.exec, [['/bin/systemctl', 'stop', 'android-tools-adbd'], ['/bin/systemctl', 'stop', 'sshd.socket'],
			['/bin/rm', '/var/luna/dev-mode-enabled'], ['/bin/systemctl', 'restart', 'webapp-mgr.service']]);
		b.setState({dev: true, usb: false});
		await b.ask('setStatus', '{"status":"disabled","usbDebugging":"enabled"}');
		assert.deepEqual(b.state(), {dev: false, usb: true}, 'asked for in the same call, it is written again');
		await b.settle();
	} finally {
		b.done();
	}
});

test('D7: usbDebugging:"disabled" stops adbd when there is no USB flag to remove', async () => {
	const b = boot();
	try {
		b.setState({dev: true, usb: false});
		assert.deepEqual(await b.ask('setStatus', '{"usbDebugging":"disabled"}'), {returnValue: true, errorText: '', errorCode: 0});
		await b.settle();
		assert.deepEqual(b.exec, [['/bin/systemctl', 'stop', 'android-tools-adbd']]);
	} finally {
		b.done();
	}
});

test('D8: the USB flag is the one adbd\'s unit and the developer image use, /var/usb-debugging-enabled', async () => {
	// meta-webos-ports' drop-in for android-tools-adbd.service: ConditionPathExists=/var/usb-debugging-enabled
	// (and /var/luna/dev-mode-enabled).
	const seen = [];
	const fs = {
		accessSync: p => { seen.push(['access', p]); },
		open: (p, mode, cb) => { seen.push(['open', p]); setImmediate(() => cb(null, 3)); },
		close: (fd, cb) => setImmediate(() => cb(null)),
		unlink: (p, cb) => { seen.push(['unlink', p]); setImmediate(() => cb(null)); }
	};
	const {EventEmitter} = require('events');
	const spawn = () => new EventEmitter();
	const {createDevmode, USB_FLAG} = require('../lib/devmode');
	assert.equal(USB_FLAG, '/var/usb-debugging-enabled');
	const d = createDevmode({fs, spawn, log: {log() {}, error() {}}});
	assert.equal(d.getStatus().usbDebugging, 'enabled');
	await d.setStatus({usbDebugging: 'enabled'});
	await d.setStatus({usbDebugging: 'disabled'});
	assert.deepEqual(seen.filter(s => s[1] !== '/var/luna/dev-mode-enabled'), [
		['access', '/var/usb-debugging-enabled'],
		['open', '/var/usb-debugging-enabled'],
		['unlink', '/var/usb-debugging-enabled']
	]);
});

test('D9: developer mode turns sshd on and off with it, and restarts WAM when it changes', async () => {
	const b = boot();
	const ok = {returnValue: true, errorText: '', errorCode: 0};
	const run = async (pre, payload) => {
		b.setState(pre);
		b.exec.length = 0;
		assert.deepEqual(await b.ask('setStatus', payload), ok);
		await b.settle();
		return b.exec.slice();
	};
	try {
		assert.deepEqual(await run({dev: false, usb: false}, '{"status":"enabled"}'), [['/bin/touch', '/var/luna/dev-mode-enabled'],
			['/bin/systemctl', 'start', 'sshd.socket'], ['/bin/systemctl', 'restart', 'webapp-mgr.service']]);
		assert.deepEqual(await run({dev: true, usb: false}, '{"status":"enabled"}'), [['/bin/touch', '/var/luna/dev-mode-enabled'],
			['/bin/systemctl', 'start', 'sshd.socket']], 'on already: WAM is left running');
		assert.deepEqual(await run({dev: true, usb: false}, '{"status":"disabled"}'), [['/bin/systemctl', 'stop', 'android-tools-adbd'],
			['/bin/systemctl', 'stop', 'sshd.socket'], ['/bin/rm', '/var/luna/dev-mode-enabled'],
			['/bin/systemctl', 'restart', 'webapp-mgr.service']]);
		assert.deepEqual(await run({dev: false, usb: false}, '{"status":"disabled"}'), [['/bin/systemctl', 'stop', 'android-tools-adbd'],
			['/bin/systemctl', 'stop', 'sshd.socket'], ['/bin/rm', '/var/luna/dev-mode-enabled']], 'off already: WAM is left running');
		assert.deepEqual(await run({dev: false, usb: false}, '{"usbDebugging":"enabled"}'), [['/bin/systemctl', 'start', 'android-tools-adbd']],
			'usbDebugging alone leaves sshd and WAM be');
	} finally {
		b.done();
	}
});

test('D9: a developer mode flag that could not be removed does not restart WAM', async () => {
	const b = boot({missing: ['/bin/rm']});
	try {
		b.setState({dev: true, usb: false});
		const r = await b.ask('setStatus', '{"status":"disabled"}');
		assert.equal(r.returnValue, false);
		await b.settle();
		assert.ok(!b.exec.some(a => a[1] === 'restart'), JSON.stringify(b.exec));
	} finally {
		b.done();
	}
});

test('D10: an /etc/usb-debugging-enabled from an older image is taken over to /var once', async () => {
	const fs = require('fs');
	const path = require('path');
	const {createDevmode} = require('../lib/devmode');
	const os = require('os');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmode-d10-'));
	const f = {dev: path.join(dir, 'dev'), usb: path.join(dir, 'usb'), legacy: path.join(dir, 'etc-usb')};
	const started = [];
	const {EventEmitter} = require('events');
	const spawn = (cmd, args) => {
		started.push([cmd].concat(args));
		const c = new EventEmitter();
		setImmediate(() => c.emit('exit', 0));
		return c;
	};
	const quiet = {log() {}, error() {}};
	const make = (fsImpl = fs) => createDevmode({fs: fsImpl, spawn, log: quiet, devmodeFlag: f.dev, usbFlag: f.usb, legacyUsbFlag: f.legacy});
	try {
		// Nothing to take over.
		assert.equal(make().migrateUsbFlag(), false);
		assert.equal(fs.existsSync(f.usb), false);

		// Taken over: /var written, /etc removed, adbd started (developer mode is on).
		fs.writeFileSync(f.dev, '');
		fs.writeFileSync(f.legacy, '');
		const d = make();
		assert.equal(d.migrateUsbFlag(), true);
		assert.deepEqual([fs.existsSync(f.usb), fs.existsSync(f.legacy)], [true, false]);
		assert.equal(d.getStatus().usbDebugging, 'enabled');
		assert.deepEqual(started, [['/bin/systemctl', 'start', 'android-tools-adbd']]);

		// A read-only /etc: the old flag stays, nothing fails, and the next start does not start adbd again.
		fs.rmSync(f.usb);
		fs.writeFileSync(f.legacy, '');
		started.length = 0;
		const ro = Object.assign(Object.create(fs), {unlinkSync: p => {
			if (p === f.legacy) {
				throw Object.assign(new Error('read-only file system'), {code: 'EROFS'});
			}
			return fs.unlinkSync(p);
		}});
		assert.equal(make(ro).migrateUsbFlag(), true);
		assert.deepEqual([fs.existsSync(f.usb), fs.existsSync(f.legacy)], [true, true]);
		assert.equal(make(ro).migrateUsbFlag(), true);
		assert.equal(started.length, 1);

		// Turned off since: the old flag must not turn it back on. Off removes the /var flag, and
		// the /etc one is gone wherever it could be removed; where it could not, it is taken over
		// again, which is why it is removed whenever possible.
		fs.rmSync(f.legacy);
		await make().setStatus({usbDebugging: 'disabled'});
		assert.equal(make().migrateUsbFlag(), false);
		assert.equal(fs.existsSync(f.usb), false);

		// /var cannot be written: /etc is left as it was, nothing fails.
		fs.writeFileSync(f.legacy, '');
		const noVar = Object.assign(Object.create(fs), {openSync: () => {
			throw Object.assign(new Error('no space'), {code: 'ENOSPC'});
		}});
		assert.equal(make(noVar).migrateUsbFlag(), false);
		assert.equal(fs.existsSync(f.legacy), true);
	} finally {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

test('D10: the service takes the old flag over when it starts', async () => {
	const fs = require('fs');
	const b = boot({pre: {legacyUsb: true, dev: true}});
	try {
		assert.deepEqual(b.state(), {dev: true, usb: true});
		assert.equal(fs.existsSync(b.flags.legacyUsb), false);
		assert.deepEqual((await b.ask('getStatus', '{}')).usbDebugging, 'enabled');
		await b.settle();
		assert.deepEqual(b.exec, [['/bin/systemctl', 'start', 'android-tools-adbd']]);
	} finally {
		b.done();
	}
});
