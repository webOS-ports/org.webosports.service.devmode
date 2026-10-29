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
const {CloudError} = require('./lib/errors');
const {createDevmode} = require('./lib/devmode');
const {createAdbAuth} = require('./lib/adbauth');
const {createAccess} = require('./lib/access');

const NAME = 'org.webosports.service.devmode';
// services.json had activityTimeout 30: mojoservice left after 30 s with nothing to do.
const IDLE_MS = 30000;

// The shell, as media-permission-service tells it: its bus name, and the executable the hub saw
// (a privileged tool can take the name, not the executable). The hub gives the executable to a
// privileged service only, hence the role's "privileged".
const SHELL_NAME_PREFIX = 'com.webos.surfacemanager';
const SHELL_EXE = '/usr/bin/surface-manager';
// Settings' Developer Options page, which runs as an application of its own.
const SETTINGS = ['org.webosports.app.settings.devmodeswitcher'];
const LOCK_STATUS = 'luna://com.palm.display/control/lockStatus';

function isShell(sender, exe) {
	return typeof sender === 'string' && sender.indexOf(SHELL_NAME_PREFIX) === 0 && exe === SHELL_EXE;
}

/*
	start({palmbus, ...}): the service on that bus. devmode, adbauth and
	access are what createDevmode(), createAdbAuth() and createAccess() take
	(fs, spawn, net, the paths), for the tests.
*/
function start({palmbus, exit, idleMs = IDLE_MS, log = console, devmode = {}, adbauth = {}, access = {}} = {}) {
	let adb = null;
	// While USB debugging is on, adbd may ask about a key at any time: the service stays.
	const bus = createBus({palmbus, name: NAME, exit, idleMs, log, keepAlive: () => !!adb && adb.active});
	let acc = null;
	const methods = createDevmode(Object.assign({log,
		onUsb: on => {
			if (on) {
				adb.start();
			} else {
				adb.stop();
			}
			bus.touch();
		},
		onDevmodeOff: () => acc.devmodeOff()}, devmode));

	// The screen's lock: one that cannot be read counts as locked.
	async function locked() {
		try {
			const r = await bus.call(LOCK_STATUS, {});
			return r.lockState !== 'unlocked';
		} catch (e) {
			return true;
		}
	}
	function watchLock(onChange) {
		let cancel = null, stopped = false;
		bus.subscribe(LOCK_STATUS, {subscribe: true}, {
			onEvent: r => onChange(!r || r.lockState !== 'unlocked')
		}).then(sub => {
			cancel = sub.cancel;
			if (stopped) {
				cancel();
			} else if (sub.first.lockState !== 'unlocked') {
				onChange(true);
			}
		}, () => {
			if (!stopped) {
				onChange(true);
			}
		});
		return () => {
			stopped = true;
			if (cancel) {
				cancel();
			}
		};
	}
	adb = createAdbAuth(Object.assign({log, locked, watchLock, devmodeOn: methods.devmodeOn}, adbauth));
	acc = createAccess(Object.assign({log, devmodeOn: methods.devmodeOn}, access));
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

	// Only the shell asks the user about adb keys, and only it answers.
	function shellOnly(ctx) {
		if (!isShell(ctx.sender, ctx.exe)) {
			log.error('devmode: ' + ctx.method + ' refused from ' + ctx.sender + ' (' + ctx.exe + ')');
			throw new CloudError('PERMISSION_DENIED', 'Only the system shell may call ' + ctx.method);
		}
	}
	table.adbAuthRequests = {
		subscribe: true,
		allow: [SHELL_NAME_PREFIX + '*'],
		handler: (args, ctx) => {
			shellOnly(ctx);
			if (ctx.subscribed) {
				const off = adb.subscribe(ev => ctx.push(Object.assign({returnValue: true, subscribed: true}, ev)));
				ctx.onCancel(off);
			}
			return Object.assign({subscribed: ctx.subscribed}, adb.current());
		}
	};
	table.respondAdbAuth = {
		allow: [SHELL_NAME_PREFIX + '*'],
		handler: async (args, ctx) => {
			shellOnly(ctx);
			if (typeof args.allow !== 'boolean' || (args.always !== undefined && typeof args.always !== 'boolean')) {
				throw new CloudError('BAD_ARGS', 'allow (and always) must be true or false');
			}
			try {
				return await adb.respond({fingerprint: args.fingerprint, allow: args.allow, always: args.always === true});
			} catch (e) {
				throw new CloudError(e.errorCode || 'FAILED', e.message);
			}
		}
	};
	const settingsMethod = run => ({allow: SETTINGS, handler: async args => run(args)});
	table.setDevPassword = settingsMethod(args => acc.setDevPassword(args));
	table.addAuthorizedKey = settingsMethod(args => acc.addAuthorizedKey(args));
	table.removeAuthorizedKey = settingsMethod(args => acc.removeAuthorizedKey(args));
	table.listAuthorizedKeys = settingsMethod(() => acc.listAuthorizedKeys());
	table.sshOverWifi = settingsMethod(args => acc.sshOverWifi(args));
	table.revokeAdbKeys = settingsMethod(async () => {
		await adb.revoke();
		return {};
	});
	table.getAccessStatus = settingsMethod(async () => ({
		passwordSet: await acc.passwordSet(),
		authorizedKeys: (await acc.listAuthorizedKeys()).keys.length,
		sshOverWifi: acc.sshOverWifiOn()
	}));

	bus.serve(table);
	methods.migrateUsbFlag();
	// USB debugging left on (a reboot, or the service having restarted): adbd may be asking already.
	if (methods.usbOn()) {
		adb.start();
	}
	log.log(NAME + ': up (node ' + process.version + ')');
	return {bus, methods, adb, access: acc};
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

module.exports = {start, run, NAME, isShell, SHELL_EXE, SETTINGS};

if (require.main === module) {
	run();
}
