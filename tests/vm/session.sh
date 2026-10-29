#!/bin/sh
# Copyright (c) 2026 Herman van Hazendonk
# SPDX-License-Identifier: GPL-3.0-or-later
# session.sh <label> [new]: back up stock and the flags, optionally install the new service,
# run drive.js, then put stock and the flags back exactly. Run under the VM lock.
set -eu
R=/home/root/rewrites/devmode
T=/usr/palm/services/org.webosports.service.devmode
mkdir -p $R/state
[ -d $R/stock ] || cp -a $T $R/stock
# flags as found (cp -a keeps mode and times)
rm -f $R/state/*
for f in /var/luna/dev-mode-enabled /etc/usb-debugging-enabled; do
	[ -e $f ] && cp -a $f $R/state/ || true
done
ls -la --full-time $R/state/ > $R/state.before
# The service's own node processes (not a shell or ssh whose command line names it).
pids() {
	for p in /proc/[0-9]*; do
		[ "$(readlink "$p/exe" 2>/dev/null)" = /usr/bin/node ] || continue
		c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
		case "$c" in *drive.js*) ;; *org.webosports.service.devmode*) echo "${p#/proc/}" ;; esac
	done
}
# Ask whichever is running to leave (mojoservice's __quit, the bus's quit) until none is. A call
# made just as one leaves starts another, which the next round asks again; one still there after
# ten rounds is killed.
quit() {
	i=0
	while [ -n "$(pids)" ] && [ $i -lt 10 ]; do
		sleep 1 | luna-send -n 1 -w 3000 luna://org.webosports.service.devmode/__quit '{}' >/dev/null 2>&1 || true
		sleep 1 | luna-send -n 1 -w 3000 luna://org.webosports.service.devmode/quit '{}' >/dev/null 2>&1 || true
		sleep 2
		i=$((i + 1))
	done
	for p in $(pids); do echo "killing $p"; kill "$p"; done
	sleep 1
}
if [ "${2:-}" = new ]; then
	quit
	rm -rf $T; cp -a $R/new $T
fi
quit
node $R/drive.js "$R/$1.json" || echo "drive failed"
quit
rm -rf $T; cp -a $R/stock $T
for f in dev-mode-enabled usb-debugging-enabled; do
	d=/etc; [ $f = dev-mode-enabled ] && d=/var/luna
	rm -f $d/$f
	[ -e $R/state/$f ] && cp -a $R/state/$f $d/$f || true
done
ls -la --full-time /var/luna/dev-mode-enabled /etc/usb-debugging-enabled 2>&1
echo "restored stock"
