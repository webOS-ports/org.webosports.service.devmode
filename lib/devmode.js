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
	The two methods, as DevModeAssistants.js had them.

	Developer mode is a flag file, /var/luna/dev-mode-enabled; USB debugging
	is another, /var/usb-debugging-enabled, with android-tools-adbd started
	and stopped by systemd beside it. getStatus says which flags are there.

	fs and spawn are passed in, and so are the flag paths, so the tests can
	run it on files of their own and see what it would start.
*/

const DEVMODE_FLAG = '/var/luna/dev-mode-enabled';
const USB_FLAG = '/var/usb-debugging-enabled';
const ADBD = 'android-tools-adbd';

function createDevmode({fs = require('fs'), spawn = require('child_process').spawn,
	devmodeFlag = DEVMODE_FLAG, usbFlag = USB_FLAG, log = console} = {}) {

	/*
		systemctl is not waited for (it can take as long as adbd takes to
		start) and how it ends is only logged: adbd is not there on every
		build (it is on the Halium ports), and stopping one that is not
		there must not fail the call. A systemctl that cannot be started
		is logged too; unheard, its error event ended the service (README:
		D6).
	*/
	function systemd(name, on) {
		const args = [on ? 'start' : 'stop', name];
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
		if (args.status === 'enabled') {
			await run('/bin/touch', [devmodeFlag]);
			if (!exists(devmodeFlag)) {
				return failed('Could not write ' + devmodeFlag);
			}
			success = true;
		} else if (args.status === 'disabled') {
			// Turning developer mode off turns off every way in (README: D5).
			systemd(ADBD, false);
			await run('/bin/rm', [devmodeFlag]);
			if (exists(devmodeFlag)) {
				return failed('Could not remove ' + devmodeFlag);
			}
			success = true;
		}

		if (args.usbDebugging === 'enabled') {
			const err = await new Promise(resolve => fs.open(usbFlag, 'w', (e, fd) => {
				if (!e) {
					fs.close(fd, () => {});
					success = true;
					systemd(ADBD, true);
				}
				resolve(e);
			}));
			if (err) {
				return failed('Could not write ' + usbFlag + ': ' + err.message);
			}
		} else if (args.usbDebugging === 'disabled') {
			const err = await new Promise(resolve => fs.unlink(usbFlag, e => {
				if (!e) {
					success = true;
					systemd(ADBD, false);
				}
				resolve(e);
			}));
			// Not there is off already.
			if (err && err.code !== 'ENOENT') {
				return failed('Could not remove ' + usbFlag + ': ' + err.message);
			}
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

	return {setStatus, getStatus};
}

module.exports = {createDevmode, DEVMODE_FLAG, USB_FLAG, ADBD};
