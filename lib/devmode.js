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
	devmodeFlag = DEVMODE_FLAG, usbFlag = USB_FLAG} = {}) {

	function systemd(name, on) {
		spawn('/bin/systemctl', [on ? 'start' : 'stop', name]);
	}

	/*
		The reply is built before the flags are written: touch and rm run
		as processes of their own and are not waited for, and the USB flag is
		written in a callback that comes after it (README: D2). Its
		returnValue is replaced by mojoservice's true, whatever it was
		(README: D1).
	*/
	// A value given that is neither "enabled" nor "disabled": both are looked at before either is acted on.
	function invalid(args) {
		for (const key of ['status', 'usbDebugging']) {
			if (args[key] !== undefined && args[key] !== 'enabled' && args[key] !== 'disabled') {
				return {returnValue: false, errorText: 'Invalid value provided for ' + key, errorCode: 0};
			}
		}
		return null;
	}

	function setStatus(args) {
		let success = false;
		const errorText = '';
		const refused = invalid(args);
		if (refused) {
			return refused;
		}

		if (typeof args.status !== 'undefined') {
			if (args.status === 'enabled') {
				spawn('/bin/touch', [devmodeFlag]);
				success = true;
			} else if (args.status === 'disabled') {
				// Turning developer mode off turns off every way in (README: D5).
				systemd(ADBD, false);
				spawn('/bin/rm', [devmodeFlag]);
				success = true;
			}
		}

		if (typeof args.usbDebugging !== 'undefined') {
			if (args.usbDebugging === 'enabled') {
				fs.open(usbFlag, 'w', (err, fd) => {
					if (!err) {
						fs.close(fd, () => {});
						success = true;
						systemd(ADBD, true);
					}
				});
			} else if (args.usbDebugging === 'disabled') {
				fs.unlink(usbFlag, err => {
					if (!err) {
						success = true;
						systemd(ADBD, false);
					}
				});
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
