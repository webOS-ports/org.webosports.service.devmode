// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-2.0-or-later

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

test('it registers its two methods and the bus\'s quit and info', () => {
	const b = boot();
	try {
		assert.deepEqual(b.pb.services['org.webosports.service.devmode'].methods.sort(),
			['/getStatus', '/info', '/quit', '/setStatus']);
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
			['{"status":"disabled"}', 'disabled', 'enabled'], ['{"usbDebugging":"disabled"}', 'disabled', 'disabled']]) {
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
		assert.deepEqual(b.exec, [], 'adbd is not started or stopped');
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
