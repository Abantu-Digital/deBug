import type { Context } from "@debugkit/schema";

/**
 * Rough location from what the device already reports: its timezone, then its locale's region.
 * Never from IP addresses. Timezone wins because many phones keep an en-US or en-GB locale
 * wherever they are.
 */
const TZ: Record<string, string> = {
  "Africa/Johannesburg": "ZA", "Africa/Lagos": "NG", "Africa/Nairobi": "KE", "Africa/Cairo": "EG", "Africa/Casablanca": "MA",
  "Africa/Accra": "GH", "Africa/Harare": "ZW", "Africa/Lusaka": "ZM", "Africa/Maputo": "MZ", "Africa/Windhoek": "NA",
  "Africa/Gaborone": "BW", "Africa/Kampala": "UG", "Africa/Dar_es_Salaam": "TZ", "Africa/Addis_Ababa": "ET", "Africa/Kigali": "RW",
  "Africa/Algiers": "DZ", "Africa/Tunis": "TN", "Africa/Abidjan": "CI", "Africa/Dakar": "SN", "Africa/Luanda": "AO",
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES",
  "Europe/Rome": "IT", "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Lisbon": "PT", "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Helsinki": "FI", "Europe/Warsaw": "PL", "Europe/Zurich": "CH",
  "Europe/Vienna": "AT", "Europe/Athens": "GR", "Europe/Istanbul": "TR", "Europe/Moscow": "RU", "Europe/Kyiv": "UA",
  "Europe/Kiev": "UA", "Europe/Prague": "CZ", "Europe/Budapest": "HU", "Europe/Bucharest": "RO",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US", "America/Phoenix": "US",
  "America/Anchorage": "US", "Pacific/Honolulu": "US", "America/Detroit": "US", "America/Toronto": "CA", "America/Vancouver": "CA",
  "America/Edmonton": "CA", "America/Halifax": "CA", "America/Mexico_City": "MX", "America/Sao_Paulo": "BR",
  "America/Argentina/Buenos_Aires": "AR", "America/Bogota": "CO", "America/Lima": "PE", "America/Santiago": "CL",
  "Asia/Dubai": "AE", "Asia/Riyadh": "SA", "Asia/Qatar": "QA", "Asia/Jerusalem": "IL", "Asia/Kolkata": "IN", "Asia/Calcutta": "IN",
  "Asia/Karachi": "PK", "Asia/Dhaka": "BD", "Asia/Bangkok": "TH", "Asia/Jakarta": "ID", "Asia/Singapore": "SG",
  "Asia/Kuala_Lumpur": "MY", "Asia/Manila": "PH", "Asia/Ho_Chi_Minh": "VN", "Asia/Hong_Kong": "HK", "Asia/Shanghai": "CN",
  "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Asia/Taipei": "TW", "Australia/Sydney": "AU", "Australia/Melbourne": "AU",
  "Australia/Brisbane": "AU", "Australia/Perth": "AU", "Australia/Adelaide": "AU", "Pacific/Auckland": "NZ",
  "Indian/Mauritius": "MU",
};

export function countryOf(ctx: Pick<Context, "timezone" | "locale">): string {
  const tz = ctx.timezone ? TZ[ctx.timezone] : undefined;
  if (tz) return tz;
  const region = /[-_]([A-Z]{2})(?:\b|$)/.exec(ctx.locale ?? "")?.[1];
  return region ?? "unknown";
}
