import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Stands in for the service a backend-for-frontend forwards an upload to.
 *
 * It does nothing clever: it parses the multipart body it was sent and reports
 * what the file part actually contained. Being in the same app keeps the repro
 * to one process; a separate service behaves identically, which is how this was
 * found.
 */
export const POST: RequestHandler = async ({ request }) => {
	const received = await request.formData();
	const part = received.get('file');

	if (typeof part === 'string') {
		return json({ kind: 'string', size: part.length, text: part });
	}

	if (!part) return json({ kind: 'missing', size: null, text: '' });

	return json({ kind: part.constructor?.name ?? 'Blob', size: part.size, text: await part.text() });
};
