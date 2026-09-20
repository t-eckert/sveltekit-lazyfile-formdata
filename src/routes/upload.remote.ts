import { form } from '$app/server';
import { getRequestEvent } from '$app/server';

/** File as received, in transit, and after fetch. No validation (`'unchecked'`) to isolate SvelteKit alone. */
export interface Diagnosis {
  constructorName: string;
  instanceofFile: boolean;
  instanceofBlob: boolean;
  prototypeIsFilePrototype: boolean;
  reportedName: string;
  reportedSize: number;
  bytesActuallyReadable: number;
  /** Read straight back out of the FormData, without sending it anywhere. */
  inProcessKind: string;
  /** A genuine File through the same three-argument overload. */
  controlKind: string;
  /** What the receiving service parsed out of the multipart body. */
  receivedKind: string;
  receivedSize: number | null;
  receivedText: string;
  verdict: string;
}

export const upload = form('unchecked', async (data: { file: File }): Promise<Diagnosis> => {
  const file = data.file;
  const { fetch, url } = getRequestEvent();

  // A two-arg append to `FormData` works fine.
  const twoArg = new FormData();
  twoArg.append('file', file);

  // OMG A BUG HERE!!!!
  // A three-arg append (the third argument is the filename) breaks because the filename forces a copy.
  // The copy goes through Node's Blob constructor. The constructor turns anything that's not
  // a genuine blob into a string.
  const threeArg = new FormData();
  threeArg.append('file', file, file.name);

  const kindOf = (fd: FormData) => {
    const v = fd.get('file');
    return typeof v === 'string' ? `string(${v})` : (v?.constructor?.name ?? '<null>');
  };

  const inProcessKind = `2-arg: ${kindOf(twoArg)} | 3-arg: ${kindOf(threeArg)}`;

  const send = async (body: FormData) => {
    const response = await fetch(new URL('/sink', url), { method: 'POST', body });
    return (await response.json()) as { kind: string; size: number | null; text: string };
  };

  // The control: a genuine File through the same three-argument overload. If
  // this survives and the one above does not, the overload is innocent and the
  // value SvelteKit supplied is the difference.
  const controlBytes = await file.arrayBuffer();
  const control = new FormData();
  control.append('file', new File([controlBytes], file.name, { type: file.type }), file.name);

  const two = await send(twoArg);
  const received = await send(threeArg);
  const real = await send(control);

  return {
    constructorName: file.constructor?.name ?? '<none>',
    instanceofFile: file instanceof File,
    instanceofBlob: file instanceof Blob,
    prototypeIsFilePrototype: Object.getPrototypeOf(file) === File.prototype,
    reportedName: file.name,
    reportedSize: file.size,
    bytesActuallyReadable: (await file.arrayBuffer()).byteLength,
    inProcessKind,
    receivedKind: received.kind,
    receivedSize: received.size,
    receivedText: received.text,
    controlKind: `${real.kind}, ${real.size} bytes`,
    verdict:
      received.size !== file.size && two.size === file.size && real.size === file.size
        ? `BUG. Sent ${file.size} bytes. Two-argument append: ${two.size} bytes, intact. Three-argument append: ${received.size} bytes reading "${received.text}". A real File through the same three-argument overload: ${real.size} bytes, intact — so the overload is fine and the value SvelteKit hands the handler is not.`
        : received.size === file.size
          ? `No bug observed: every route arrived at ${file.size} bytes.`
          : `Unexpected: 2-arg ${two.size}, 3-arg ${received.size}, real File ${real.size}, sent ${file.size}.`
  };
});
