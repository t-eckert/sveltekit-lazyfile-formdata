/**
 * The mechanism, and three candidate fixes, with no SvelteKit in the way.
 *
 *   node fixes.mjs
 *
 * Everything here is plain Node: the value SvelteKit hands a remote `form`
 * handler is reconstructed by hand, so the behaviour can be seen without a
 * server and without a browser.
 */
const CONTENT = 'abcdefghij'; // 10 bytes

const lazyStream = () =>
	new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode(CONTENT));
			c.close();
		}
	});

/** The duck-typed lazy file, as `LazyFile` is shaped. */
const duck = () => ({
	name: 'x.txt',
	type: 'text/plain',
	size: CONTENT.length,
	lastModified: 0,
	stream: lazyStream,
	arrayBuffer: async () => await new Response(lazyStream()).arrayBuffer(),
	text: async () => CONTENT
});

/** The prototype lie that makes `instanceof File` true. */
const lying = (target) => new Proxy(target, { getPrototypeOf: () => File.prototype });

async function probe(label, value) {
	for (const threeArg of [false, true]) {
		const fd = new FormData();
		try {
			if (threeArg) fd.append('f', value, value.name);
			else fd.append('f', value);
		} catch (e) {
			console.log(`  ${label.padEnd(26)} ${threeArg ? '3-arg' : '2-arg'}  THREW  ${e.constructor.name}`);
			continue;
		}
		const raw = await new Response(fd).text();
		const state = raw.includes(CONTENT)
			? 'intact'
			: raw.includes('[object Object]')
				? 'CORRUPT: "[object Object]"'
				: 'CORRUPT: empty, no marker';
		console.log(`  ${label.padEnd(26)} ${threeArg ? '3-arg' : '2-arg'}  ${state}`);
	}
}

console.log(`node ${process.version}, 10-byte payload, serialised the way fetch would\n`);

console.log('The bug');
await probe('plain object', duck());
await probe('+ prototype lie (current)', lying(duck()));
await probe('real File', new File([CONTENT], 'x.txt', { type: 'text/plain' }));

console.log('\nWhy the prototype lie matters: without it, undici refuses the value');
console.log('outright on the 3-arg path. With it, the value gets past the type');
console.log('check and is then coerced to a string.\n');

console.log('Candidate 1 — a real File subclass, lazy via overrides');
class LazySubclass extends File {
	#size;
	constructor(name, type, size) {
		super([], name, { type });
		this.#size = size;
	}
	get size() {
		return this.#size;
	}
	stream() {
		return lazyStream();
	}
	async arrayBuffer() {
		return await new Response(this.stream()).arrayBuffer();
	}
	async text() {
		return CONTENT;
	}
}
await probe('File subclass', new LazySubclass('x.txt', 'text/plain', CONTENT.length));
console.log('  -> Does not work. The 3-arg path reads the Blob\'s internal slots');
console.log('     rather than calling stream(), so the override is ignored and the');
console.log('     part is written empty. Worse than the current bug: no marker.\n');

console.log('Candidate 2 — keep the value lazy, refuse string coercion');
const guarded = lying(
	Object.assign(duck(), {
		[Symbol.toPrimitive]() {
			throw new TypeError(
				'A file from a remote form cannot be converted to a string. It was probably ' +
					'passed to FormData.append() with a filename argument; omit the filename.'
			);
		}
	})
);
await probe('+ Symbol.toPrimitive guard', guarded);
console.log('  -> Works. The 2-arg path is unchanged and still lazy, validators are');
console.log('     still satisfied, and the 3-arg path fails loudly with a message');
console.log('     naming the cause instead of silently shipping 15 bytes.\n');

console.log('Candidate 3 — construct the file eagerly');
await probe('eager File', new File([CONTENT], 'x.txt', { type: 'text/plain' }));
console.log('  -> Works everywhere and gives up the laziness the type exists for.');
