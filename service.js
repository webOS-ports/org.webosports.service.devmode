// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	org.webosports.service.devmode: turns developer mode and USB debugging
	on and off.

	The launcher (run-js-service -> jsservicelauncher's bootstrap-node.js)
	requires this directory, as it has a package.json, and calls run().
	Nothing starts on require, so a test can start() it on a stand-in bus.
	The methods are in lib/devmode.js; lib/mojo.js answers as mojoservice
	did, on lib/bus.js.
*/

const {createBus} = require('./lib/bus');
const {method, mojoArgs} = require('./lib/mojo');
const {createDevmode} = require('./lib/devmode');

const NAME = 'org.webosports.service.devmode';
// services.json had activityTimeout 30: mojoservice left after 30 s with nothing to do.
const IDLE_MS = 30000;

/*
	start({palmbus, ...}): the service on that bus. devmode is what
	createDevmode() takes (fs, spawn, the flag paths), for the tests.
*/
function start({palmbus, exit, idleMs = IDLE_MS, log = console, devmode = {}} = {}) {
	const bus = createBus({palmbus, name: NAME, exit, idleMs, log});
	const methods = createDevmode(Object.assign({log}, devmode));
	/*
		A result that refuses the call (returnValue:false with an errorText:
		an invalid value, or a change that could not be made) is answered so. mojoservice put returnValue:true
		over it, as over every result (README: D1). The other results are
		answered returnValue:true as before.
	*/
	const refusals = new WeakSet();
	const table = {};
	for (const name of ['setStatus', 'getStatus']) {
		const call = async args => {
			const r = await methods[name](args);
			if (r && r.returnValue === false && r.errorText) {
				refusals.add(r);
			}
			return r;
		};
		const m = method(NAME, name, call, {log, subscribe: bus.subscribe});
		table[name] = {
			raw: true,
			text: true,
			timeoutMs: m.timeoutMs,
			handler: async (text, ctx) => {
				const {args, reply} = mojoArgs(text);
				if (reply) {
					return reply;
				}
				const out = await m.handler(args, ctx);
				if (refusals.has(out)) {
					out.returnValue = false;
				}
				return out;
			}
		};
	}
	bus.serve(table);
	methods.migrateUsbFlag();
	log.log(NAME + ': up (node ' + process.version + ')');
	return {bus, methods};
}

let running = null;
function run() {
	if (running) {
		return running;
	}
	process.title = NAME;
	// palmbus is the launcher's: it is there on the device and nowhere else.
	running = start({palmbus: require('palmbus')});
	return running;
}

module.exports = {start, run, NAME};

if (require.main === module) {
	run();
}
