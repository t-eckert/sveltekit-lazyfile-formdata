# `FormData.append(name, file, filename)` silently replaces a remote form's file with `[object Object]`

Reproduced on `@sveltejs/kit@3.0.0-next.27` (and `next.25`), `undici` via Node 22.23.2.

## Summary

A remote `form` handler is handed an upload that passes `instanceof File`. Append
it to a `FormData` using the three-argument overload — the one a caller reaches
for to preserve the filename — and forward that body with `fetch`, and the
receiving service gets a well-formed multipart part with the right filename and
content type whose body is the 15-byte string `[object Object]`.

Nothing throws and nothing warns.

```js
// Fine.
body.append('file', file);

// Silently replaces the content with "[object Object]".
body.append('file', file, file.name);
```

A genuine `File` through the same three-argument overload is unaffected, so the
overload is not the problem — the value SvelteKit supplies is.

## Cause

`src/runtime/form-utils.js` rebuilds each upload from SvelteKit's binary form
encoding as a `LazyFile`: a plain class that duck-types the File API and extends
neither `File` nor `Blob`. It is returned wrapped in a `Proxy`:

```js
return new Proxy(new LazyFile(name, type, size, last_modified, get_chunk, offset), {
	getPrototypeOf() {
		// Trick validators into thinking this is a normal File
		return File.prototype;
	}
});
```

The proxy makes `instanceof File` and `instanceof Blob` true, which is what the
comment intends, and schema validators accept it.

Passing three arguments to `FormData.append` selects the
`append(name, Blob, filename)` overload. undici then runs the WebIDL `Blob`
conversion on the value, which does not consult the prototype chain. The proxy
fails that conversion, falls through to string coercion, and undici wraps the
resulting `"[object Object]"` in a new `File` carrying the filename that was
asked for.

So the two-argument form stores the object as-is and serialises it correctly,
while the three-argument form destroys it — and produces something that looks
more correct than the version that works, because it has the filename on it.

## Reproduce

```sh
pnpm install
pnpm dev
```

Open http://127.0.0.1:5199, choose any small text file, submit. The handler
appends the same file three ways, forwards each with `fetch` to `/sink` in this
app, and reports what arrived.

Observed with a 10-byte file:

| route | arrived as |
| --- | --- |
| `append(name, file)` | `File`, 10 bytes, intact |
| `append(name, file, file.name)` | `File`, **15 bytes**, `[object Object]` |
| control: real `File`, `append(name, real, name)` | `File`, 10 bytes, intact |

`/sink/+server.ts` is an ordinary endpoint doing `await request.formData()`. A
separate service behaves identically; that is how this was found.

## Why it is worth fixing rather than documenting

The three-argument overload is the natural thing to write when forwarding an
upload, because the filename matters to whatever receives it. Every layer
downstream then accepts the result: the multipart is well formed, the filename
and type are right, only the bytes are wrong.

In the application where this surfaced, a writer's manuscript was stored,
text-extracted, indexed and acknowledged by email as 15 bytes reading
`[object Object]`. The API, the conversion job and the mailer all reported
success. The only way to notice was to read the row in the database.

## The prototype lie is what makes it silent

Without the proxy, undici refuses the value outright on the three-argument path:

```
TypeError: Failed to execute 'append' on 'FormData': parameter 2 is not of type 'Blob'
```

The proxy gets the value past that type check, and undici then coerces what it
could not convert. So the trick turns an immediate, accurate `TypeError` into
silent data loss. That is the heart of the report.

## Suggested fix

`node fixes.mjs` walks the mechanism and three candidates with no SvelteKit and
no server involved.

**Subclassing `Blob`/`File` does not work**, which is the non-obvious part. A real
`File` subclass constructed with `super([])` and overriding `size` and `stream()`
passes every type check and still fails: the three-argument path reads the blob's
internal slots rather than calling `stream()`, so the part is written **empty**.
That is worse than the current bug, because `[object Object]` is at least a
marker and an empty part is not.

**Refusing string coercion works, and keeps everything else.** Give the value a
`Symbol.toPrimitive` that throws:

```js
[Symbol.toPrimitive]() {
	throw new TypeError(
		'A file from a remote form cannot be converted to a string. It was probably ' +
			'passed to FormData.append() with a filename argument; omit the filename.'
	);
}
```

The two-argument path is unchanged and still lazy, validators are still
satisfied, and the three-argument path now fails loudly with a message naming the
cause. It restores the error the proxy suppressed, without giving the proxy up.

**Constructing the file eagerly** also works and gives up the laziness the type
exists for.

## A second, separate bug worth noting

That `File` subclass result is its own finding: in undici, a `Blob` subclass that
implements laziness by overriding `stream()` is silently emptied when appended
with a filename. Subclassing `Blob` is unsound on that path for anyone, not just
SvelteKit. It may deserve its own report against Node.

## Prior art

The `getPrototypeOf` trick is there on purpose, and #15018 is why: a `LazyFile`
without it failed `zod`'s `z.file()`. That issue is about the proxy not being
convincing *enough* — under Bun, `instanceof` still failed — and it was closed as
a Bun bug.

This report is the other side of the same design. The proxy convinces a
validator and does not convince undici's WebIDL `Blob` conversion, so the value
passes a type check and then loses its contents when handed to a platform API.

Two other `LazyFile` issues are adjacent and neither covers this: #16116
(`stream()` failing on the Cloudflare adapter for larger files) and #17147
(binary form file metadata accepting invalid sizes).
