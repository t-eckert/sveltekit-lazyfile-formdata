# A remote form's `File` is silently replaced with `[object Object]` when appended to a `FormData` with a filename

> Reproduced on `@sveltejs/kit@3.0.0-next.27` (and `next.25`) under Node 22.23.2 (`undici@6.28.0`) and Node 24.21.0 (`undici@7.29.1`).

## Summary

A remote `form` handler is handed an upload that passes `instanceof File`. Append it to a `FormData` using the three-argument overload. Forward that body with `fetch`, and the receiving service gets a well-formed multipart part with the right filename and content type whose body is the 15-byte string `[object Object]`.

Nothing throws and nothing warns.

```js
// Works as expected.
body.append('file', file);

// Silently replaces the content with "[object Object]".
body.append('file', file, file.name);
```

`FormData.set(name, file, filename)` and `new Blob([file])` destroy the contents the same way.

A genuine `File` through the same three-argument overload is unaffected, so the overload is not the problem. The value SvelteKit supplies is.

## Only enhanced submissions are affected

The value only exists on one path: a remote `form` submitted by client-side
JavaScript. The enhanced client serialises the submission with SvelteKit's
binary encoding under the content type `application/x-sveltekit-formdata`, and
`deserialize_binary_form` rebuilds each upload as a `LazyFile` so its bytes can
stream from the request body on demand. When the content type is anything else,
the same function falls back to `request.formData()`, which returns undici's
genuine `File`.

Measured on the same form in this repro, submitted as plain multipart with no
JavaScript: the handler receives a `File` and every route arrives intact.
Form actions in `+page.server.ts`, with or without `use:enhance`, call
`request.formData()` themselves and are not affected either.

That is part of why it hid. The same form behaves correctly the moment
JavaScript is off.

## Cause

`src/runtime/form-utils.js` rebuilds each upload from SvelteKit's binary form encoding as a `LazyFile`: a plain class that duck-types the File API and extends neither `File` nor `Blob`. It is returned wrapped in a `Proxy`:

```js
return new Proxy(new LazyFile(name, type, size, last_modified, get_chunk, offset), {
	getPrototypeOf() {
		// Trick validators into thinking this is a normal File
		return File.prototype;
	}
});
```

The proxy makes `instanceof File` and `instanceof Blob` true, which is what the comment intends, and schema validators accept it.

Four steps follow, and the third is the one that matters.

1. **Passing three arguments selects the `append(name, Blob, filename)`
   overload.** undici's WebIDL `Blob` check is the duck-typed `isBlobLike`, which
   starts with `value instanceof Blob`. The prototype lie satisfies it, and the
   conversion succeeds.

2. **undici's `makeEntry` then decides how to store the value.** `isFileLike`
   is also satisfied by the lie, so the value is not wrapped in undici's own
   `FileLike` at this point.

3. **`makeEntry` branches on `value instanceof NativeFile`, and the lie selects
   the destructive branch.** From the undici bundled in Node 22.23.2:

   ```js
   if (filename !== void 0) {
     const options = { type: value.type, lastModified: value.lastModified };
     value = value instanceof NativeFile
       ? new File([value], filename, options)
       : new FileLike(value, filename, options);
   }
   ```

   So the proxy is not merely getting past a guard. It is choosing the path
   that loses the data. Without the lie, a value that reaches this point is
   routed to `FileLike`, which delegates to `stream()` and works.

   undici 7, bundled with Node 24, has no `FileLike` route at all. Its
   `makeEntry` checks `webidl.is.File(value)`, which the proxy passes, and then
   calls `new File([value], filename, options)` unconditionally. The
   destructive branch is the only branch, and the result is the same.

4. **Node's `Blob` constructor brand-checks each part.** `getSource` in
   `internal/blob` accepts a part as a blob only if `isBlob(source)` holds,
   which reads a private `kHandle` symbol no `Proxy` can fake. The part is not
   an `ArrayBuffer` or a view either, so it falls through to `` `${source}` ``,
   which is `"[object Object]"`. That string is wrapped in a `File` carrying
   the requested filename.

So the two-argument form stores the proxied object as-is and streams it
correctly, while the three-argument form destroys it, and produces something
that looks more correct than the version that works because it has the
filename on it.

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

`node fixes.mjs` reproduces the mechanism with no SvelteKit and no server
involved, and walks the candidate fixes below.

## Why it is worth fixing rather than documenting

The three-argument overload is the natural thing to write when forwarding an
upload, because the filename matters to whatever receives it. Every layer
downstream then accepts the result: the multipart is well formed, the filename
and type are right, only the bytes are wrong.

In the application where this surfaced, a writer's manuscript was stored,
text-extracted, indexed and acknowledged by email as 15 bytes reading
`[object Object]`. The API returned 201, the conversion job marked the row
ready with a word count of two, and the mailer sent the confirmation. The only
way to notice was to read the row in the database.

## The prototype lie is what makes it silent

Without the proxy, undici refuses the bare `LazyFile` outright on the
three-argument path:

```
TypeError: Failed to execute 'append' on 'FormData': parameter 2 is not of type 'Blob'
```

The proxy gets the value past that type check, and then, at step 3 above,
steers it into the one branch that hands it to Node's `Blob` constructor. So
the trick turns an immediate, accurate `TypeError` into silent data loss. That
is the heart of the report.

## How wide the problem is

`FormData.append` with a filename is not the only path. Every platform API that
brand-checks was tried; three of them lose the contents silently, and all three
lose them the same way, by falling back to string coercion.

| path | result |
| --- | --- |
| `FormData.append(name, file)` | intact |
| `FormData.append(name, file, filename)` | **`[object Object]`** |
| `FormData.set(name, file, filename)` | **`[object Object]`** |
| `new Blob([file])` | **`[object Object]`** |
| `new Response(file)` | intact |
| `fetch(url, { body: file })` | intact |
| `structuredClone(file)` | throws, loudly |

`new Blob([file])` matters on its own: re-wrapping or concatenating an upload is
an ordinary thing to do, and it corrupts with no warning.

## The working path is only sound on Node

The two-argument form is not correct in general. It is correct on Node, because
undici is willing to duck-type. Measured with the same proxied value on each
runtime:

| runtime | `instanceof File` | `append(n, f)` | `append(n, f, name)` | `set(n, f, name)` | `new Blob([f])` |
| --- | --- | --- | --- | --- | --- |
| Node 22.23.2 | true | **intact** | `[object Object]` | `[object Object]` | `[object Object]` |
| Node 24.21.0 | true | **intact** | `[object Object]` | `[object Object]` | `[object Object]` |
| Bun 1.4.2 | false | **`[object Object]`** | throws | throws | `[object Object]` |
| Deno 2.9.6 | true | throws | throws | throws | throws |

On Bun the two-argument path corrupts silently. On Deno a `LazyFile` cannot
enter a `FormData` at all. Bun also refuses the prototype lie outright, which is
the same wall #15018 hit. An application that forwards uploads from a remote
`form` handler does not move off `adapter-node` without re-testing them byte
for byte.

The Node 24 row was also confirmed end to end: this repro, run under Node
24.21.0 and sent a genuine enhanced submission built with kit's own
`serialize_binary_form`, reports the same 15 bytes.

## Suggested fix

`node fixes.mjs` walks the mechanism and the candidates below in plain Node.

**Subclassing `Blob`/`File` does not work**, which is the non-obvious part. A real
`File` subclass constructed with `super([])` and overriding `size` and `stream()`
passes every type check and still fails. Node's `getSource` returns
`[source.size, source[kHandle]]` for a genuine blob, so the overridden `size`
and the empty handle disagree, `stream()` is never called, and the part is
written **empty**. That is worse than the current bug, because `[object Object]`
is at least a marker and an empty part is not. Making the value a genuine lazy
`Blob` is therefore not possible: the internal slots *are* the data.

**Refusing string coercion works, and keeps everything else.** Give `LazyFile` a
`Symbol.toPrimitive` that throws:

```js
[Symbol.toPrimitive]() {
	throw new TypeError(
		`Cannot convert the file "${this.name}" to a string. If you passed it to ` +
			'`FormData.append()` with a filename argument, omit the filename — the file ' +
			'already carries its own.'
	);
}
```

The two-argument path is unchanged and still lazy, validators are still
satisfied, and all three silent paths above now fail loudly with a message
naming the cause, because all three fail by coercing to a string. It restores
the error the proxy suppressed, without giving the proxy up.

It closes the failure mode, not the cause. `LazyFile` still is not a `Blob` and
still says it is. A path that fails by reading internal slots rather than
coercing, like the subclass case, would still produce empty output. No such
path is known for the value SvelteKit ships today.

A patch with a test that fails without it is on
[`t-eckert/kit`, branch `fix/lazyfile-refuses-string-coercion`](https://github.com/t-eckert/kit/tree/fix/lazyfile-refuses-string-coercion),
off `3.0.0-next.27`.

**No shape of proxy can make the filename path work.** The filename branch of
`makeEntry` ends in `new File([value], filename)` on every undici version, and
Node's `Blob` constructor accepts a part as a blob only if it carries the
private handle the bytes live in. A `Proxy` can fake a prototype and any
property it knows about; it cannot supply a handle. So on that branch the proxy
can only choose between a `TypeError` and a coerced string. Measured with a
10-byte file:

| variant | `instanceof File` | 2-arg, Node 22 | 3-arg, Node 22 | 2-arg, Node 24 | 3-arg, Node 24 |
| --- | --- | --- | --- | --- | --- |
| current proxy | true | intact | `[object Object]` | intact | `[object Object]` |
| proxy plus `Symbol.toStringTag = 'File'` | true | intact | `[object File]` | intact | `[object File]` |
| no proxy, `Symbol.toStringTag = 'File'` only | false | intact | intact | `[object File]` | throws |
| proxy with a `get` trap hiding unknown symbols | true | intact | `[object Object]` | intact | `[object Object]` |
| real eager `File` | true | intact | intact | intact | intact |

**Dropping the proxy and declaring `Symbol.toStringTag = 'File'` instead** works
on Node 22 only, on both `append` paths, because undici 6 routes the value to
`FileLike`. undici 7 removed that route, so on Node 24 the same value corrupts
the two-argument path that works today. It also makes `instanceof File` false,
which re-breaks the validators the proxy exists for, and it is empty on Deno
and throws on Bun. It is not an option.

**Constructing the file eagerly** is the only variant that survives everywhere,
and it gives up the laziness the type exists for. There is a fair argument for
it: the non-enhanced path is already eager, because `request.formData()` reads
the whole body into memory, so SvelteKit already buffers the same form when
JavaScript is off. The argument against is that `LazyFile` exists precisely so
that large uploads on memory-limited runtimes do not have to be buffered, and
#16116 shows Cloudflare users depending on that.

The structural choice is therefore between buffering and being a real `File`,
or stopping the pretence and exposing a distinct type with an explicit
`.blob()`, which is a breaking change. That is the maintainers' call. The
`Symbol.toPrimitive` guard is the fix that can land without making it.

## A second, separate bug worth noting

That `File` subclass result is its own finding: in undici on Node, a `Blob`
subclass that implements laziness by overriding `stream()` is silently emptied
when appended with a filename. Subclassing `Blob` is unsound on that path for
anyone, not just SvelteKit.

Together with step 4 above, that suggests two reports rather than one:
SvelteKit for handing out a value that lies about its prototype, and Node's
`undici` for accepting a value on the strength of that lie and then losing its
bytes, which is where the silent loss actually lives. The undici half is
sharpest on version 7: `webidl.is.File` admits the proxy, and `makeEntry` then
hands it to a Node constructor that does not. The check that lets the value in
and the constructor that consumes it disagree about what a `File` is, and the
bytes are lost in the gap.

## Prior art

The `getPrototypeOf` trick is there on purpose, and #15018 is why: a `LazyFile`
without it failed `zod`'s `z.file()`. That issue is about the proxy not being
convincing *enough*; under Bun, `instanceof` still failed, and it was closed as
a Bun bug.

This report is the other side of the same design. The proxy convinces a
validator, convinces undici's type check, and convinces undici's `makeEntry`
that the value is a native `File`. It cannot convince Node's `Blob`
constructor, which is the one place the bytes are actually read, so the value
passes every check and then loses its contents.

Two other `LazyFile` issues are adjacent and neither covers this: #16116
(`stream()` failing on the Cloudflare adapter for larger files) and #17147
(binary form file metadata accepting invalid sizes).
