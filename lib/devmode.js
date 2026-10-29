// Copyright (C) 2013-2014 Simon Busch <morphis@gravedo.de>
// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The two methods, as DevModeAssistants.js had them.

	Developer mode is a flag file, /var/luna/dev-mode-enabled; USB debugging
	is another, /var/usb-debugging-enabled (the one android-tools-adbd's unit
	needs to start, with developer mode's: README D8), with adbd started and
	stopped by systemd beside it. getStatus says which flags are there. An
	/etc/usb-debugging-enabled left by an older image is taken over once
	(migrateUsbFlag, README D10).

	fs and spawn are passed in, and so are the flag paths, so the tests can
	run it on files of their own and see what it would start.
*/

const DEVMODE_FLAG = '/var/luna/dev-mode-enabled';
const USB_FLAG = '/var/usb-debugging-enabled';
// Where 0583a97 and older developer images kept it (README D10).
const LEGACY_USB_FLAG = '/etc/usb-debugging-enabled';
const ADBD = 'android-tools-adbd';
// The other ways in that developer mode turns on and off (README: D9). sshd.socket and WAM's
// --remote-debugging-port both need the developer mode flag (meta-webos-ports), so they stay as
// set across a reboot; WAM reads it only at start, hence the restart.
const SSHD = 'sshd.socket';
const WAM = 'webapp-mgr.service';

/*
	onUsb(on) is told when USB debugging has been turned on or off (the
	adbd key questions, lib/adbauth.js); onDevmodeOff() when developer mode
	has gone off (SSH over Wi-Fi, lib/access.js).
*/
function createDevmode({fs = require('fs'), spawn = require('child_process').spawn,
	devmodeFlag = DEVMODE_FLAG, usbFlag = USB_FLAG, legacyUsbFlag = LEGACY_USB_FLAG, log = console,
	onUsb = () => {}, onDevmodeOff = async () => {}} = {}) {

	/*
		systemctl is not waited for (it can take as long as adbd takes to
		start) and how it ends is only logged: adbd is not there on every
		build (it is on the Halium ports), and stopping one that is not
		there must not fail the call. A systemctl that cannot be started
		is logged too; unheard, its error event ended the service (README:
		D6). verb: start, stop or restart.
	*/
	function systemd(verb, name) {
		const args = [verb, name];
		const child = spawn('/bin/systemctl', args);
		child.on('error', e => log.error('devmode: /bin/systemctl ' + args.join(' ') + ': ' + e.message));
		child.on('exit', code => {
			if (code !== 0) {
				log.log('devmode: /bin/systemctl ' + args.join(' ') + ' exited ' + code);
			}
		});
	}

	// A process run to its end (touch, rm): -> once it has exited, or could not be started.
	function run(cmd, args) {
		return new Promise(resolve => {
			const child = spawn(cmd, args);
			child.on('error', e => {
				log.error('devmode: ' + cmd + ': ' + e.message);
				resolve();
			});
			child.on('exit', () => resolve());
		});
	}

	// A change that did not happen (README: D6); service.js answers it returnValue:false.
	function failed(text) {
		log.error('devmode: ' + text);
		return {returnValue: false, errorText: text, errorCode: 0};
	}

	// A value given that is neither "enabled" nor "disabled": both are looked at before either is acted on.
	function invalid(args) {
		for (const key of ['status', 'usbDebugging']) {
			if (args[key] !== undefined && args[key] !== 'enabled' && args[key] !== 'disabled') {
				return {returnValue: false, errorText: 'Invalid value provided for ' + key, errorCode: 0};
			}
		}
		return null;
	}

	/*
		The reply comes once the flags are written or removed (README: D2).
		Its returnValue is false for a call that changed nothing; the bus
		answers that one true, as mojoservice did (service.js).
	*/
	async function setStatus(args) {
		let success = false;
		const errorText = '';
		const refused = invalid(args);
		if (refused) {
			return refused;
		}

		// Whether touch or rm worked is told by the flag they leave.
		// WAM is restarted only when developer mode changes: it closes every web app.
		const wasOn = exists(devmodeFlag);
		if (args.status === 'enabled') {
			await run('/bin/touch', [devmodeFlag]);
			if (!exists(devmodeFlag)) {
				return failed('Could not write ' + devmodeFlag);
			}
			success = true;
			systemd('start', SSHD);
			if (!wasOn) {
				systemd('restart', WAM);
			}
		} else if (args.status === 'disabled') {
			// Turning developer mode off turns off every way in: adbd, and the USB flag with it, so
			// getStatus does not go on saying usbDebugging is on (README: D5); sshd, and WAM's
			// DevTools port (D9). A session already open over ssh is left to end by itself.
			systemd('stop', ADBD);
			systemd('stop', SSHD);
			onUsb(false);
			await run('/bin/rm', [devmodeFlag]);
			if (exists(devmodeFlag)) {
				return failed('Could not remove ' + devmodeFlag);
			}
			if (wasOn) {
				systemd('restart', WAM);
			}
			try {
				await onDevmodeOff();
			} catch (e) {
				log.error('devmode: turning developer mode off: ' + e.message);
			}
			const err = await new Promise(resolve => fs.unlink(usbFlag, resolve));
			if (err && err.code !== 'ENOENT') {
				return failed('Could not remove ' + usbFlag + ': ' + err.message);
			}
			success = true;
		}

		if (args.usbDebugging === 'enabled') {
			const err = await new Promise(resolve => fs.open(usbFlag, 'w', (e, fd) => {
				if (!e) {
					fs.close(fd, () => {});
					success = true;
					systemd('start', ADBD);
					onUsb(true);
				}
				resolve(e);
			}));
			if (err) {
				return failed('Could not write ' + usbFlag + ': ' + err.message);
			}
		} else if (args.usbDebugging === 'disabled') {
			const err = await new Promise(resolve => fs.unlink(usbFlag, resolve));
			if (err && err.code !== 'ENOENT') {
				return failed('Could not remove ' + usbFlag + ': ' + err.message);
			}
			// A flag not there is off already, but adbd may still run (started by hand, say).
			// It is stopped either way (D7).
			success = success || !err;
			systemd('stop', ADBD);
			onUsb(false);
		}

		return {returnValue: success, errorText, errorCode: 0};
	}

	function exists(path) {
		try {
			fs.accessSync(path);
			return true;
		} catch (e) {
			return false;
		}
	}

	function getStatus() {
		return {
			returnValue: true,
			status: exists(devmodeFlag) ? 'enabled' : 'disabled',
			usbDebugging: exists(usbFlag) ? 'enabled' : 'disabled'
		};
	}

	/*
		README D10: an /etc/usb-debugging-enabled from an older image means
		USB debugging was on. It is taken over once: the /var flag is written,
		adbd started (its unit now looks at /var, so it was skipped at boot),
		and the /etc one removed where /etc can be written. Nothing here
		fails the service: on a read-only /etc the old flag stays, and is
		looked at again (and found taken over) next time.
	*/
	function migrateUsbFlag() {
		if (!exists(legacyUsbFlag)) {
			return false;
		}
		if (!exists(usbFlag)) {
			try {
				fs.closeSync(fs.openSync(usbFlag, 'a'));
			} catch (e) {
				log.error('devmode: could not take over ' + legacyUsbFlag + ': ' + e.message);
				return false;
			}
			log.log('devmode: USB debugging was on in ' + legacyUsbFlag + '; now in ' + usbFlag);
			if (exists(devmodeFlag)) {
				systemd('start', ADBD);
			}
		}
		try {
			fs.unlinkSync(legacyUsbFlag);
		} catch (e) {
			if (e.code !== 'ENOENT') {
				log.log('devmode: ' + legacyUsbFlag + ' stays (' + e.code + ')');
			}
		}
		return true;
	}

	return {setStatus, getStatus, migrateUsbFlag, devmodeOn: () => exists(devmodeFlag), usbOn: () => exists(usbFlag)};
}

module.exports = {createDevmode, DEVMODE_FLAG, USB_FLAG, LEGACY_USB_FLAG, ADBD, SSHD, WAM};
