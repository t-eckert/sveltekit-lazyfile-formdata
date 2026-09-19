<script lang="ts">
	import { upload } from './upload.remote';

	const result = $derived(upload.result);
</script>

<h1>A remote form's <code>File</code> is silently replaced with <code>[object Object]</code> when appended to a <code>FormData</code> with a filename</h1>

<p>
	Pick any small text file and submit. The handler appends the file it was given to a new
	<code>FormData</code> and forwards it with <code>fetch</code> to an endpoint in this
	same app, which reports what actually arrived.
</p>

<form {...upload} enctype="multipart/form-data">
	<p><input {...upload.fields.file.as('file')} /></p>
	<p><button type="submit">Submit (enhanced, with JavaScript)</button></p>
</form>

{#if result}
	<h2>{result.verdict}</h2>
	<table>
		<tbody>
			<tr><td>constructor</td><td>{result.constructorName}</td></tr>
			<tr><td>instanceof File</td><td>{result.instanceofFile}</td></tr>
			<tr><td>instanceof Blob</td><td>{result.instanceofBlob}</td></tr>
			<tr><td>prototype === File.prototype</td><td>{result.prototypeIsFilePrototype}</td></tr>
			<tr><td>reported name</td><td>{result.reportedName}</td></tr>
			<tr><td>reported size</td><td>{result.reportedSize}</td></tr>
			<tr><td>bytes readable via arrayBuffer()</td><td>{result.bytesActuallyReadable}</td></tr>
			<tr><td>read back out of the FormData</td><td>{result.inProcessKind}</td></tr>
			<tr><td>control: a real File, 3-arg append</td><td>{result.controlKind}</td></tr>
			<tr><td><strong>what the receiving service got</strong></td><td><strong>{result.receivedKind}</strong></td></tr>
			<tr><td>its size</td><td>{result.receivedSize ?? '(none)'}</td></tr>
			<tr><td>its content</td><td><code>{result.receivedText}</code></td></tr>
		</tbody>
	</table>
{/if}

<style>
	td { padding: 0.15rem 0.75rem 0.15rem 0; vertical-align: top; }
	h2 { font-size: 1rem; }
</style>
