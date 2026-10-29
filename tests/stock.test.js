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

function expected(c) {
	return {reply: c.reply, post: c.post, exec: c.exec};
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
