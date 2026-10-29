// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

// VM side: every setStatus case from every start state, and getStatus, against whatever
// org.webosports.service.devmode is installed. Writes one JSON report.
//   node drive.js <out.json>
// The service's exec/open/unlink calls are traced with strace -f on every thread of its process.
'use strict';
const {spawn} = require('child_process');
const fs = require('fs');

const SVC = 'luna://org.webosports.service.devmode/';
const DEV = '/var/luna/dev-mode-enabled';
const USB = '/etc/usb-debugging-enabled';

function ls(uri, payload) {
	return new Promise(resolve => {
		const p = spawn('luna-send', ['-n', '1', '-w', '20000', uri, payload], {stdio: ['pipe', 'pipe', 'pipe']});
		let out = '', err = '';
		p.stdout.on('data', d => { out += d; });
		p.stderr.on('data', d => { err += d; });
		p.on('close', () => {
			try { resolve(JSON.parse(out)); } catch (e) { resolve({raw: out.trim(), err: err.trim()}); }
		});
	});
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function exists(f) { try { fs.accessSync(f); return true; } catch (e) { return false; } }
function state() { return {dev: exists(DEV), usb: exists(USB)}; }
function setState(s) {
	for (const [f, on] of [[DEV, s.dev], [USB, s.usb]]) {
		if (on) { fs.closeSync(fs.openSync(f, 'a')); } else { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
	}
}
function servicePid() {
	for (const pid of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
		try {
			// node, as it runs the service: not a shell or ssh whose command line names it.
			if (fs.readlinkSync('/proc/' + pid + '/exe') !== process.execPath) { continue; }
			const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
			if (cmd.includes('org.webosports.service.devmode') && !cmd.includes('drive.js')) { return pid; }
		} catch (e) { /* gone */ }
	}
	return null;
}

const CASES = ['{}', '{"status":"enabled"}', '{"status":"disabled"}', '{"status":"bogus"}', '{"status":true}',
	'{"status":null}', '{"usbDebugging":"enabled"}', '{"usbDebugging":"disabled"}', '{"usbDebugging":"x"}',
	'{"status":"disabled","usbDebugging":"x"}', '{"status":"enabled","usbDebugging":"enabled"}',
	'{"status":"disabled","usbDebugging":"enabled"}', '{"status":"enabled","usbDebugging":"disabled"}',
	'{"status":"x","usbDebugging":"enabled"}', '[]', '{"status":"enabled","extra":1}'];
const STATES = [{dev: false, usb: false}, {dev: true, usb: false}, {dev: false, usb: true}, {dev: true, usb: true}];

(async () => {
	const out = {node: process.version, cases: []};
	await ls(SVC + 'getStatus', '{}');
	// Which one answers: the bus's info is the rewrite's; mojoservice has __info.
	out.info = await ls(SVC + 'info', '{}');
	const pid = servicePid();
	out.pid = pid;
	out.cmdline = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').trim();
	// Every thread of it: strace -p takes one thread, and the fs calls run on libuv's pool.
	const tids = fs.readdirSync('/proc/' + pid + '/task');
	const trace = '/home/root/rewrites/devmode/strace.log';
	const st = spawn('strace', ['-f', '-ttt', '-s', '200', '-e', 'trace=execve,openat,unlink,unlinkat', '-o', trace].concat(...tids.map(t => ['-p', t])),
		{stdio: 'ignore'});
	await sleep(1000);
	for (const s of STATES) {
		setState(s);
		await sleep(50);
		const g = await ls(SVC + 'getStatus', '{}');
		out.cases.push({method: 'getStatus', pre: s, reply: g});
	}
	out.cases.push({method: 'getStatus', pre: state(), payload: '{"x":1}', reply: await ls(SVC + 'getStatus', '{"x":1}')});
	for (const payload of CASES) {
		for (const s of STATES) {
			setState(s);
			await sleep(50);
			const t0 = Date.now() / 1000;
			const reply = await ls(SVC + 'setStatus', payload);
			const right = state();
			const after = await ls(SVC + 'getStatus', '{}');
			await sleep(400);
			out.cases.push({method: 'setStatus', payload, pre: s, reply, stateAtReply: right, getStatusAfter: after,
				post: state(), t0, t1: Date.now() / 1000});
		}
	}
	await sleep(500);
	st.kill('SIGINT');
	await sleep(500);
	const lines = fs.readFileSync(trace, 'utf8').split('\n');
	for (const c of out.cases) {
		if (!c.t0) { continue; }
		c.trace = lines.filter(l => {
			const m = /^\d+\s+(\d+\.\d+)\s+(.*)$/.exec(l);
			if (!m) { return false; }
			const t = Number(m[1]);
			return t >= c.t0 && t <= c.t1 && /execve\(|dev-mode-enabled|usb-debugging-enabled/.test(m[2]) &&
				!/resumed>/.test(m[2]);
		}).map(l => l.replace(/^\d+\s+\d+\.\d+\s+/, '').replace(/, 0x[0-9a-f]+ \/\* \d+ vars \*\//, ''));
	}
	fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
	console.log('cases ' + out.cases.length + ' pid ' + pid);
})();
