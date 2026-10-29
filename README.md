org.webosports.service.devmode
==============================

Summary
-------
Developer mode management service for the webOS ports project

Description
-----------
The service turns developer mode and USB debugging on and off. Each is a
flag file:

| | |
|---|---|
| `/var/luna/dev-mode-enabled` | developer mode |
| `/var/usb-debugging-enabled` | USB debugging; `android-tools-adbd` is started and stopped with it |

Its two methods, both private (`devmode-service.operation`, for the `dev`
group):

- `getStatus` → `{"returnValue":true,"status":"enabled"|"disabled","usbDebugging":"enabled"|"disabled"}`,
  from which of the two flags are there.
- `setStatus` takes `status` and/or `usbDebugging`, each `"enabled"` or
  `"disabled"`. `status:"disabled"` also stops adbd and removes the USB
  flag. It answers
  `{"returnValue":true,"errorText":"","errorCode":0}`, or
  `{"returnValue":false,"errorText":"Invalid value provided for status","errorCode":0}`
  (or `usbDebugging`) for a value that is neither, and then changes
  nothing.

The settings app's Developer Options page (org.webosports.app.settings,
`DeveloperOptionsPage.qml`) is what calls it.

Node 22
-------
The service is a Node 22 rewrite of the mojoservice one, for the
launcher's plain-node path (`run-js-service` requires the directory, as it
has a `package.json`, and calls `run()`). Foundations and mojoservice are no
longer loaded.

| | |
|---|---|
| `service.js` | start-up: the bus and the two methods |
| `lib/devmode.js` | `setStatus` and `getStatus` |
| `lib/mojo.js` | the replies as mojoservice gave them (from the contacts.linker) |
| `lib/bus.js`, `lib/errors.js` | the bus, through palmbus (from the contacts.linker, by way of the messaging service) |
| `tests/` | unit tests (`tests/run.sh`), and `tests/vm/`, which records a service's replies and side effects on a device |

The first version answers and acts as the old service did, its bugs
included. The service is small enough that it was checked on the VM rather
than with a host A/B harness: `tests/vm/drive.js` called every `setStatus`
case from each of the four states the flags can be in, and `getStatus` in
each, with the service's process traced (`strace -f`) for the commands it
ran and the files it opened. Stock's record is `tests/stock-vm.json`;
`tests/stock.test.js` runs every case of it against this service on the
host, and the rewrite gave the same record on the VM.

The old service's bugs, by number; the code, tests and commits refer to
them so:

- D1: `setStatus` answers `returnValue:true` whatever happened. Its own
  `returnValue` (false for an invalid value) is overwritten by
  mojoservice, which sets `returnValue:true` on every result.
- D2: `setStatus` answers before the change is made. `touch` and `rm` are
  started and not waited for, and the USB flag is written in a callback
  that runs after the reply. On the VM, in 2 of the 64 `setStatus` cases
  the flags had not changed yet when the reply came; the settings page
  asks `getStatus` straight after each change.
- D3: an invalid `usbDebugging` is answered "Invalid value provided for
  status".
- D4: `{"status":"disabled","usbDebugging":"x"}` turns developer mode off
  and then answers that the value is invalid: `status` is acted on before
  `usbDebugging` is looked at.
- D5: turning developer mode off stops adbd but leaves the USB flag, so
  `getStatus` goes on saying `usbDebugging:"enabled"` (and the settings
  page shows that switch on, greyed out). The code says "when we turn off
  devmode we also disable all access methods".
- D6: nothing that fails is reported: a flag that cannot be written or
  removed answers as if it had been. A `touch`, `rm` or `systemctl` that
  is not there is an `error` event nobody listens for, which ends the
  service.
- D7: `usbDebugging:"disabled"` stops adbd only when the USB flag was
  there to remove.

Deliberately different from the old service, and why:

- mojoservice made an activity for every call that brought none, and
  completed it after the reply. Nothing asked for those, and the bus here
  makes none (as the contacts.linker and the messaging service do not). An
  `$activity` that is passed in is still monitored (or adopted, when
  activitymanager calls), as mojoservice did.
- mojoservice's `__info`, `__quit` and `__gc` are now the bus's `info` and
  `quit`; no caller of this service uses them.

Not this service's to mend: `luneos-dev-image.bb` (meta-webos-ports)
writes `/etc/usb-debugging-enabled`, while this service has always used
`/var/usb-debugging-enabled`, so on a developer image `getStatus` says USB
debugging is off.

Copyright and License Information
=================================
Unless otherwise specified, all content, including all source code files and
documentation files in this repository are:

Copyright (C) 2013 Simon Busch <morphis@gravedo.de>

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License version 2 as
published by the Free Software Foundation.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, write to the Free Software
Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA

`lib/bus.js`, `lib/errors.js`, `lib/mojo.js` and `tests/palmbus.js` come
from the contacts.linker and the cloud connectors and are under the Apache
License, Version 2.0, as their headers say.
