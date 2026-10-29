// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The service on a stand-in bus (palmbus.js), with its two flag files in a
	directory of their own (under os.tmpdir(): set TMPDIR to put it
	elsewhere). touch and rm run for real on those files; systemctl does not
	run, its calls are kept in `exec` with the others.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const {EventEmitter} = require('events');
const {PassThrough} = require('stream');
const childProcess = require('child_process');
const {createPalmbus} = require('./palmbus');

const SERVICE = path.join(__dirname, '..');
const NAME = 'org.webosports.service.devmode';
const REAL = {dev: '/var/luna/dev-mode-enabled', usb: '/var/usb-debugging-enabled'};

const quiet = {log() {}, warn() {}, error() {}, info() {}};

/*
	systemctl: what a call to it does, (args, child) -> nothing; by default
	it exits 0 at once. fsWrap: (realFs) -> the fs the service is given.
	missing: commands (touch, rm) that are not there.
*/
function boot({systemctl, fsWrap, missing = [], pre = {}, adbauth = {}, access = {}, onSpawn} = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmode-test-'));
	fs.mkdirSync(path.join(dir, 'luna'));
	const flags = {dev: path.join(dir, 'luna', 'dev-mode-enabled'), usb: path.join(dir, 'usb-debugging-enabled'),
		legacyUsb: path.join(dir, 'etc-usb-debugging-enabled')};
	// pre: the flags there before the service starts ({dev, usb, legacyUsb}).
	for (const k of Object.keys(pre)) {
		if (pre[k]) {
			fs.writeFileSync(flags[k], '');
		}
	}
	const exec = [];
	const files = {
		socket: path.join(dir, 'adbd-auth'),
		adbKeys: path.join(dir, 'adbd', 'adb_keys'),
		authorizedKeys: path.join(dir, 'root', '.ssh', 'authorized_keys'),
		shadow: path.join(dir, 'shadow'),
		sshWifi: path.join(dir, 'luna', 'ssh-wifi-enabled')
	};
	let running = 0;

	// The command as it would have been on the device: the test paths put back to the real ones.
	const real = a => a === flags.dev ? REAL.dev : a === flags.usb ? REAL.usb : a;

	function spawn(cmd, args) {
		exec.push([cmd].concat(args.map(real)));
		running++;
		// chpasswd and the firewall helper do not run either: onSpawn(cmd, args, child, input)
		// ends them (child.emit('close', code)); without onSpawn they exit 0.
		if (cmd === '/usr/sbin/chpasswd' || cmd === '/usr/sbin/luneos-devmode-firewall') {
			const child = new EventEmitter();
			child.stdin = new PassThrough();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			let input = '';
			child.stdin.on('data', d => { input += d; });
			child.on('close', () => running--);
			child.stdin.on('finish', () => {
				if (onSpawn) {
					onSpawn(cmd, args, child, input);
				} else {
					setImmediate(() => child.emit('close', 0));
				}
			});
			return child;
		}
		if (cmd === '/bin/systemctl') {
			const child = new EventEmitter();
			child.on('exit', () => running--);
			if (systemctl) {
				systemctl(args, child);
			} else {
				setImmediate(() => child.emit('exit', 0, null));
			}
			return child;
		}
		// A command that is not there, as on a build without it.
		const child = childProcess.spawn(missing.includes(cmd) ? path.join(dir, 'no' + cmd) : cmd, args, {stdio: 'ignore'});
		// 'close' comes after 'exit', and after the 'error' of one that could not start; no 'error'
		// listener here, so the service's own is what keeps that from ending the process.
		child.on('close', () => running--);
		return child;
	}

	const pb = createPalmbus(async () => ({returnValue: true}));
	const {start} = require(path.join(SERVICE, 'service'));
	const service = start({palmbus: pb, idleMs: 0, log: quiet, exit() {},
		devmode: {fs: fsWrap ? fsWrap(fs) : fs, spawn, devmodeFlag: flags.dev, usbFlag: flags.usb,
			legacyUsbFlag: flags.legacyUsb},
		adbauth: Object.assign({socketPath: files.socket, keysPath: files.adbKeys, reconnectMs: 20}, adbauth),
		access: Object.assign({spawn, authorizedKeys: files.authorizedKeys, shadow: files.shadow,
			sshWifiFlag: files.sshWifi}, access)});

	function exists(f) {
		return fs.existsSync(f);
	}

	return {
		dir, flags, files, exec, service, pb,
		state() {
			return {dev: exists(flags.dev), usb: exists(flags.usb)};
		},
		setState(s) {
			for (const k of ['dev', 'usb']) {
				if (s[k]) {
					fs.closeSync(fs.openSync(flags[k], 'a'));
				} else {
					fs.rmSync(flags[k], {force: true});
				}
			}
		},
		// The reply text, as the bus would give it to the caller.
		send(method, payloadText) {
			return request(pb, method, payloadText);
		},
		async ask(method, payloadText) {
			return JSON.parse(await request(pb, method, payloadText));
		},
		// Until nothing it started is running and the fs callbacks have had their turn.
		async settle() {
			for (let i = 0; i < 400; i++) {
				await new Promise(r => setTimeout(r, 5));
				if (running === 0) {
					await new Promise(r => setTimeout(r, 20));
					if (running === 0) {
						return;
					}
				}
			}
			throw new Error('still running after 2 s');
		},
		done() {
			service.adb.stop();
			service.bus.stop();
			fs.rmSync(dir, {recursive: true, force: true});
		}
	};
}

// A call whose payload is the text given, as luna-send sends it.
function request(pb, method, payloadText) {
	const h = pb.services[NAME];
	return new Promise(resolve => {
		h.emit('request', {
			method: () => method,
			category: () => '/',
			payload: () => payloadText === undefined ? '{}' : payloadText,
			uniqueToken: () => '1',
			token: () => 1,
			applicationID: () => '',
			senderServiceName: () => '',
			sender: () => '',
			isSubscription: () => false,
			respond: text => {
				resolve(text);
				return true;
			}
		});
	});
}

module.exports = {boot, NAME, REAL, quiet};
