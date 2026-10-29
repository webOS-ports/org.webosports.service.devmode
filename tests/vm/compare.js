// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-2.0-or-later

// node compare.js a.json b.json: every case's reply (text), final flags and the commands run and
// flag files opened or removed (as sorted lists); prints the differences and a count.
'use strict';
const [a, b] = process.argv.slice(2).map(f => require(require('path').resolve(f)));
// What a trace line did, without strace's return values or its <unfinished ...> splits.
const fx = c => (c.trace || []).map(l => {
	let m = /^execve\("[^"]+", \[(.*?)\]/.exec(l);
	if (m) { return 'exec ' + m[1]; }
	m = /^(openat|unlink|unlinkat)\((?:AT_FDCWD, )?"([^"]+)"(?:, ([A-Z_|]+))?/.exec(l);
	return m ? m[1] + ' ' + m[2] + (m[3] ? ' ' + m[3] : '') : l;
}).sort();
let diff = 0, same = 0, raced = [0, 0];
a.cases.forEach((x, i) => {
	const y = b.cases[i];
	const k = ['reply', 'post'].filter(f => JSON.stringify(x[f]) !== JSON.stringify(y[f]));
	if (JSON.stringify(fx(x)) !== JSON.stringify(fx(y))) { k.push('trace'); }
	[x, y].forEach((c, j) => { if (c.stateAtReply && JSON.stringify(c.stateAtReply) !== JSON.stringify(c.post)) { raced[j]++; } });
	if (k.length) {
		diff++;
		console.log(x.method, x.payload || '', JSON.stringify(x.pre), k.join(','));
		for (const f of k) { console.log('   a', JSON.stringify(f === 'trace' ? fx(x) : x[f])); console.log('   b', JSON.stringify(f === 'trace' ? fx(y) : y[f])); }
	} else { same++; }
});
console.log('same ' + same + ' differ ' + diff + '; flags not yet changed at the reply: a ' + raced[0] + ', b ' + raced[1]);
