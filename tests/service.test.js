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
