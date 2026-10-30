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

Its first two methods:

- `getStatus` → `{"returnValue":true,"status":"enabled"|"disabled","usbDebugging":"enabled"|"disabled"}`,
  from which of the two flags are there.
- `setStatus` takes `status` and/or `usbDebugging`, each `"enabled"` or
  `"disabled"`. `status:"disabled"` also stops adbd and removes the USB
  flag. `status` starts or stops `sshd.socket` with it, and restarts
  `webapp-mgr.service` when developer mode changes, so WAM's DevTools port
  (9998) comes and goes with it (see D9). It answers
  `{"returnValue":true,"errorText":"","errorCode":0}`, or
  `{"returnValue":false,"errorText":"Invalid value provided for status","errorCode":0}`
  (or `usbDebugging`) for a value that is neither, and then changes
  nothing.

The settings app's Developer Options page (org.webosports.app.settings,
`DeveloperOptionsPage.qml`) is what calls it.

`getStatus` is in `devmode-service.operation` (trust level `dev`).
`setStatus` and the access methods below are in
`devmode-service.management` (`oem`), which Developer Options
(`org.webosports.app.settings.devmodeswitcher`) asks for; the access
methods also take only that caller. The adb key methods are in
`devmode-service.shell` (`oem`), which
`org.webosports.service.devmode-shell.perm.json` gives the shell, and
take only the shell: its bus name (`com.webos.surfacemanager*`) and the
executable the hub saw (`/usr/bin/surface-manager`), as
media-permission-service checks it. The hub gives a caller's executable to
a privileged service only, so the role is `privileged`.

The ways in
-----------
Images let root in with neither an empty password nor a password over
ssh from the network (audit C1); developer mode is how a device is opened
up. sshd takes root's password only on the local link: the device's end of
its USB network, and on an emulator its NAT address (meta-luneos'
`luneos_image.bbclass`, `LUNEOS_SSH_PASSWORD_ADDRESSES`); elsewhere, Wi-Fi
included, a key is needed.

USB debugging asks before adbd lets a host in (audit C2, `lib/adbauth.js`).
meta-luneos' adbd sends a key it does not know yet on `/run/adbd/auth`
(root's only). The service stays connected to it while USB debugging is
on (and does not leave when idle meanwhile), and puts each key to the
shell, which shows luneos-components' `UsbDebuggingPrompt`:

- `adbAuthRequests` (subscribe) → `{"request":{"fingerprint","timeoutMs"}}`
  or `{"request":null}`, now and whenever that changes. The fingerprint is
  the key's SHA-256 as `ssh-keygen -l` prints it; on the computer:
  `awk '{print $1}' ~/.android/adbkey.pub | base64 -d | openssl dgst -sha256 -binary | base64`.
  The key itself is not handed out or logged.
- `respondAdbAuth {fingerprint, allow, always}`: `allow` lets the host in;
  `always` also adds its key to `/var/lib/adbd/adb_keys` (0600), so it is
  not asked about again. An answer for another key, or for a question no
  longer open, is refused (`NO_SUCH_REQUEST`).

A key is refused without asking while the screen is locked
(luna-displaymanager's `lockStatus`; one that cannot be read counts as
locked), while developer mode is off, for 30 s after the user said no to
it, and when it is not a 2048-bit adb key. A question open when the
screen locks, or not answered in 60 s, is refused.

For ssh (`lib/access.js`), from Developer Options:

- `setDevPassword {password}`: root's password, 8 to 512 characters, set
  with `chpasswd -c SHA512 -s 100000` through its stdin (oe-core's shadow
  has no YESCRYPT). Never logged.
- `clearDevPassword`: no password again (`chpasswd -e`, `root:*`), in the
  same ACG group as `setDevPassword`; works with developer mode off.
- `addAuthorizedKey {key}`: one OpenSSH public key line (Ed25519, ECDSA,
  RSA of 2048 bits or more, or a security key's), without options, added
  to root's `~/.ssh/authorized_keys` (0600, in a 0700 `.ssh`), which sshd
  reads (`AuthorizedKeysFile .ssh/authorized_keys`). Root's home comes from
  the passwd database each time (`os.userInfo()`; `/root` on LuneOS, not
  `/home/root`, which is another directory); when it cannot be told, the
  key methods answer `NO_ROOT_HOME` rather than guess.
  `listAuthorizedKeys` → `{keys:[{type, fingerprint, comment}]}`;
  `removeAuthorizedKey {fingerprint}`.
- `sshOverWifi {enabled}`: `luneos-devmode-firewall ssh-wifi on|off`
  (meta-webos-ports), which keeps the choice in `/var/luna/ssh-wifi-enabled`.
  Turning developer mode off turns it off.
- `getAccessStatus` → `{passwordSet, authorizedKeys, sshOverWifi}`;
  `revokeAdbKeys` forgets every host allowed "always".

Setting a password, adding a key and SSH over Wi-Fi need developer mode
on; taking away does not.

`bin/luneos-ssh-addkey` adds one key read on its stdin the same way
(`lib/access.js`, so the same checks and developer mode on), and prints its
fingerprint; anything but one public key line is refused. meta-webos-ports
links it to `/usr/sbin`, for

    adb shell luneos-ssh-addkey < ~/.ssh/id_ed25519.pub

Node 22
-------
The service is a Node 22 rewrite of the mojoservice one, for the
launcher's plain-node path (`run-js-service` requires the directory, as it
has a `package.json`, and calls `run()`). Foundations and mojoservice are no
longer loaded.

| | |
|---|---|
| `service.js` | start-up: the bus and the methods |
| `lib/devmode.js` | `setStatus` and `getStatus` |
| `lib/adbauth.js` | adbd's key questions |
| `lib/access.js` | root's password, its ssh keys, SSH over Wi-Fi |
| `lib/mojo.js` | the replies as mojoservice gave them (from the contacts.linker) |
| `lib/bus.js`, `lib/errors.js` | the bus, through palmbus (from the contacts.linker, by way of the messaging service) |
| `tests/` | unit tests (`tests/run.sh`), and `tests/vm/`, which records a service's replies and side effects on a device (reached as root over ssh: an image built with `LUNEOS_DEBUG_ACCESS = "1"`, or a key added first, since images no longer let root in without one) |

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
  `android-tools-adbd` started only when `/etc/usb-debugging-enabled` was
  there (`ConditionPathExists` in meta-oe's unit), and that was the one
  `luneos-dev-image.bb` wrote. Turning USB debugging on never started
  adbd, and on a developer image `getStatus` said it was off. The flag
  went to `/etc` for a while (0583a97); it is `/var/usb-debugging-enabled`
  again, and meta-webos-ports now matches: a drop-in for adbd's unit asks
  for `/var/usb-debugging-enabled` and `/var/luna/dev-mode-enabled`, and
  `luneos-dev-image` and `radon-usb-debug` write the `/var` flag. `/etc`
  is the image's: read-only on Halium release images and with OSTree, and
  put back by an update.
- D10: an `/etc/usb-debugging-enabled` from an older image means USB
  debugging was on. When the service starts it writes the `/var` flag,
  starts adbd (developer mode on) and removes the `/etc` one, where `/etc`
  can be written; on a read-only `/etc` it stays, and changes nothing more.
- D9: turning developer mode off left sshd and WAM's DevTools port
  (`--remote-debugging-port=9998`) on, although the old code says "when
  we turn off devmode we also disable all access methods". Now:
  - `sshd.socket` is stopped with developer mode off and started with it
    on; meta-webos-ports gives the socket
    `ConditionPathExists=/var/luna/dev-mode-enabled`, so it stays as set
    across a reboot. A session already open is left to end by itself.
  - `webapp-mgr.sh` passes the DevTools port only while the developer
    mode flag is there. WAM reads it at start, so the service restarts
    `webapp-mgr.service` when developer mode changes (not on a call that
    leaves it as it was, nor on one that failed): open web apps close.

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
