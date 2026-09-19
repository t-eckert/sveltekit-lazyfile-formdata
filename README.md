# `FormData.append(name, file, filename)` silently replaces a remote form's file with `[object Object]`

`@sveltejs/kit@3.0.0-next.25`, `undici` via Node 22.23.2.

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

## Suggested fix

Make the value a real `Blob` subclass so the WebIDL conversion accepts it. If it
must stay lazy, throwing on a failed conversion would be far better than silent
coercion — the current behaviour is indistinguishable from a successful upload.

A `LazyFile` that lies to `instanceof` but not to the platform is the underlying
hazard, and this overload is one way it shows up rather than the only one.
