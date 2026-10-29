// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

/*
	Every case the stock service was run on, on the VM (stock-vm.json, by
	tests/vm/drive.js): from each of the four states the two flags can be
	in, the reply, the reply text's field order, the flags once it is all
	done and the commands it ran (touch, rm, systemctl).

	expected() is the stock record changed by the bugs mended since, each
	by its number in README.md; a case it leaves alone is answered and done
	exactly as stock did it.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const {boot} = require('./boot');
const {cases} = require('./stock-vm.json');

const VALUES = ['enabled', 'disabled'];

function expected(c) {
	const want = {reply: c.reply, post: c.post, exec: c.exec};
	let args = {};
	try {
		args = JSON.parse(c.payload) || {};
	} catch (e) { /* none */ }
	const badStatus = args.status !== undefined && !VALUES.includes(args.status);
	const badUsb = args.usbDebugging !== undefined && !VALUES.includes(args.usbDebugging);
	// D3: an invalid usbDebugging is named as such.
	if (c.method === 'setStatus' && badUsb && !badStatus) {
		want.reply = Object.assign({}, want.reply, {errorText: 'Invalid value provided for usbDebugging'});
	}
	// D1: an invalid value is answered returnValue:false.
	if (c.method === 'setStatus' && (badStatus || badUsb)) {
		want.reply = Object.assign({}, want.reply, {returnValue: false});
	}
	// D5: turning developer mode off removes the USB flag too (a usbDebugging:"enabled" with it
	// writes it again).
	if (c.method === 'setStatus' && !badStatus && !badUsb && args.status === 'disabled' &&
		args.usbDebugging !== 'enabled') {
		want.post = Object.assign({}, want.post, {usb: false});
	}
	// D4: an invalid value anywhere changes nothing.
	if (c.method === 'setStatus' && (badStatus || badUsb)) {
		want.post = c.pre;
		want.exec = [];
	}
	return want;
}

const sorted = list => list.map(a => JSON.stringify(a)).sort();
const flags = s => (s.dev ? 'D' : '-') + (s.usb ? 'U' : '-');

test('every stock case, from every state', async t => {
	const b = boot();
	try {
		for (const c of cases) {
			const name = c.method + ' ' + c.payload + ' from ' + flags(c.pre);
			await t.test(name, async () => {
				b.setState(c.pre);
				b.exec.length = 0;
				const want = expected(c);
				const text = await b.send(c.method, c.payload);
				assert.equal(text, JSON.stringify(want.reply));
				if (c.method === 'setStatus') {
					// D2: the flags are as they will stay when the reply comes.
					assert.deepEqual(b.state(), want.post, 'flags at the reply');
				}
				await b.settle();
				if (c.method === 'setStatus') {
					assert.deepEqual(b.state(), want.post);
					assert.deepEqual(sorted(b.exec), sorted(want.exec));
				}
			});
		}
	} finally {
		b.done();
	}
});

module.exports = {expected};
