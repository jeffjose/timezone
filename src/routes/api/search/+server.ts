import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

interface NominatimResult {
	name: string;
	display_name: string;
	lat: string;
	lon: string;
	address?: {
		country?: string;
		country_code?: string;
		state?: string;
		city?: string;
		town?: string;
		village?: string;
	};
}

interface PlaceResult {
	name: string;
	country: string;
	timezone: string;
}

export const GET: RequestHandler = async ({ url, setHeaders }) => {
	const query = url.searchParams.get('q');
	if (!query || query.length < 2) {
		return json({ results: [] });
	}

	try {
		// Step 1: Geocode with Nominatim
		const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1&accept-language=en`;
		const geoRes = await fetch(nominatimUrl, {
			headers: { 'User-Agent': 'timezone-app/1.0' },
		});

		if (!geoRes.ok) {
			return json({ results: [] }, { status: 502 });
		}

		const places: NominatimResult[] = await geoRes.json();
		if (places.length === 0) {
			return json({ results: [] });
		}

		// Step 2: Get timezone for each unique lat/lon
		const results: PlaceResult[] = [];
		const seen = new Set<string>();

		for (const place of places) {
			try {
				const tzRes = await fetch(
					`https://timeapi.io/api/timezone/coordinate?latitude=${place.lat}&longitude=${place.lon}`
				);
				if (!tzRes.ok) continue;

				const tzData = await tzRes.json();
				const timezone = tzData.timeZone;
				if (!timezone) continue;

				const name = place.address?.city || place.address?.town || place.address?.village || place.name;
				const country = place.address?.country || '';
				const key = `${name}-${timezone}`;
				if (seen.has(key)) continue;
				seen.add(key);

				results.push({ name, country, timezone });
			} catch {
				continue;
			}
		}

		setHeaders({
			'Cache-Control': 'public, max-age=86400, s-maxage=86400',
		});

		return json({ results });
	} catch {
		return json({ results: [] }, { status: 500 });
	}
};
