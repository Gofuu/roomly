/**
 * Time helpers. The API speaks absolute instants (ISO, UTC); the UI shows every
 * booking in its building's time zone, whatever the viewer's own zone is.
 */
import { DateTime } from 'luxon';

export const inZone = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: tz });

export const fmtTime = (iso: string, tz: string) => inZone(iso, tz).toFormat('HH:mm');

export const fmtRange = (start: string, end: string, tz: string) => `${fmtTime(start, tz)} – ${fmtTime(end, tz)}`;

export const fmtDay = (iso: string, tz: string) => inZone(iso, tz).toFormat('ccc d LLL');

export const todayIn = (tz: string) => DateTime.now().setZone(tz).toISODate()!;

export const addDays = (date: string, n: number) => DateTime.fromISO(date).plus({ days: n }).toISODate()!;

export const fmtLongDate = (date: string) => DateTime.fromISO(date).toFormat('cccc, d LLLL yyyy');

/** Wall-clock date + "HH:mm" in a zone → ISO instant with offset. */
export function localToIso(date: string, time: string, tz: string): string {
  return DateTime.fromISO(`${date}T${time}`, { zone: tz }).toISO({ suppressMilliseconds: true })!;
}

/** Short zone label for the viewer, e.g. "IST" or "GMT+5:30". */
export const zoneLabel = (tz: string) => DateTime.now().setZone(tz).toFormat('ZZZZ');

/** True when the viewer's own zone differs from tz (so we should say which zone times are in). */
export const isForeignZone = (tz: string) => DateTime.now().setZone(tz).offset !== DateTime.now().offset;

/** "HH:mm" options every `step` minutes across a day. */
export function timeOptions(step = 15): string[] {
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += step) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}
