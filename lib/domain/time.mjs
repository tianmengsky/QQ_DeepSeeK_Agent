function localStamp(date = new Date(), withTime = true) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  return withTime ? `${day} ${p(date.getHours())}:${p(date.getMinutes())}` : day;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function nowLine(date = new Date()) {
  return `（现在是 ${localStamp(date)}，周${WEEKDAYS[date.getDay()]}。）`;
}

export { localStamp, WEEKDAYS, nowLine };
