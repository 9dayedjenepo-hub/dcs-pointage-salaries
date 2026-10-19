'use strict';
// Gestion des dates dans le fuseau Africa/Bamako.
// Les horodatages sont stockés en UTC (ISO 8601) et convertis pour l'affichage et le regroupement par jour.

const TZ = 'Africa/Bamako';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function parts(date) {
  const o = {};
  for (const p of fmt.formatToParts(date)) o[p.type] = p.value;
  return o;
}

// Décalage (ms) du fuseau par rapport à UTC à l'instant donné.
function tzOffset(ms) {
  const p = parts(new Date(ms));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function localDate(iso) {
  const p = parts(new Date(iso));
  return `${p.year}-${p.month}-${p.day}`;
}

function localTime(iso) {
  const p = parts(new Date(iso));
  return `${p.hour}:${p.minute}`;
}

function localDateTime(iso) {
  return `${localDate(iso)} ${localTime(iso)}`;
}

// Convertit une date + heure locales de Bamako (« 2026-10-05 », « 09:00 ») en ISO UTC.
function localToUtcIso(dateStr, timeStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') || !/^\d{2}:\d{2}$/.test(timeStr || '')) {
    throw new Error('Date ou heure invalide');
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw new Error('Date ou heure invalide');
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const result = new Date(guess - tzOffset(guess));
  if (localDate(result.toISOString()) !== dateStr) throw new Error('Date invalide');
  return result.toISOString();
}

function today(now = new Date()) {
  return localDate(now.toISOString());
}

function currentMonth(now = new Date()) {
  return today(now).slice(0, 7);
}

function isValidMonth(ym) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(ym || '');
}

function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= n; d++) out.push(`${ym}-${String(d).padStart(2, '0')}`);
  return out;
}

// Jour de la semaine (0 = dimanche … 6 = samedi) d'une date « AAAA-MM-JJ ».
function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function previousMonth(ym) {
  let [y, m] = ym.split('-').map(Number);
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
  'septembre', 'octobre', 'novembre', 'décembre'];

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MOIS_FR[m - 1]} ${y}`;
}

module.exports = {
  TZ, localDate, localTime, localDateTime, localToUtcIso, today, currentMonth,
  isValidMonth, daysInMonth, weekday, previousMonth, monthLabel,
};
