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

export function isNightHour(hour: number): boolean {
	// Night is roughly 7 PM (19) to 6 AM (6)
	return hour >= 19 || hour < 7;
}

export function getCurrentHourInTimezone(tz: string): number {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hour: 'numeric',
		hour12: false,
	});
	return parseInt(formatter.format(new Date()));
}

export function searchTimezones(query: string, allTimezones: TimezoneInfo[]): TimezoneInfo[] {
	if (!query.trim()) return [];
	const q = query.toLowerCase();
	return allTimezones
		.filter((tz) => {
			return (
				tz.city.toLowerCase().includes(q) ||
				tz.id.toLowerCase().includes(q) ||
				tz.region.toLowerCase().includes(q) ||
				getTimezoneAbbr(tz.id).toLowerCase().includes(q)
			);
		})
		.slice(0, 20);
}
