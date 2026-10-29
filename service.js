/*
 *  Copyright (C) 2013-2014 Simon Busch <morphis@gravedo.de>
 *  Copyright (C) 2026 Herman van Hazendonk <github.com@herrie.org>
 *
 *  This program is free software; you can redistribute it and/or
 *  modify it under the terms of the GNU General Public License
 *  as published by the Free Software Foundation; either version 2
 *  of the License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program; if not, write to the Free Software
 *  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 */

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
	const methods = createDevmode(devmode);
	const table = {};
	for (const name of ['setStatus', 'getStatus']) {
		const m = method(NAME, name, args => methods[name](args), {log, subscribe: bus.subscribe});
		table[name] = {
			raw: true,
			text: true,
			timeoutMs: m.timeoutMs,
			handler: (text, ctx) => {
				const {args, reply} = mojoArgs(text);
				return reply || m.handler(args, ctx);
			}
		};
	}
	bus.serve(table);
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
