import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const GEONAMES_USERNAME = 'jeffjose';

export const GET: RequestHandler = async ({ url, setHeaders }) => {
	const query = url.searchParams.get('q');
	if (!query || query.length < 2) {
		return json({ geonames: [] });
	}

	const apiUrl = `https://secure.geonames.org/searchJSON?q=${encodeURIComponent(query)}&maxRows=10&featureClass=P&orderby=population&username=${GEONAMES_USERNAME}&style=medium`;

	const res = await fetch(apiUrl);
	if (!res.ok) {
		return json({ geonames: [] }, { status: 502 });
	}

	const data = await res.json();

	// Set cache headers so CF (or any CDN) caches the response
	setHeaders({
		'Cache-Control': 'public, max-age=86400, s-maxage=86400',
	});

	return json(data);
};
