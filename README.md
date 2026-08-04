# ai-trend-radar

Ежедневный радар трендов YouTube по нише «заработок на ИИ».

## Файлы

- `radar-scan.js` — сканер. Опрашивает YouTube Data API по списку ключей, считает
  множитель аутлаера (просмотры ÷ медиана канала), отсеивает не по теме, Shorts,
  каналы-конвейеры и ролики не на русском/английском. Превью вшивает base64.
- `radar-template.html` — шаблон страницы. Данные подставляются между маркерами
  `RADAR_START` и `RADAR_END`. Вёрстка, очередь съёмки и шпаргалка правятся руками.
- `build-radar.js` — сборщик: вставляет `radar-data.json` в шаблон.

## Запуск

```
YT_API_KEY=<ключ> node radar-scan.js > radar-data.json
node build-radar.js radar-data.json ai-trend-radar.html
```

Ключ — YouTube Data API v3, квота одного прогона около 1100 единиц из 10 000 в сутки.
