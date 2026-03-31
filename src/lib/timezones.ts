// All IANA timezones with friendly labels
export interface TimezoneInfo {
	id: string;
	label: string;
	city: string;
	region: string;
}

// Get all supported timezones from the browser
export function getAllTimezones(): TimezoneInfo[] {
	const zones = Intl.supportedValuesOf('timeZone');
	return zones.map((id) => {
		const parts = id.split('/');
		const city = (parts[parts.length - 1] || id).replace(/_/g, ' ');
		const region = parts[0] || '';
		return { id, label: city, city, region };
	});
}

export function getTimezoneOffset(tz: string, date: Date = new Date()): number {
	const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
	const tzDate = new Date(date.toLocaleString('en-US', { timeZone: tz }));
	return (tzDate.getTime() - utcDate.getTime()) / (1000 * 60);
}

export function getTimezoneAbbr(tz: string, date: Date = new Date()): string {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		timeZoneName: 'short',
	});
	const parts = formatter.formatToParts(date);
	const tzPart = parts.find((p) => p.type === 'timeZoneName');
	return tzPart?.value || '';
}

export function formatOffset(minutes: number): string {
	const sign = minutes >= 0 ? '+' : '-';
	const abs = Math.abs(minutes);
	const h = Math.floor(abs / 60);
	const m = abs % 60;
	return `UTC${sign}${h}${m > 0 ? ':' + String(m).padStart(2, '0') : ''}`;
}

export function getHourInTimezone(tz: string, baseDate: Date, hour: number): { hour: number; minute: number; isNextDay: boolean; isPrevDay: boolean } {
	// Create a date at the given hour in UTC, then convert
	const d = new Date(baseDate);
	d.setHours(hour, 0, 0, 0);

	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hour: 'numeric',
		minute: 'numeric',
		hour12: false,
		day: 'numeric',
	});

	const parts = formatter.formatToParts(d);
	const hourPart = parseInt(parts.find((p) => p.type === 'hour')?.value || '0');
	const minutePart = parseInt(parts.find((p) => p.type === 'minute')?.value || '0');
	const dayPart = parseInt(parts.find((p) => p.type === 'day')?.value || '0');
	const baseDay = baseDate.getDate();

	return {
		hour: hourPart,
		minute: minutePart,
		isNextDay: dayPart > baseDay,
		isPrevDay: dayPart < baseDay,
	};
}

// Returns time-of-day tier for shading:
// 'night'   = 10 PM - 6 AM  (sleep)
// 'evening' = 6-8 AM, 6-10 PM (early morning / evening)
// 'work'    = 9 AM - 5 PM (work hours)
// 'day'     = 8-9 AM, 5-6 PM (shoulder hours)
export type DayTier = 'night' | 'evening' | 'work' | 'day';

export function getDayTier(hour: number): DayTier {
	if (hour >= 22 || hour < 6) return 'night';
	if (hour >= 6 && hour < 8) return 'evening';
	if (hour >= 20 && hour < 22) return 'evening';
	if (hour >= 9 && hour < 17) return 'work';
	return 'day'; // 8-9 AM, 5-8 PM
}

export function isNightHour(hour: number): boolean {
	return hour >= 22 || hour < 6;
}

export function getCurrentHourInTimezone(tz: string): number {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hour: 'numeric',
		hour12: false,
	});
	return parseInt(formatter.format(new Date()));
}

// Map of cities/places to their IANA timezone
// This lets users search for cities that aren't in the IANA timezone database directly
const CITY_TO_TIMEZONE: Record<string, string> = {
	// US
	'mountain view': 'America/Los_Angeles',
	'san francisco': 'America/Los_Angeles',
	'san jose': 'America/Los_Angeles',
	'palo alto': 'America/Los_Angeles',
	'sunnyvale': 'America/Los_Angeles',
	'cupertino': 'America/Los_Angeles',
	'santa clara': 'America/Los_Angeles',
	'redwood city': 'America/Los_Angeles',
	'menlo park': 'America/Los_Angeles',
	'fremont': 'America/Los_Angeles',
	'oakland': 'America/Los_Angeles',
	'berkeley': 'America/Los_Angeles',
	'seattle': 'America/Los_Angeles',
	'portland': 'America/Los_Angeles',
	'san diego': 'America/Los_Angeles',
	'sacramento': 'America/Los_Angeles',
	'las vegas': 'America/Los_Angeles',
	'austin': 'America/Chicago',
	'dallas': 'America/Chicago',
	'houston': 'America/Chicago',
	'san antonio': 'America/Chicago',
	'nashville': 'America/Chicago',
	'minneapolis': 'America/Chicago',
	'milwaukee': 'America/Chicago',
	'new orleans': 'America/Chicago',
	'st louis': 'America/Chicago',
	'kansas city': 'America/Chicago',
	'miami': 'America/New_York',
	'atlanta': 'America/New_York',
	'boston': 'America/New_York',
	'philadelphia': 'America/New_York',
	'washington': 'America/New_York',
	'washington dc': 'America/New_York',
	'baltimore': 'America/New_York',
	'charlotte': 'America/New_York',
	'pittsburgh': 'America/New_York',
	'orlando': 'America/New_York',
	'tampa': 'America/New_York',
	'cleveland': 'America/New_York',
	'columbus': 'America/New_York',
	'raleigh': 'America/New_York',
	'durham': 'America/New_York',
	'brooklyn': 'America/New_York',
	'manhattan': 'America/New_York',
	'queens': 'America/New_York',
	'jersey city': 'America/New_York',
	'newark': 'America/New_York',
	'denver': 'America/Denver',
	'salt lake city': 'America/Denver',
	'albuquerque': 'America/Denver',
	'colorado springs': 'America/Denver',
	'boise': 'America/Boise',
	'honolulu': 'Pacific/Honolulu',
	'anchorage': 'America/Anchorage',
	// India
	'mumbai': 'Asia/Kolkata',
	'delhi': 'Asia/Kolkata',
	'new delhi': 'Asia/Kolkata',
	'bangalore': 'Asia/Kolkata',
	'bengaluru': 'Asia/Kolkata',
	'hyderabad': 'Asia/Kolkata',
	'chennai': 'Asia/Kolkata',
	'pune': 'Asia/Kolkata',
	'ahmedabad': 'Asia/Kolkata',
	'jaipur': 'Asia/Kolkata',
	'lucknow': 'Asia/Kolkata',
	'surat': 'Asia/Kolkata',
	'kochi': 'Asia/Kolkata',
	'chandigarh': 'Asia/Kolkata',
	'gurgaon': 'Asia/Kolkata',
	'gurugram': 'Asia/Kolkata',
	'noida': 'Asia/Kolkata',
	// Europe
	'paris': 'Europe/Paris',
	'amsterdam': 'Europe/Amsterdam',
	'munich': 'Europe/Berlin',
	'frankfurt': 'Europe/Berlin',
	'hamburg': 'Europe/Berlin',
	'barcelona': 'Europe/Madrid',
	'milan': 'Europe/Rome',
	'rome': 'Europe/Rome',
	'vienna': 'Europe/Vienna',
	'zurich': 'Europe/Zurich',
	'geneva': 'Europe/Zurich',
	'dublin': 'Europe/Dublin',
	'edinburgh': 'Europe/London',
	'manchester': 'Europe/London',
	'birmingham': 'Europe/London',
	'brussels': 'Europe/Brussels',
	'copenhagen': 'Europe/Copenhagen',
	'oslo': 'Europe/Oslo',
	'stockholm': 'Europe/Stockholm',
	'helsinki': 'Europe/Helsinki',
	'prague': 'Europe/Prague',
	'warsaw': 'Europe/Warsaw',
	'budapest': 'Europe/Budapest',
	'lisbon': 'Europe/Lisbon',
	'athens': 'Europe/Athens',
	// Asia
	'beijing': 'Asia/Shanghai',
	'shenzhen': 'Asia/Shanghai',
	'guangzhou': 'Asia/Shanghai',
	'hangzhou': 'Asia/Shanghai',
	'nanjing': 'Asia/Shanghai',
	'osaka': 'Asia/Tokyo',
	'kyoto': 'Asia/Tokyo',
	'yokohama': 'Asia/Tokyo',
	'seoul': 'Asia/Seoul',
	'busan': 'Asia/Seoul',
	'taipei': 'Asia/Taipei',
	'kuala lumpur': 'Asia/Kuala_Lumpur',
	'jakarta': 'Asia/Jakarta',
	'bangkok': 'Asia/Bangkok',
	'hanoi': 'Asia/Ho_Chi_Minh',
	'ho chi minh': 'Asia/Ho_Chi_Minh',
	'manila': 'Asia/Manila',
	'dubai': 'Asia/Dubai',
	'abu dhabi': 'Asia/Dubai',
	'doha': 'Asia/Qatar',
	'riyadh': 'Asia/Riyadh',
	// Oceania
	'melbourne': 'Australia/Melbourne',
	'brisbane': 'Australia/Brisbane',
	'perth': 'Australia/Perth',
	'adelaide': 'Australia/Adelaide',
	'auckland': 'Pacific/Auckland',
	'wellington': 'Pacific/Auckland',
	// South America
	'rio de janeiro': 'America/Sao_Paulo',
	'rio': 'America/Sao_Paulo',
	'buenos aires': 'America/Argentina/Buenos_Aires',
	'lima': 'America/Lima',
	'bogota': 'America/Bogota',
	'santiago': 'America/Santiago',
	'medellin': 'America/Bogota',
	// Africa
	'cape town': 'Africa/Johannesburg',
	'lagos': 'Africa/Lagos',
	'nairobi': 'Africa/Nairobi',
	'casablanca': 'Africa/Casablanca',
	'accra': 'Africa/Accra',
	// Canada
	'toronto': 'America/Toronto',
	'vancouver': 'America/Vancouver',
	'montreal': 'America/Toronto',
	'calgary': 'America/Edmonton',
	'ottawa': 'America/Toronto',
	// Middle East
	'tel aviv': 'Asia/Jerusalem',
	'jerusalem': 'Asia/Jerusalem',
	'beirut': 'Asia/Beirut',
	'amman': 'Asia/Amman',
};

export interface CityMatch {
	cityName: string;
	timezone: TimezoneInfo;
}

function searchCityMap(query: string, allTimezones: TimezoneInfo[]): CityMatch[] {
	const q = query.toLowerCase();
	const results: CityMatch[] = [];
	const seenTz = new Set<string>();

	for (const [city, tzId] of Object.entries(CITY_TO_TIMEZONE)) {
		if (city.includes(q)) {
			if (seenTz.has(tzId)) continue;
			seenTz.add(tzId);
			const tz = allTimezones.find((t) => t.id === tzId);
			if (tz) {
				results.push({
					cityName: city.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
					timezone: tz,
				});
			}
		}
	}
	return results;
}

export function searchTimezones(query: string, allTimezones: TimezoneInfo[]): { tz: TimezoneInfo; displayName?: string }[] {
	if (!query.trim()) return [];
	const q = query.toLowerCase();
	const seen = new Set<string>();
	const results: { tz: TimezoneInfo; displayName?: string }[] = [];

	// First: city map matches (Mountain View, etc.)
	const cityMatches = searchCityMap(query, allTimezones);
	for (const match of cityMatches) {
		if (!seen.has(match.timezone.id)) {
			seen.add(match.timezone.id);
			results.push({ tz: match.timezone, displayName: match.cityName });
		}
	}

	// Then: IANA timezone matches
	for (const tz of allTimezones) {
		if (seen.has(tz.id)) continue;
		if (
			tz.city.toLowerCase().includes(q) ||
			tz.id.toLowerCase().includes(q) ||
			tz.region.toLowerCase().includes(q) ||
			getTimezoneAbbr(tz.id).toLowerCase().includes(q)
		) {
			seen.add(tz.id);
			results.push({ tz });
		}
		if (results.length >= 20) break;
	}

	return results.slice(0, 20);
}
