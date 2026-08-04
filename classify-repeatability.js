#!/usr/bin/env node
/**
 * classify-repeatability.js — проставляет признак повторяемости в готовом radar-data.json.
 *
 * Нужен, чтобы не гонять сканер заново: признак считается из заголовка и длины,
 * а они уже есть в данных. В самом сканере та же логика применяется на лету.
 *
 * Запуск: node classify-repeatability.js [radar-data.json]
 */

const fs = require("fs");
const path = process.argv[2] || "radar-data.json";

/**
 * Заявленный доход в заголовке: «$400,784.99», «$60K/Month», «50 000 ₽», «Rs 50,000».
 * Ролик держится на числе, а число — доказательство, которого у нас нет.
 * Копировать нельзя: без такого же результата получится враньё.
 */
const MONEY_CLAIM = new RegExp(
  [
    "\\$\\s?\\d",
    "\\d[\\d\\s.,]*\\s?(?:₽|руб|rub)",
    "\\brs\\.?\\s?\\d",
    "\\d+\\s?k\\s?\\/?\\s?(?:month|mo|мес)",
    "\\d+\\s?(?:тыс|млн)\\.?\\s?(?:₽|руб|в месяц|за месяц)",
    "\\d+\\s?(?:долларов|тысяч долларов)"
  ].join("|"),
  "i"
);

/** Многочасовой курс: повторить можно, но это месяцы работы, а не формат. */
const COURSE = /full course|полный курс|crash course|мастер-?класс|masterclass|курс\s+(?:по|за)\b|\bbootcamp\b/i;
const COURSE_SECONDS = 5400;

function repeatability(title, titleRu, durationSec) {
  const hay = (title || "") + " " + (titleRu || "");
  if (MONEY_CLAIM.test(hay)) return "claim";
  if (COURSE.test(hay) || (durationSec || 0) > COURSE_SECONDS) return "course";
  return "repeatable";
}

const rank = r => (r === "repeatable" ? 0 : r === "course" ? 1 : 2);

const d = JSON.parse(fs.readFileSync(path, "utf8"));
const counts = { repeatable: 0, course: 0, claim: 0 };

for (const key of ["rockets", "outliers", "byRuKeywords", "byEnKeywords"]) {
  for (const v of d[key] || []) {
    v.repeatability = repeatability(v.title, v.titleRu, v.durationSec);
  }
}
for (const v of d.rockets || []) counts[v.repeatability]++;

d.rockets = (d.rockets || []).sort(
  (a, b) => rank(a.repeatability) - rank(b.repeatability) || b.viewsPerSub - a.viewsPerSub
);
d.outliers = (d.outliers || []).sort(
  (a, b) => rank(a.repeatability) - rank(b.repeatability) || b.multiplier - a.multiplier
);
d.byRepeatability = counts;

fs.writeFileSync(path, JSON.stringify(d, null, 2), "utf8");

console.error("ракеты по повторяемости: " + JSON.stringify(counts));
for (const r of d.rockets || []) {
  console.error(
    "  " + r.repeatability.padEnd(11) +
    ("×" + r.viewsPerSub).padStart(7) + " | " +
    r.channel.slice(0, 20).padEnd(20) + " | " +
    (r.titleRu || r.title).slice(0, 46)
  );
}
