const ELIGIBLE_USER_ROLES = ['cliente', 'user'];

function eligibleUserFilter(extra = {}) {
  return { role: { $in: ELIGIBLE_USER_ROLES }, ...extra };
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function rollingSevenDayRange(now = new Date()) {
  const end = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  ));
  const start = addUtcDays(end, -7);
  return {
    start,
    end,
    startDay: utcDayKey(start),
    endDay: utcDayKey(end),
  };
}

function calendarPeriod(type, now = new Date()) {
  const year = now.getUTCFullYear();
  if (type === 'monthly') {
    const month = now.getUTCMonth();
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 1));
    return {
      type,
      period: `${year}-${String(month + 1).padStart(2, '0')}`,
      start,
      end,
      startDay: utcDayKey(start),
      endDay: utcDayKey(end),
    };
  }
  if (type === 'yearly') {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    return {
      type,
      period: String(year),
      start,
      end,
      startDay: utcDayKey(start),
      endDay: utcDayKey(end),
    };
  }
  throw new TypeError(`Tipo de periodo no soportado: ${type}`);
}

module.exports = {
  ELIGIBLE_USER_ROLES,
  addUtcDays,
  calendarPeriod,
  eligibleUserFilter,
  rollingSevenDayRange,
  utcDayKey,
};
