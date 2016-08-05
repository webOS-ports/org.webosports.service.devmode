/*
 *  Copyright (C) 2013-2014 Simon Busch <morphis@gravedo.de>
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
 *
 */

var DevModeSetStatusAssistant = function() { }
var DevModeGetStatusAssistant = function() { }

var devmodeEnabledFilePath = "/var/luna/dev-mode-enabled";
var usbDebuggingEnabledFilePath = "/var/usb-debugging-enabled";

function setSystemdServiceStatus(name, status) {
    var action = status ? 'start' : 'stop';
    spawn('/bin/systemctl', [action, name]);
}

DevModeSetStatusAssistant.prototype.run = function(future) {
    var success = false;
    var errorText = "";

    if (typeof this.controller.args.status !== 'undefined') {
        if(this.controller.args.status === "enabled") {
            spawn("/bin/touch", [devmodeEnabledFilePath]);
            success = true;
        }
        else if (this.controller.args.status === "disabled") {
            /* when we turn off devmode we also disable all access methods */
            setSystemdServiceStatus("android-tools-adbd", false);
            spawn("/bin/rm", [devmodeEnabledFilePath]);
            success = true;
        }
        else {
            future.result = {
                "returnValue": false,
                "errorText": "Invalid value provided for status",
                "errorCode": 0
            };
            return;
        }
    }

    if (typeof this.controller.args.usbDebugging !== 'undefined') {
        if (this.controller.args.usbDebugging === "enabled") {
            fs.open(usbDebuggingEnabledFilePath, 'w', function(err, fd) {
                if (!err) {
                    fs.close(fd);
                    success = true;
                    setSystemdServiceStatus('android-tools-adbd', true);
                }
            });
        }
        else if (this.controller.args.usbDebugging === "disabled") {
            fs.unlink(usbDebuggingEnabledFilePath, function(err) {
                if (!err) {
                    success = true;
                    setSystemdServiceStatus('android-tools-adbd', false);
                }
            });
        }
        else {
            future.result = {
                "returnValue": false,
                "errorText": "Invalid value provided for status",
                "errorCode": 0
            };
            return;
        }
    }

    future.result = {
        "returnValue": success,
        "errorText": errorText,
        "errorCode": 0,
    };
}

DevModeGetStatusAssistant.prototype.run = function(future) {
    var devModeStatus = "disabled";
    var usbDebuggingStatus = "disabled";
    try {
        fs.accessSync(devmodeEnabledFilePath);
        devModeStatus = "enabled";
    } catch(e) {}
    try {
        fs.accessSync(usbDebuggingEnabledFilePath);
        usbDebuggingStatus = "enabled";
    } catch(e) {}
    future.result = {
        "returnValue": true,
        "status": devModeStatus,
        "usbDebugging": usbDebuggingStatus
    };
}
