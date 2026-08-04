#!/usr/bin/env node
/**
 * build-radar.js — вставляет свежие данные сканера в страницу радара.
 *
 * Запуск:  node build-radar.js [radar-data.json] [ai-trend-radar.html]
 *
 * Заменяет только блок между маркерами RADAR_START и RADAR_END.
 * Вёрстка, очередь съёмки и шпаргалка не трогаются — они правятся руками.
 *
 * Если новый прогон пустой (ok:false или нет аутлаеров), данные в странице
 * НЕ перезаписываются: лучше показать вчерашние цифры с честной пометкой,
 * чем подставить пустоту или выдумать числа.
 */

const fs = require("fs");
const path = require("path");

const dataPath = path.resolve(process.argv[2] || "radar-data.json");
const pagePath = path.resolve(process.argv[3] || "ai-trend-radar.html");

const START = "/*RADAR_START*/";
const END = "/*RADAR_END*/";

function fail(msg) {
  console.error("build-radar: " + msg);
  process.exit(1);
}

if (!fs.existsSync(dataPath)) fail(`не найден файл данных ${dataPath}`);
if (!fs.existsSync(pagePath)) fail(`не найдена страница ${pagePath}`);

let data;
try {
  data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
} catch (e) {
  fail("radar-data.json не разобрался как JSON: " + e.message);
}

const html = fs.readFileSync(pagePath, "utf8");
const i = html.indexOf(START);
const j = html.indexOf(END);
if (i === -1 || j === -1 || j < i) fail("в странице не найдены маркеры RADAR_START / RADAR_END");

// Проверка качества прогона.
const outliers = Array.isArray(data.outliers) ? data.outliers.length : 0;
const ceilings = Array.isArray(data.ceilings) ? data.ceilings.length : 0;

if (!data.ok || (outliers === 0 && ceilings === 0)) {
  console.error(
    `build-radar: прогон пустой (ok=${data.ok}, аутлаеров ${outliers}, потолков ${ceilings}). ` +
    "Страница оставлена с прежними данными — подставлять нечего."
  );
  process.exit(3);
}

const json = JSON.stringify(data);
const rebuilt = html.slice(0, i + START.length) + json + html.slice(j);
fs.writeFileSync(pagePath, rebuilt, "utf8");

const withThumbs = []
  .concat(data.outliers || [], data.byRuKeywords || [], data.byEnKeywords || [])
  .filter(x => x && x.thumb).length;

console.error(
  `build-radar: готово. Аутлаеров ${outliers}, потолков ${ceilings}, превью ${withThumbs}. ` +
  `Страница ${(Buffer.byteLength(rebuilt) / 1024).toFixed(0)} КБ.`
);
