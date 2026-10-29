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
| `/etc/usb-debugging-enabled` | USB debugging; `android-tools-adbd` is started and stopped with it |

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
- D8: the USB flag was `/var/usb-debugging-enabled`, but
  `android-tools-adbd` starts only when `/etc/usb-debugging-enabled` is
  there (`ConditionPathExists` in meta-oe's unit), and that is the one
  `luneos-dev-image.bb` writes. Turning USB debugging on never started
  adbd, and on a developer image `getStatus` said it was off.

Deliberately different from the old service, and why:

- mojoservice made an activity for every call that brought none, and
  completed it after the reply. Nothing asked for those, and the bus here
  makes none (as the contacts.linker and the messaging service do not). An
  `$activity` that is passed in is still monitored (or adopted, when
  activitymanager calls), as mojoservice did.
- mojoservice's `__info`, `__quit` and `__gc` are now the bus's `info` and
  `quit`; no caller of this service uses them.

Copyright and License Information
=================================
Copyright (C) 2013-2014 Simon Busch <morphis@gravedo.de>
Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version (SPDX: GPL-3.0-or-later). COPYING
holds the licence text.

The service was GPL-2.0-or-later ("version 2 of the License, or (at your
option) any later version", as DevModeAssistants.js said); the rewrite
takes it up under version 3, as that allows.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

lib/devmode.js ports the old DevModeAssistants.js and keeps Simon
Busch's copyright line. lib/mojo.js reproduces the replies of
mojoservice and Foundations, and keeps their notice: Copyright 2009-2012
Hewlett-Packard Development Company, L.P., licensed under the Apache
License, Version 2.0, which allows such code to be part of a GPL-3.0
work. lib/bus.js and lib/errors.js (from luneos-synergy-connectors),
service.js and the tests have no old lineage. files/ (the ACG and D-Bus
service files) is kept from the old service as it was.
