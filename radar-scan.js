#!/usr/bin/env node
/**
 * radar-scan.js — сканер трендов YouTube для «Радара: ИИ и деньги».
 *
 * Запуск:  YT_API_KEY=AIza... node radar-scan.js > radar-data.json
 *
 * Что делает:
 *   1. По каждому ключу берёт топ роликов за последние 30 дней (сортировка по просмотрам).
 *   2. Тянет просмотры ролика, подписчиков канала и последние 10 роликов канала.
 *   3. Считает множитель = просмотры / медиана канала.
 *   4. Выдаёт JSON: аутлаеры, потолки по ключам, сырые кандидаты.
 *
 * Квота: search.list = 100 единиц за ключ. 10 ключей ≈ 1000 + ~250 на статистику.
 * Бесплатный лимит — 10 000 единиц в сутки.
 */

const API = "https://www.googleapis.com/youtube/v3";
const KEY = process.env.YT_API_KEY;

if (!KEY) {
  console.error("ОШИБКА: не задан YT_API_KEY");
  process.exit(2);
}

const KEYWORDS = [
  { q: "ии заменит профессии",        lang: "ru", region: "RU", angle: "«ИИ заменит профессии» — страх за работу" },
  { q: "как зарабатывать с помощью ии", lang: "ru", region: "RU", angle: "«Как зарабатывать с помощью ИИ» — путь до сервиса" },
  { q: "заработок в интернете",        lang: "ru", region: "RU", angle: "Заработок в интернете — общий денежный запрос" },
  { q: "ии агенты",                    lang: "ru", region: "RU", angle: "ИИ-агенты, MCP, автоматизация — гайды" },
  { q: "нейросети работа",             lang: "ru", region: "RU", angle: "Нейросети в работе — прикладные гайды" },
  { q: "удаленная работа нейросети",   lang: "ru", region: "RU", angle: "Удалённая работа на нейросетях" },
  { q: "ai side hustle",               lang: "en", region: "US", angle: "AI side hustle (EN)" },
  { q: "make money with ai",           lang: "en", region: "US", angle: "Make money with AI (EN)" },
  { q: "faceless ai channel",          lang: "en", region: "US", angle: "Faceless AI channel (EN)" },
  { q: "ai automation agency",         lang: "en", region: "US", angle: "AI automation agency (EN)" }
];

/** Сколько верхних роликов на ключ считать кандидатами (экономия квоты). */
const PER_KEYWORD = 6;

/**
 * Ролик засчитывается, только если в заголовке или описании есть ядро темы ИИ.
 * Без этого фильтра по запросу «ии агенты» приходят ролики про секретных агентов
 * в играх, а по «заработок в интернете» — всё подряд.
 * Слова «агент» и «автоматизация» сами по себе НЕ считаются — они слишком общие.
 */
const AI_CORE = new RegExp(
  [
    "(?:^|[^а-яёa-z0-9])(?:ии|ai)(?:[^а-яёa-z0-9]|$)",
    "openai", "нейросет", "нейронк", "нейрос",
    "искусственн\\w*\\s*интеллект",
    "chatgpt", "chat\\s?gpt", "(?:^|[^a-z])gpt(?:[^a-z]|$)",
    "claude", "gemini", "midjourney", "deepseek", "qwen",
    "(?:^|[^a-z])sora(?:[^a-z]|$)", "(?:^|[^a-z])veo(?:[^a-z]|$)",
    "(?:^|[^a-z])llm(?:[^a-z]|$)",
    "gigachat", "гигачат", "copilot", "копилот",
    "промпт", "prompt"
  ].join("|"),
  "i"
);

/** ISO 8601 (PT1H2M3S) → секунды. */
function durationSeconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, params, attempt = 0) {
  const u = new URL(API + path);
  u.searchParams.set("key", KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

  const res = await fetch(u);
  if (res.status === 403 || res.status === 429) {
    const body = await res.text();
    throw new Error(`QUOTA_OR_AUTH ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.ok) {
    if (attempt < 2) { await sleep(1200 * (attempt + 1)); return api(path, params, attempt + 1); }
    throw new Error(`HTTP ${res.status} на ${path}`);
  }
  return res.json();
}

const median = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * Медиана просмотров последних роликов канала + темп публикаций.
 * Темп нужен, чтобы отсеять новостные конвейеры: у канала с десятком роликов
 * в день медиана копеечная, и любая выстрелившая новость даёт множитель ×500,
 * хотя копировать там нечего.
 */
async function channelProfile(channelId, uploadsId, excludeVideoId, cache) {
  if (cache.has(channelId)) return cache.get(channelId);
  let profile = { median: 0, perDay: 0 };
  try {
    const pl = await api("/playlistItems", { part: "contentDetails", playlistId: uploadsId, maxResults: 12 });
    const ids = (pl.items || [])
      .map(i => i.contentDetails.videoId)
      .filter(id => id !== excludeVideoId)
      .slice(0, 10);
    if (ids.length) {
      const vs = await api("/videos", { part: "statistics,snippet", id: ids.join(",") });
      const rows = vs.items || [];
      const views = rows.map(v => Number(v.statistics.viewCount || 0)).filter(n => n > 0);
      const dates = rows.map(v => Date.parse(v.snippet.publishedAt)).filter(Boolean).sort((a, b) => b - a);
      const spanDays = dates.length > 1 ? Math.max(0.5, (dates[0] - dates[dates.length - 1]) / 864e5) : 0;
      profile = {
        median: median(views),
        perDay: spanDays > 0 ? Number((dates.length / spanDays).toFixed(2)) : 0
      };
    }
  } catch (e) {
    console.error(`  профиль канала ${channelId} не посчитан: ${e.message}`);
  }
  cache.set(channelId, profile);
  return profile;
}

/**
 * Скачивает превью и кладёт их в поле thumb как data:URI.
 * Один и тот же ролик может быть в нескольких списках — качаем по videoId один раз.
 */
async function embedThumbnails(items) {
  const cache = new Map();
  let ok = 0, fail = 0, bytes = 0;

  for (const it of items) {
    if (!it || !it.thumbUrl) continue;
    if (cache.has(it.videoId)) { it.thumb = cache.get(it.videoId); continue; }
    try {
      const res = await fetch(it.thumbUrl);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const uri = "data:image/jpeg;base64," + buf.toString("base64");
      cache.set(it.videoId, uri);
      it.thumb = uri;
      bytes += buf.length;
      ok++;
    } catch (e) {
      cache.set(it.videoId, null);
      it.thumb = null;
      fail++;
    }
  }
  console.error(`превью: ${ok} вшито, ${fail} не удалось, ${(bytes / 1024).toFixed(0)} КБ`);
}

async function main() {
  const publishedAfter = new Date(Date.now() - 30 * 864e5).toISOString().replace(/\.\d{3}/, "");
  const medianCache = new Map();
  const candidates = [];
  const ceilings = [];
  const failures = [];

  for (const kw of KEYWORDS) {
    console.error(`ключ: ${kw.q}`);
    let search;
    try {
      search = await api("/search", {
        q: kw.q, part: "snippet", type: "video", order: "viewCount",
        maxResults: 10, regionCode: kw.region, relevanceLanguage: kw.lang, publishedAfter
      });
    } catch (e) {
      console.error(`  ПРОПУСК: ${e.message}`);
      failures.push({ keyword: kw.q, error: e.message });
      if (/QUOTA_OR_AUTH/.test(e.message)) break;
      continue;
    }

    const items = (search.items || []).slice(0, PER_KEYWORD);
    if (!items.length) { ceilings.push({ angle: kw.angle, keyword: kw.q, ceiling: 0 }); continue; }

    const vids = items.map(i => i.id.videoId);
    const stats = await api("/videos", { part: "statistics,snippet,contentDetails", id: vids.join(",") });
    const chIds = [...new Set((stats.items || []).map(v => v.snippet.channelId))];
    const chData = await api("/channels", { part: "statistics,contentDetails", id: chIds.join(",") });
    const chMap = new Map((chData.items || []).map(c => [c.id, c]));

    let ceiling = 0;

    for (const v of stats.items || []) {
      const views = Number(v.statistics.viewCount || 0);

      // Тема должна быть в ЗАГОЛОВКЕ. По описанию не ищем: там «AI» попадается
      // в шаблонных подписях и рекламе, из-за чего в выдачу лезут песни и новости.
      if (!AI_CORE.test(v.snippet.title)) continue;

      const durationSec = durationSeconds(v.contentDetails?.duration);
      const isShort = durationSec > 0 && durationSec <= 90;

      // Язык дорожки. Если он проставлен и это не русский и не английский —
      // ролик не наш: по запросу «ai side hustle» приходит много контента на хинди.
      const audio = (v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || "").toLowerCase();
      if (audio && !/^(ru|en)/.test(audio)) continue;

      if (views > ceiling) ceiling = views;

      const ch = chMap.get(v.snippet.channelId);
      if (!ch) continue;
      const subs = Number(ch.statistics.subscriberCount || 0);
      const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) continue;

      const prof = await channelProfile(v.snippet.channelId, uploads, v.id, medianCache);
      const med = prof.median;
      const mult = med > 0 ? views / med : null;

      candidates.push({
        videoId: v.id,
        url: "https://www.youtube.com/watch?v=" + v.id,
        thumbUrl: v.snippet.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
        title: v.snippet.title,
        channel: v.snippet.channelTitle,
        channelId: v.snippet.channelId,
        subs,
        views,
        channelMedian: med,
        uploadsPerDay: prof.perDay,
        multiplier: mult ? Number(mult.toFixed(2)) : null,
        publishedAt: v.snippet.publishedAt,
        ageDays: Math.max(1, Math.round((Date.now() - Date.parse(v.snippet.publishedAt)) / 864e5)),
        durationSec,
        isShort,
        keyword: kw.q,
        lang: kw.lang
      });
    }

    ceilings.push({ angle: kw.angle, keyword: kw.q, ceiling });
    await sleep(200);
  }

  // Дедупликация по videoId — один ролик может прийти из нескольких ключей.
  const seen = new Set();
  const unique = candidates.filter(c => !seen.has(c.videoId) && seen.add(c.videoId));

  // Длинные ролики — канал делает long-form, Shorts копировать нечего.
  const longform = unique.filter(c => !c.isShort);

  // Конвейеры (больше 3 роликов в сутки) из аутлаеров исключаем: их множитель
  // отражает низкую медиану, а не сильный формат.
  const outliers = longform
    .filter(c => c.multiplier !== null && c.multiplier >= 3 && c.uploadsPerDay <= 3)
    .sort((a, b) => b.multiplier - a.multiplier);

  // Сигнал первого приоритета: маленький канал, большие просмотры, свежее.
  const priority = longform.filter(c =>
    c.subs > 0 && c.subs < 20000 && c.views > 200000 && c.ageDays <= 21
  ).sort((a, b) => b.views - a.views);

  const out = {
    scannedAt: new Date().toISOString(),
    publishedAfter,
    keywordsScanned: KEYWORDS.length - failures.length,
    failures,
    ok: failures.length < KEYWORDS.length && unique.length > 0,
    ceilings: ceilings.sort((a, b) => b.ceiling - a.ceiling),
    outliers: outliers.slice(0, 10),
    priority: priority.slice(0, 5),
    // Группировка по тому, каким ключом ролик найден, а не по языку самого ролика:
    // из-за автодубляжа YouTube англоязычные каналы приходят и по русским запросам.
    byRuKeywords: longform.filter(c => c.lang === "ru").sort((a, b) => b.views - a.views).slice(0, 8),
    byEnKeywords: longform.filter(c => c.lang === "en").sort((a, b) => b.views - a.views).slice(0, 8)
  };

  // Превью вшиваем в страницу base64-строкой: у артефактов строгий CSP,
  // внешние картинки с i.ytimg.com там просто не загрузятся.
  await embedThumbnails([...out.outliers, ...out.priority, ...out.byRuKeywords, ...out.byEnKeywords]);

  process.stdout.write(JSON.stringify(out, null, 2));
  console.error(`\nготово: ${unique.length} роликов, ${outliers.length} аутлаеров, ${failures.length} сбоев`);
}

main().catch(e => {
  console.error("ФАТАЛЬНО:", e.message);
  process.stdout.write(JSON.stringify({ ok: false, error: e.message, scannedAt: new Date().toISOString() }, null, 2));
  process.exit(1);
});
