#!/usr/bin/env node
/**
 * radar-scan.js — сканер трендов YouTube для «Радара: ИИ и деньги».
 *
 * Запуск:  YT_API_KEY=AIza... node radar-scan.js > radar-data.json
 *
 * Глубокий режим: по каждому ключу берётся до 50 роликов в двух сортировках —
 * по просмотрам и по дате. Сортировка по просмотрам поднимает крупные каналы,
 * поэтому одной её мало: свежие ролики маленьких каналов видно только по дате.
 *
 * Экономия квоты. Поиск стоит 100 единиц независимо от числа результатов,
 * поэтому берём максимум. Размер канала узнаём пачками по 50 (1 единица),
 * а дорогой запрос за медианой тратим только на каналы до MAX_SUBS_FOR_PROFILE
 * и не больше MAX_PROFILES штук за прогон.
 */

const API = "https://www.googleapis.com/youtube/v3";
const KEY = process.env.YT_API_KEY;

if (!KEY) {
  console.error("ОШИБКА: не задан YT_API_KEY");
  process.exit(2);
}

/** Широкие ключи — общая картина ниши и потолки. */
const BROAD = [
  { q: "ии заменит профессии",          angle: "«ИИ заменит профессии» — страх за работу" },
  { q: "как зарабатывать с помощью ии", angle: "«Как зарабатывать с помощью ИИ» — путь до сервиса" },
  { q: "заработок в интернете",         angle: "Заработок в интернете — общий денежный запрос" },
  { q: "ии агенты",                     angle: "ИИ-агенты, MCP, автоматизация — гайды" },
  { q: "нейросети работа",              angle: "Нейросети в работе — прикладные гайды" },
  { q: "удаленная работа нейросети",    angle: "Удалённая работа на нейросетях" }
];

/** Длинные хвосты — узкие запросы, где сидят маленькие каналы. */
const LONGTAIL = [
  { q: "нейросети для фриланса",        angle: "Нейросети для фриланса" },
  { q: "ии для бизнеса автоматизация",  angle: "ИИ для бизнеса — автоматизация" },
  { q: "нейросеть монтаж видео",        angle: "Монтаж видео на нейросетях" },
  { q: "заработок на ии без вложений",  angle: "Заработок на ИИ без вложений" },
  { q: "нейросети для копирайтинга",    angle: "Нейросети для копирайтинга" },
  { q: "ии ассистент для работы",       angle: "ИИ-ассистент для работы" },
  { q: "нейросеть создать сайт",        angle: "Сайт на нейросетях" },
  { q: "промпт инженер обучение",       angle: "Промпт-инжиниринг — обучение" }
];

/** Англоязычные — опережают рунет на 2–3 месяца. */
const EN = [
  { q: "ai side hustle",        angle: "AI side hustle (EN)" },
  { q: "make money with ai",    angle: "Make money with AI (EN)" },
  { q: "faceless ai channel",   angle: "Faceless AI channel (EN)" },
  { q: "ai automation agency",  angle: "AI automation agency (EN)" }
];

const KEYWORDS = [
  ...BROAD.map(k => ({ ...k, lang: "ru", region: "RU", orders: ["viewCount", "date"] })),
  ...LONGTAIL.map(k => ({ ...k, lang: "ru", region: "RU", orders: ["viewCount"] })),
  ...EN.map(k => ({ ...k, lang: "en", region: "US", orders: ["viewCount"] }))
];

const MAX_RESULTS = 50;            // поиск стоит одинаково при любом числе — берём максимум
const MAX_SUBS_FOR_PROFILE = 300000; // медиану считаем только для каналов до этого размера
const MAX_PROFILES = 220;          // потолок дорогих запросов за прогон
const MIN_VIEWS_FOR_PROFILE = 3000; // совсем мелочь не считаем

/**
 * Ролик засчитывается, только если ядро темы ИИ есть в ЗАГОЛОВКЕ.
 * По описанию не ищем: там «AI» попадается в шаблонных подписях и рекламе,
 * из-за чего в выдачу лезут песни, новости и игровые ролики.
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
    "промпт", "prompt", "n8n"
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
let quotaSpent = 0;

async function api(path, params, cost, attempt = 0) {
  const u = new URL(API + path);
  u.searchParams.set("key", KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

  const res = await fetch(u);
  if (res.status === 403 || res.status === 429) {
    const body = await res.text();
    throw new Error(`QUOTA_OR_AUTH ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    if (attempt < 2) { await sleep(1200 * (attempt + 1)); return api(path, params, cost, attempt + 1); }
    throw new Error(`HTTP ${res.status} на ${path}`);
  }
  quotaSpent += cost;
  return res.json();
}

const median = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Размер канала — дёшево, пачками по 50. */
async function fetchChannels(ids) {
  const map = new Map();
  for (const part of chunk(ids, 50)) {
    try {
      const r = await api("/channels", { part: "statistics,contentDetails", id: part.join(",") }, 1);
      for (const c of r.items || []) map.set(c.id, c);
    } catch (e) {
      console.error(`  каналы не получены: ${e.message}`);
      if (/QUOTA_OR_AUTH/.test(e.message)) throw e;
    }
  }
  return map;
}

/**
 * Медиана просмотров канала + темп публикаций.
 * Темп нужен, чтобы отсеять новостные конвейеры: у канала с десятком роликов
 * в день медиана копеечная, и любая выстрелившая новость даёт множитель ×500.
 */
async function channelProfile(uploadsId, excludeVideoId) {
  const pl = await api("/playlistItems", { part: "contentDetails", playlistId: uploadsId, maxResults: 12 }, 1);
  const ids = (pl.items || [])
    .map(i => i.contentDetails.videoId)
    .filter(id => id !== excludeVideoId)
    .slice(0, 10);
  if (!ids.length) return { median: 0, perDay: 0 };

  const vs = await api("/videos", { part: "statistics,snippet", id: ids.join(",") }, 1);
  const rows = vs.items || [];
  const views = rows.map(v => Number(v.statistics.viewCount || 0)).filter(n => n > 0);
  const dates = rows.map(v => Date.parse(v.snippet.publishedAt)).filter(Boolean).sort((a, b) => b - a);
  const spanDays = dates.length > 1 ? Math.max(0.5, (dates[0] - dates[dates.length - 1]) / 864e5) : 0;
  return {
    median: median(views),
    perDay: spanDays > 0 ? Number((dates.length / spanDays).toFixed(2)) : 0
  };
}

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
    } catch {
      cache.set(it.videoId, null);
      it.thumb = null;
      fail++;
    }
  }
  console.error(`превью: ${ok} вшито, ${fail} не удалось, ${(bytes / 1024).toFixed(0)} КБ`);
}

const tierOf = subs =>
  subs < 5000 ? "nano" : subs < 50000 ? "small" : subs < 300000 ? "mid" : "big";

async function main() {
  const publishedAfter = new Date(Date.now() - 30 * 864e5).toISOString().replace(/\.\d{3}/, "");
  const failures = [];
  const rawById = new Map();   // videoId → сырой результат поиска
  const ceilings = [];

  // --- Фаза 1: поиск. Собираем как можно шире. ---
  for (const kw of KEYWORDS) {
    for (const order of kw.orders) {
      let search;
      try {
        search = await api("/search", {
          q: kw.q, part: "snippet", type: "video", order,
          maxResults: MAX_RESULTS, regionCode: kw.region,
          relevanceLanguage: kw.lang, publishedAfter
        }, 100);
      } catch (e) {
        console.error(`  ПРОПУСК «${kw.q}» (${order}): ${e.message}`);
        failures.push({ keyword: kw.q, order, error: e.message });
        if (/QUOTA_OR_AUTH/.test(e.message)) { order === order; break; }
        continue;
      }
      for (const i of search.items || []) {
        const id = i.id?.videoId;
        if (!id) continue;
        if (!rawById.has(id)) rawById.set(id, { id, keyword: kw.q, angle: kw.angle, lang: kw.lang });
      }
    }
    console.error(`ключ: ${kw.q} — всего кандидатов ${rawById.size}`);
    await sleep(120);
  }

  const allIds = [...rawById.keys()];
  console.error(`\nнайдено уникальных роликов: ${allIds.length}, квота: ${quotaSpent}`);

  // --- Фаза 2: статистика роликов, пачками по 50 (1 единица за пачку). ---
  const videos = [];
  for (const part of chunk(allIds, 50)) {
    try {
      const r = await api("/videos", { part: "statistics,snippet,contentDetails", id: part.join(",") }, 1);
      videos.push(...(r.items || []));
    } catch (e) {
      console.error(`  статистика не получена: ${e.message}`);
      if (/QUOTA_OR_AUTH/.test(e.message)) break;
    }
  }

  // --- Фаза 3: фильтры по теме, длине и языку. ---
  const kept = [];
  const ceilingByKeyword = new Map();
  for (const v of videos) {
    const meta = rawById.get(v.id);
    if (!meta) continue;
    if (!AI_CORE.test(v.snippet.title)) continue;

    const audio = (v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || "").toLowerCase();
    if (audio && !/^(ru|en)/.test(audio)) continue;

    const durationSec = durationSeconds(v.contentDetails?.duration);
    const isShort = durationSec > 0 && durationSec <= 90;
    const views = Number(v.statistics.viewCount || 0);

    const prev = ceilingByKeyword.get(meta.keyword);
    if (!prev || views > prev.ceiling) {
      ceilingByKeyword.set(meta.keyword, { angle: meta.angle, keyword: meta.keyword, ceiling: views });
    }
    if (isShort) continue;

    kept.push({
      videoId: v.id,
      url: "https://www.youtube.com/watch?v=" + v.id,
      thumbUrl: v.snippet.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      channelId: v.snippet.channelId,
      views,
      publishedAt: v.snippet.publishedAt,
      ageDays: Math.max(1, Math.round((Date.now() - Date.parse(v.snippet.publishedAt)) / 864e5)),
      durationSec,
      keyword: meta.keyword,
      lang: meta.lang
    });
  }
  ceilings.push(...ceilingByKeyword.values());
  console.error(`после фильтров осталось: ${kept.length}, квота: ${quotaSpent}`);

  // --- Фаза 4: размер каналов — дёшево, для всех. ---
  const chIds = [...new Set(kept.map(k => k.channelId))];
  let chMap = new Map();
  try {
    chMap = await fetchChannels(chIds);
  } catch (e) {
    failures.push({ stage: "channels", error: e.message });
  }
  for (const k of kept) {
    const ch = chMap.get(k.channelId);
    k.subs = ch ? Number(ch.statistics.subscriberCount || 0) : 0;
    k.uploadsPlaylist = ch?.contentDetails?.relatedPlaylists?.uploads || null;
    k.tier = tierOf(k.subs);
    k.viewsPerSub = k.subs > 0 ? Number((k.views / k.subs).toFixed(2)) : null;
  }
  console.error(`каналов опрошено: ${chIds.length}, квота: ${quotaSpent}`);

  // --- Фаза 5: медиана — только для небольших каналов, по убыванию перспективности. ---
  const profileQueue = kept
    .filter(k => k.uploadsPlaylist && k.subs > 0 &&
                 k.subs <= MAX_SUBS_FOR_PROFILE && k.views >= MIN_VIEWS_FOR_PROFILE)
    .sort((a, b) => (b.viewsPerSub || 0) - (a.viewsPerSub || 0));

  const seenChannel = new Map();
  let profiles = 0;
  for (const k of profileQueue) {
    if (profiles >= MAX_PROFILES) break;
    try {
      if (!seenChannel.has(k.channelId)) {
        seenChannel.set(k.channelId, await channelProfile(k.uploadsPlaylist, k.videoId));
        profiles++;
      }
      const p = seenChannel.get(k.channelId);
      k.channelMedian = p.median;
      k.uploadsPerDay = p.perDay;
      k.multiplier = p.median > 0 ? Number((k.views / p.median).toFixed(2)) : null;
    } catch (e) {
      console.error(`  профиль ${k.channelId}: ${e.message}`);
      if (/QUOTA_OR_AUTH/.test(e.message)) break;
    }
  }
  console.error(`медиан посчитано: ${profiles}, квота: ${quotaSpent}`);

  // --- Фаза 6: срезы. ---
  const withMult = kept.filter(k => k.multiplier != null && (k.uploadsPerDay ?? 0) <= 3);

  const outliers = withMult
    .filter(k => k.multiplier >= 3)
    .sort((a, b) => b.multiplier - a.multiplier);

  // Ракеты: маленький канал, непропорциональный охват. Главный срез для копирования.
  const rockets = kept
    .filter(k => k.subs > 0 && k.subs < 50000 && k.views >= 5000 && k.viewsPerSub >= 2)
    .sort((a, b) => b.viewsPerSub - a.viewsPerSub);

  const byTier = {
    nano: kept.filter(k => k.tier === "nano").length,
    small: kept.filter(k => k.tier === "small").length,
    mid: kept.filter(k => k.tier === "mid").length,
    big: kept.filter(k => k.tier === "big").length
  };

  const out = {
    scannedAt: new Date().toISOString(),
    publishedAfter,
    keywordsScanned: KEYWORDS.length - new Set(failures.map(f => f.keyword)).size,
    searchesRun: KEYWORDS.reduce((n, k) => n + k.orders.length, 0),
    videosScanned: allIds.length,
    videosKept: kept.length,
    profilesComputed: profiles,
    quotaSpent,
    byTier,
    failures,
    ok: kept.length > 0,
    ceilings: ceilings.sort((a, b) => b.ceiling - a.ceiling),
    rockets: rockets.slice(0, 12),
    outliers: outliers.slice(0, 12),
    byRuKeywords: kept.filter(k => k.lang === "ru").sort((a, b) => b.views - a.views).slice(0, 8),
    byEnKeywords: kept.filter(k => k.lang === "en").sort((a, b) => b.views - a.views).slice(0, 8)
  };

  // Превью вшиваем base64: у артефактов строгий CSP, внешние картинки не загрузятся.
  await embedThumbnails([...out.rockets, ...out.outliers, ...out.byRuKeywords, ...out.byEnKeywords]);

  process.stdout.write(JSON.stringify(out, null, 2));
  console.error(`\nготово. Просмотрено ${allIds.length}, оставлено ${kept.length}, ` +
    `ракет ${rockets.length}, аутлаеров ${outliers.length}, квота ${quotaSpent}/10000`);
}

main().catch(e => {
  console.error("ФАТАЛЬНО:", e.message);
  process.stdout.write(JSON.stringify({ ok: false, error: e.message, scannedAt: new Date().toISOString() }, null, 2));
  process.exit(1);
});
