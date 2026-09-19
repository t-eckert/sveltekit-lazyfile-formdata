/**
 * The same endpoint, reached the way a browser with no JavaScript reaches it.
 *
 * The enhanced path serialises the form with SvelteKit's own binary encoding and
 * the server rebuilds each file as a `LazyFile`. A native submit sends ordinary
 * multipart, which the server parses into a real `File`. So this script is the
 * control: if it reports OK while the browser reports BUG, the divergence is in
 * the binary encoding rather than in the handler.
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:5199';

const page = await fetch(BASE).then((r) => r.text());

const action = page.match(/<form[^>]*\saction="([^"]+)"/)?.[1];
const field = page.match(/<input[^>]*\sname="([^"]+)"[^>]*type="file"/)?.[1]
	?? page.match(/<input[^>]*type="file"[^>]*\sname="([^"]+)"/)?.[1];

if (!action || !field) {
	console.error('Could not find the form action or the file field in the page.');
    console.error('action:', action, 'field:', field);
	process.exit(1);
}

const body = new FormData();
body.append(field, new File(['abcdefghij'], 'ten-bytes.txt', { type: 'text/plain' }));

const response = await fetch(new URL(action, BASE), { method: 'POST', body, redirect: 'follow' });
const html = await response.text();

const verdict = html.includes('BUG:') ? 'BUG' : html.includes('OK:') ? 'OK' : 'no verdict rendered';
const appended = html.match(/<strong>(string|File|Blob|&lt;null&gt;)<\/strong>/)?.[1] ?? '?';

console.log(`native multipart POST -> HTTP ${response.status}`);
console.log(`  form action:            ${action}`);
console.log(`  file field name:        ${field}`);
console.log(`  appended back out as:   ${appended}`);
console.log(`  verdict:                ${verdict}`);
