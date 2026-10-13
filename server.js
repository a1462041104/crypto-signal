const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Multi-endpoint fallback for robust connectivity
const BINANCE_BASE_URLS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com'
];

// Ensure public directory exists
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Middleware: CORS & UTF-8 for API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.path.startsWith('/api')) {
    res.header('Content-Type', 'application/json; charset=utf-8');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Middleware: Request Logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Middleware: Static files
app.use(express.static(publicDir));

// High-Frequency Cache storage with granular TTL per data type
const cache = new Map();
const CACHE_TTL_MS = 1500; // default 1.5s (down from 8s)

function getCached(key, customTtl) {
  const cached = cache.get(key);
  const ttl = customTtl !== undefined ? customTtl : CACHE_TTL_MS;
  if (cached && (Date.now() - cached.timestamp < ttl)) {
    return cached.data;
  }
  return null;
}

function setCached(key, data) {
  cache.set(key, { timestamp: Date.now(), data });
}

// Format symbol helper (e.g. btc -> BTCUSDT)
function normalizeSymbol(symbol) {
  let sym = (symbol || '').toUpperCase().trim();
  if (!sym.endsWith('USDT') && !sym.endsWith('BUSD') && !sym.endsWith('USDC') && !sym.endsWith('BTC')) {
    sym += 'USDT';
  }
  return sym;
}

// Resilient Binance Fetcher with fallback endpoints
async function fetchWithFallback(pathAndQuery) {
  let lastError = null;
  for (const baseUrl of BINANCE_BASE_URLS) {
    try {
      const url = `${baseUrl}${pathAndQuery}`;
      const controller = new (global.AbortController || require('abort-controller'))();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        return await res.json();
      }
      lastError = new Error(`Status ${res.status}: ${await res.text()}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('All Binance endpoints failed');
}

async function fetchBinancePrice(symbol) {
  const normalized = normalizeSymbol(symbol);
  const cacheKey = `price:${normalized}`;
  const cached = getCached(cacheKey, 800);
  if (cached) return cached;

  const data = await fetchWithFallback(`/api/v3/ticker/price?symbol=${normalized}`);
  const parsed = {
    symbol: data.symbol,
    price: parseFloat(data.price)
  };
  setCached(cacheKey, parsed);
  return parsed;
}

async function fetchBinance24hStats(symbol) {
  const normalized = normalizeSymbol(symbol);
  const cacheKey = `ticker24h:${normalized}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await fetchWithFallback(`/api/v3/ticker/24hr?symbol=${normalized}`);
  const parsed = {
    priceChange: parseFloat(data.priceChange),
    priceChangePercent: parseFloat(data.priceChangePercent),
    highPrice: parseFloat(data.highPrice),
    lowPrice: parseFloat(data.lowPrice),
    volume: parseFloat(data.volume),
    quoteVolume: parseFloat(data.quoteVolume)
  };
  setCached(cacheKey, parsed);
  return parsed;
}

async function fetchBinanceDepth(symbol, limit = 10) {
  const normalized = normalizeSymbol(symbol);
  const cacheKey = `depth:${normalized}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await fetchWithFallback(`/api/v3/depth?symbol=${normalized}&limit=${limit}`);
  const parsed = {
    symbol: normalized,
    bids: (data.bids || []).map(b => [parseFloat(b[0]), parseFloat(b[1])]),
    asks: (data.asks || []).map(a => [parseFloat(a[0]), parseFloat(a[1])])
  };
  setCached(cacheKey, parsed);
  return parsed;
}

// Strictly aligns and aggregates 5m candles into standard 10m candles (:00, :10, :20, :30, :40, :50)
function aggregateKlinesTo10m(klines5m) {
  if (!Array.isArray(klines5m) || !klines5m.length) return [];
  const aggregated = [];
  let i = 0;

  // 1. Skip any initial 5m candle that does not start at a clean 10m boundary
  while (i < klines5m.length) {
    const d = new Date(klines5m[i].openTime);
    if (d.getMinutes() % 10 === 0) break;
    i++;
  }

  // 2. Pair 5m candles into clean, strictly aligned 10m candles
  for (; i < klines5m.length; i++) {
    const k0 = klines5m[i];
    const k1 = klines5m[i + 1];
    // Check if k1 is the second half of this 10m candle (exactly 5 minutes later)
    if (k1 && (k1.openTime === k0.openTime + 5 * 60 * 1000)) {
      aggregated.push({
        openTime: k0.openTime,
        open: k0.open,
        high: Math.max(k0.high, k1.high),
        low: Math.min(k0.low, k1.low),
        close: k1.close,
        volume: Number((k0.volume + k1.volume).toFixed(4)),
        closeTime: k1.closeTime
      });
      i++; // consumed k1
    } else {
      // k0 is the first 5m of the current in-progress 10m candle (second 5m hasn't formed yet)
      aggregated.push({
        openTime: k0.openTime,
        open: k0.open,
        high: k0.high,
        low: k0.low,
        close: k0.close,
        volume: Number(k0.volume.toFixed(4)),
        closeTime: k0.openTime + 10 * 60 * 1000 - 1
      });
    }
  }
  return aggregated;
}

async function fetchBinanceKlines(symbol, interval = '1m', limit = 150) {
  const normalized = normalizeSymbol(symbol);

  // If 10m interval requested, aggregate strictly aligned 5m candles
  if (interval === '10m') {
    const raw5m = await fetchBinanceKlines(symbol, '5m', Math.min(limit * 2 + 10, 1000));
    const aggregated = aggregateKlinesTo10m(raw5m);
    return aggregated.slice(-limit);
  }

  const cacheKey = `uiklines:${normalized}:${interval}:${limit}`;
  const cached = getCached(cacheKey, 1000);
  if (cached) return cached;

  let rawKlines;
  try {
    rawKlines = await fetchWithFallback(`/api/v3/uiKlines?symbol=${normalized}&interval=${interval}&limit=${limit}`);
  } catch (err) {
    // Fallback to /api/v3/klines if uiKlines has temporary issues
    rawKlines = await fetchWithFallback(`/api/v3/klines?symbol=${normalized}&interval=${interval}&limit=${limit}`);
  }

  const formatted = rawKlines.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    quoteVolume: parseFloat(k[7] || 0),
    trades: k[8] || 0,
    takerBuyVolume: parseFloat(k[9] || 0)
  }));

  setCached(cacheKey, formatted);
  return formatted;
}

// ==========================================
// TECHNICAL INDICATORS & QUANT MATHEMATICS
// ==========================================

function roundTo(val, decimals = 2) {
  if (isNaN(val) || val === null || val === undefined) return 0;
  return Number(val.toFixed(decimals));
}

// 1. RSI (Wilder smoothed)
function calculateRSI(closes, period = 14) {
  if (closes.length <= period) {
    return { current: 50, series: [50] };
  }

  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const rsiSeries = [];
  const calcVal = (g, l) => {
    if (l === 0) return 100;
    const rs = g / l;
    return 100 - (100 / (1 + rs));
  };

  rsiSeries.push(calcVal(avgGain, avgLoss));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    rsiSeries.push(calcVal(avgGain, avgLoss));
  }

  return {
    current: rsiSeries[rsiSeries.length - 1],
    series: rsiSeries
  };
}

// 2. EMA
function calculateEMA(values, period) {
  if (values.length === 0) return [];
  if (values.length < period) {
    const sum = values.reduce((a, b) => a + b, 0);
    return [sum / values.length];
  }

  const k = 2 / (period + 1);
  const emaSeries = [];

  let initialSMA = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emaSeries.push(initialSMA);

  for (let i = period; i < values.length; i++) {
    const nextEMA = values[i] * k + emaSeries[emaSeries.length - 1] * (1 - k);
    emaSeries.push(nextEMA);
  }

  return emaSeries;
}

// 3. MACD (12, 26, 9)
function calculateMACD(closes) {
  const ema12Series = calculateEMA(closes, 12);
  const ema26Series = calculateEMA(closes, 26);

  const offset = 26 - 12;
  const macdLine = [];
  for (let i = 0; i < ema26Series.length; i++) {
    macdLine.push(ema12Series[i + offset] - ema26Series[i]);
  }

  const signalLineSeries = calculateEMA(macdLine, 9);
  const histSeries = [];
  for (let i = 0; i < signalLineSeries.length; i++) {
    histSeries.push(macdLine[i + 8] - signalLineSeries[i]);
  }

  const currentMacd = macdLine[macdLine.length - 1] || 0;
  const currentSignal = signalLineSeries[signalLineSeries.length - 1] || 0;
  const currentHistogram = histSeries.length ? histSeries[histSeries.length - 1] : (currentMacd - currentSignal);

  return {
    macd: currentMacd,
    signal: currentSignal,
    histogram: currentHistogram,
    macdSeries: macdLine,
    signalSeries: signalLineSeries,
    histSeries: histSeries
  };
}

// 4. Bollinger Bands (20, 2 std dev)
function calculateBollingerBands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last };
  }

  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: middle + multiplier * stdDev,
    middle: middle,
    lower: middle - multiplier * stdDev
  };
}

// 5. Stochastic RSI (14, 14, 3, 3)
function calculateStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3) {
  const { series: rsiSeries } = calculateRSI(closes, rsiPeriod);
  if (rsiSeries.length < stochPeriod) {
    return { k: 50, d: 50 };
  }

  const rawStoch = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const minRsi = Math.min(...window);
    const maxRsi = Math.max(...window);
    const currRsi = rsiSeries[i];
    const stoch = maxRsi === minRsi ? 50 : ((currRsi - minRsi) / (maxRsi - minRsi)) * 100;
    rawStoch.push(stoch);
  }

  const kValues = [];
  for (let i = kPeriod - 1; i < rawStoch.length; i++) {
    const kSlice = rawStoch.slice(i - kPeriod + 1, i + 1);
    kValues.push(kSlice.reduce((a, b) => a + b, 0) / kPeriod);
  }

  const dValues = [];
  for (let i = dPeriod - 1; i < kValues.length; i++) {
    const dSlice = kValues.slice(i - dPeriod + 1, i + 1);
    dValues.push(dSlice.reduce((a, b) => a + b, 0) / dPeriod);
  }

  const k = kValues.length ? kValues[kValues.length - 1] : 50;
  const d = dValues.length ? dValues[dValues.length - 1] : 50;

  return { k, d };
}

// 6. Volume Analysis
function calculateVolumeAnalysis(klines, period = 20) {
  const volumes = klines.map(k => k.volume);
  const currentVolume = volumes[volumes.length - 1] || 0;
  const slice = volumes.slice(-period);
  const averageVolume = slice.reduce((a, b) => a + b, 0) / slice.length;

  return {
    current: currentVolume,
    average: averageVolume
  };
}

// 7. ADX (14)
function calculateADX(klines, period = 14) {
  if (klines.length <= period * 2) {
    return { adx: 25, plusDI: 25, minusDI: 25 };
  }

  const trs = [];
  const plusDMs = [];
  const minusDMs = [];

  for (let i = 1; i < klines.length; i++) {
    const current = klines[i];
    const prev = klines[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );
    trs.push(tr);

    const upMove = current.high - prev.high;
    const downMove = prev.low - current.low;

    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let smoothedTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  const dxList = [];
  const calcDX = (tr, pDM, mDM) => {
    if (tr === 0) return 0;
    const pDI = (pDM / tr) * 100;
    const mDI = (mDM / tr) * 100;
    const sumDI = pDI + mDI;
    return sumDI === 0 ? 0 : (Math.abs(pDI - mDI) / sumDI) * 100;
  };

  dxList.push(calcDX(smoothedTR, smoothedPlusDM, smoothedMinusDM));

  for (let i = period; i < trs.length; i++) {
    smoothedTR = smoothedTR - (smoothedTR / period) + trs[i];
    smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDMs[i];
    smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDMs[i];
    dxList.push(calcDX(smoothedTR, smoothedPlusDM, smoothedMinusDM));
  }

  let adx = dxList.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxList.length; i++) {
    adx = ((adx * (period - 1)) + dxList[i]) / period;
  }

  const finalPDI = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
  const finalMDI = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;

  return {
    adx,
    plusDI: finalPDI,
    minusDI: finalMDI
  };
}

// 8. Williams %R (14)
function calculateWilliamsR(klines, period = 14) {
  if (klines.length < period) return -50;
  const slice = klines.slice(-period);
  const highestHigh = Math.max(...slice.map(k => k.high));
  const lowestLow = Math.min(...slice.map(k => k.low));
  const currentClose = slice[slice.length - 1].close;

  if (highestHigh === lowestLow) return -50;
  return ((highestHigh - currentClose) / (highestHigh - lowestLow)) * -100;
}

// 9. CCI (20)
function calculateCCI(klines, period = 20) {
  if (klines.length < period) return 0;
  const tpList = klines.map(k => (k.high + k.low + k.close) / 3);
  const slice = tpList.slice(-period);
  const smaTP = slice.reduce((a, b) => a + b, 0) / period;
  const currentTP = slice[slice.length - 1];

  const meanDev = slice.reduce((a, b) => a + Math.abs(b - smaTP), 0) / period;
  if (meanDev === 0) return 0;

  return (currentTP - smaTP) / (0.015 * meanDev);
}

// 10. MFI (14)
function calculateMFI(klines, period = 14) {
  if (klines.length <= period) return 50;

  const typicalPrices = klines.map(k => (k.high + k.low + k.close) / 3);
  const rawMoneyFlows = klines.map((k, idx) => typicalPrices[idx] * k.volume);

  const posFlows = [];
  const negFlows = [];

  for (let i = 1; i < klines.length; i++) {
    if (typicalPrices[i] > typicalPrices[i - 1]) {
      posFlows.push(rawMoneyFlows[i]);
      negFlows.push(0);
    } else if (typicalPrices[i] < typicalPrices[i - 1]) {
      posFlows.push(0);
      negFlows.push(rawMoneyFlows[i]);
    } else {
      posFlows.push(0);
      negFlows.push(0);
    }
  }

  const recentPos = posFlows.slice(-period).reduce((a, b) => a + b, 0);
  const recentNeg = negFlows.slice(-period).reduce((a, b) => a + b, 0);

  if (recentNeg === 0) return 100;
  const moneyRatio = recentPos / recentNeg;
  return 100 - (100 / (1 + moneyRatio));
}

// 11. Support & Resistance + Pivot Points
function calculateKeyLevels(klines) {
  if (!klines || klines.length < 24) return null;
  const last24 = klines.slice(-24);
  const high24h = Math.max(...last24.map(k => k.high));
  const low24h = Math.min(...last24.map(k => k.low));
  const close = last24[last24.length - 1].close;

  const pivot = (high24h + low24h + close) / 3;
  const r1 = (2 * pivot) - low24h;
  const s1 = (2 * pivot) - high24h;
  const r2 = pivot + (high24h - low24h);
  const s2 = pivot - (high24h - low24h);

  return {
    high24h: roundTo(high24h, 2),
    low24h: roundTo(low24h, 2),
    pivot: roundTo(pivot, 2),
    resistance1: roundTo(r1, 2),
    resistance2: roundTo(r2, 2),
    support1: roundTo(s1, 2),
    support2: roundTo(s2, 2)
};
}

// 12. BBI (Bull and Bear Index 多空指标: MA3 + MA6 + MA12 + MA24 / 4)
function calculateBBI(closes) {
  const n = closes.length;
  function sma(period) {
    const arr = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += closes[j];
      arr[i] = sum / period;
    }
    return arr;
  }
  const ma3 = sma(3);
  const ma6 = sma(6);
  const ma12 = sma(12);
  const ma24 = sma(24);

  const bbi = new Array(n).fill(null);
  for (let i = 23; i < n; i++) {
    bbi[i] = (ma3[i] + ma6[i] + ma12[i] + ma24[i]) / 4;
  }
  return bbi;
}

// 13. KC (Keltner Channels 肯特纳通道: EMA20 +/- 1.8 * ATR14)
function calculateKC(candles, period = 20, atrPeriod = 14, multiplier = 1.8) {
  const n = candles.length;
  const closes = candles.map(c => c.close);

  const emaArr = new Array(n).fill(null);
  if (n >= period) {
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    emaArr[period - 1] = sum / period;
    const k = 2 / (period + 1);
    for (let i = period; i < n; i++) {
      emaArr[i] = closes[i] * k + emaArr[i - 1] * (1 - k);
    }
  }

  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
  }

  const atr = new Array(n).fill(null);
  if (n > atrPeriod) {
    let sumTR = 0;
    for (let i = 1; i <= atrPeriod; i++) sumTR += tr[i];
    atr[atrPeriod] = sumTR / atrPeriod;
    for (let i = atrPeriod + 1; i < n; i++) {
      atr[i] = (atr[i - 1] * (atrPeriod - 1) + tr[i]) / atrPeriod;
    }
  }

  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);

  for (let i = Math.max(period, atrPeriod); i < n; i++) {
    if (emaArr[i] !== null && atr[i] !== null) {
      upper[i] = emaArr[i] + multiplier * atr[i];
      lower[i] = emaArr[i] - multiplier * atr[i];
    }
  }

  return { upper, middle: emaArr, lower, atr };
}

// ==========================================
// ==========================================
// PERSISTENT SIGNAL REGISTRY & DUAL-ENGINE SETTLEMENT
// 支持【正式版】与【顺势版】双引擎后台独立运行，绝不休眠
// 严格只保留与记录当天真实发出的信号，绝不回溯历史时间
// ==========================================
const SIGNALS_FILE = path.join(__dirname, 'signals_registry.json');
let signalRegistry = {
  official: {},
  trend: {}
};

function isToday(timestamp) {
  if (!timestamp) return false;
  const ms = timestamp < 1e11 ? timestamp * 1000 : timestamp;
  const targetDate = new Date(ms);
  const nowDate = new Date();
  return (
    targetDate.getFullYear() === nowDate.getFullYear() &&
    targetDate.getMonth() === nowDate.getMonth() &&
    targetDate.getDate() === nowDate.getDate()
  );
}

function loadSignalRegistry() {
  try {
    if (fs.existsSync(SIGNALS_FILE)) {
      const content = fs.readFileSync(SIGNALS_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed.official || parsed.trend) {
        signalRegistry = {
          official: parsed.official || {},
          trend: parsed.trend || {}
        };
      } else {
        // 平滑升级旧版扁平结构至 official
        signalRegistry = {
          official: parsed,
          trend: {}
        };
      }
      // 严格只保留当天真实发出的信号，清理所有历史/非当天的旧记录
      for (const ver of ['official', 'trend']) {
        const bucket = signalRegistry[ver] || {};
        for (const key of Object.keys(bucket)) {
          if (Array.isArray(bucket[key])) {
            bucket[key] = bucket[key].filter(s => isToday(s.triggerTime || s.openTime));
            for (const s of bucket[key]) {
              if (s.dateStr) s.dateStr = s.dateStr.replace(/^今天\s*/, '');
              if (s.time) s.time = s.time.replace(/^今天\s*/, '');
            }
          }
        }
      }
    } else {
      signalRegistry = { official: {}, trend: {} };
    }
  } catch (e) {
    console.warn('Failed to load signals_registry.json:', e.message);
    signalRegistry = { official: {}, trend: {} };
  }
}

function saveSignalRegistry() {
  try {
    // 保存前再次确保只持久化当天的信号
    for (const ver of ['official', 'trend']) {
      const bucket = signalRegistry[ver] || {};
      for (const key of Object.keys(bucket)) {
        if (Array.isArray(bucket[key])) {
          bucket[key] = bucket[key].filter(s => isToday(s.triggerTime || s.openTime));
        }
      }
    }
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signalRegistry, null, 2), 'utf8');
  } catch (e) {
    console.warn('Failed to save signals_registry.json:', e.message);
  }
}

loadSignalRegistry();

const SIGNAL_CONFIGS = {
  '3m': { horizonMs: 3 * 60 * 1000, cooldownMs: 3 * 60 * 1000 },
  '5m': { horizonMs: 5 * 60 * 1000, cooldownMs: 5 * 60 * 1000 },
  '10m': { horizonMs: 10 * 60 * 1000, cooldownMs: 10 * 60 * 1000 },
  '15m': { horizonMs: 15 * 60 * 1000, cooldownMs: 15 * 60 * 1000 }
};

const SIGNAL_HORIZONS_MS = {
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '10m': 10 * 60 * 1000,
  '15m': 15 * 60 * 1000
};

// ==========================================
// REAL-TIME 1-SECOND TICK EVALUATION ENGINE
// 每秒根据实时价格与分笔跳动即时判断，绝不等K线走完
// 双引擎 (official / trend) 后台全天候独立运行，绝不休眠
// ==========================================
const strategyBaselines = {
  official: {},
  trend: {}
};

function processLiveTick(normSym, currentPrice, version = 'official') {
  if (!currentPrice || currentPrice <= 0) return;
  const ver = (version === 'trend') ? 'trend' : 'official';
  const now = Date.now();
  let hasChanges = false;

  if (!signalRegistry[ver]) signalRegistry[ver] = {};
  if (!strategyBaselines[ver]) strategyBaselines[ver] = {};

  for (const tf of ['3m', '5m', '10m', '15m']) {
    const registryKey = `${normSym}:${tf}`;
    if (!signalRegistry[ver][registryKey]) signalRegistry[ver][registryKey] = [];
    const todayList = signalRegistry[ver][registryKey].filter(s => isToday(s.triggerTime || s.openTime));
    if (todayList.length !== signalRegistry[ver][registryKey].length) {
      signalRegistry[ver][registryKey] = todayList;
      hasChanges = true;
    }
    const list = signalRegistry[ver][registryKey];
    const cfg = SIGNAL_CONFIGS[tf];

    // 1. 每秒实时检测待结算单（等），到期瞬间即刻以当前秒价格结算
    for (const sig of list) {
      if (sig.status === '等' && now >= sig.settleTime) {
        const isBuy = sig.typeKey === 'BUY';
        const isWin = isBuy ? currentPrice > sig.price : currentPrice < sig.price;
        sig.status = isWin ? '吃' : '败';
        sig.settlePrice = roundTo(currentPrice, 2);
        hasChanges = true;
        console.log(`[LIVE SETTLED][${ver}] ${normSym} ${tf} ${sig.type} -> ${sig.status} (Entry: ${sig.price}, Settle: ${sig.settlePrice})`);
      }
    }

    // 2. 该周期当前若有正在进行的单子，等待其结算后再开下一单
    const activePending = list.find(s => s.status === '等');
    if (activePending) continue;

    // 3. 冷却检查（上一单结算完毕后即可捕捉下一波）
    const lastSigTime = list.length ? Math.max(...list.map(s => s.triggerTime || s.openTime)) : 0;
    if (now - lastSigTime < cfg.cooldownMs) continue;

    // 4. 根据对应版本的量化标尺，进行每秒实时碰撞分析
    const base = strategyBaselines[ver][registryKey];
    if (!base) continue;

    let sigObj = null;

    if (ver === 'official') {
      // ===== 正式版：波浪理论突破破位 + 量价共振 =====
      // 形态 1: 3浪主升 —— 价格当前秒实时冲破前高阻力
      if (!base.isMacroBear && base.isBBITrendUp && currentPrice >= base.prevHigh && base.prevHigh > base.b && base.prevHigh > base.kcM) {
        sigObj = {
          type: 'BUY',
          pattern: '【3浪主升】每秒实时突破前高+BBI放量加速'
        };
      }
      // 形态 2: 3浪主跌 —— 价格当前秒实时跌破前低支撑
      else if (!base.isMacroBull && base.isBBITrendDown && currentPrice <= base.prevLow && base.prevLow < base.b && base.prevLow < base.kcM) {
        sigObj = {
          type: 'SELL',
          pattern: '【3浪主跌】每秒实时跌破前低+BBI放量破位'
        };
      }
      // 形态 3: C浪终结 —— 价格刺破KC下轨后，当前秒实时反抽收复下轨
      else if (!base.isMacroBear && (base.recentLow < base.kcL || currentPrice < base.kcL * 1.0005) && currentPrice >= base.kcL) {
        sigObj = {
          type: 'BUY',
          pattern: '【C浪终结】每秒实时收复KC下轨企稳'
        };
      }
      // 形态 4: 5浪冲顶 —— 价格冲破KC上轨后，当前秒实时受阻跌落上轨
      else if (!base.isMacroBull && (base.recentHigh > base.kcU || currentPrice > base.kcU * 0.9995) && currentPrice <= base.kcU) {
        sigObj = {
          type: 'SELL',
          pattern: '【5浪冲顶】每秒实时受阻跌破KC上轨'
        };
      }
    } else {
      // ===== 顺势版：分析5m/10m/15m/30m/1h多周期大趋势，到达支撑压力逢低多逢高空 =====
      if (base.isMacroBull) {
        // 大趋势多头：到达支撑位逢低做多
        if (currentPrice <= base.kcL * 1.0015 && currentPrice >= base.kcL * 0.998) {
          sigObj = {
            type: 'BUY',
            pattern: '【顺势逢低做多】多头回踩KC下轨极限支撑企稳'
          };
        } else if (currentPrice >= base.b && currentPrice <= base.b * 1.002 && base.prevLow <= base.b * 1.001) {
          sigObj = {
            type: 'BUY',
            pattern: '【顺势逢低做多】多头回踩BBI生命线企稳拉升'
          };
        } else if (currentPrice >= base.kcM && currentPrice <= base.kcM * 1.002 && base.prevLow <= base.kcM * 1.001) {
          sigObj = {
            type: 'BUY',
            pattern: '【顺势逢低做多】多头回踩KC中轨强支撑企稳'
          };
        }
      } else if (base.isMacroBear) {
        // 大趋势空头：到达阻力位逢高做空
        if (currentPrice >= base.kcU * 0.9985 && currentPrice <= base.kcU * 1.002) {
          sigObj = {
            type: 'SELL',
            pattern: '【顺势逢高做空】空头冲高KC上轨遇阻回落'
          };
        } else if (currentPrice <= base.b && currentPrice >= base.b * 0.998 && base.prevHigh >= base.b * 0.999) {
          sigObj = {
            type: 'SELL',
            pattern: '【顺势逢高做空】空头反抽BBI阻力遇阻回落'
          };
        } else if (currentPrice <= base.kcM && currentPrice >= base.kcM * 0.998 && base.prevHigh >= base.kcM * 0.999) {
          sigObj = {
            type: 'SELL',
            pattern: '【顺势逢高做空】空头反抽KC中轨强阻力遇阻回落'
          };
        }
      }
    }

    if (sigObj) {
      const timeDate = new Date(now);
      const timeStr = [
        String(timeDate.getHours()).padStart(2, '0'),
        String(timeDate.getMinutes()).padStart(2, '0'),
        String(timeDate.getSeconds()).padStart(2, '0')
      ].join(':');

      const liveSig = {
        openTime: Math.floor(now / 60000) * 60000,
        triggerTime: now,
        type: sigObj.type === 'BUY' ? '做多' : '做空',
        typeKey: sigObj.type,
        wavePattern: sigObj.pattern,
        price: roundTo(currentPrice, 2),
        time: timeStr,
        dateStr: timeStr,
        status: '等',
        signalTf: tf,
        version: ver,
        settleTime: now + cfg.horizonMs
      };

      list.push(liveSig);
      hasChanges = true;
      console.log(`[LIVE TICK TRIGGERED][${ver}] ${normSym} ${tf} ${liveSig.type} at ${timeStr} price=${liveSig.price} pattern=${liveSig.wavePattern}`);
    }
  }

  if (hasChanges) {
    saveSignalRegistry();
  }
}

// Fetch dedicated timeframe candles: strictly isolates 3m, 5m, 10m, and 15m
async function fetchTimeframeCandles(normSym, tf) {
  if (tf === '3m') {
    return await fetchBinanceKlines(normSym, '3m', 350);
  } else if (tf === '5m') {
    return await fetchBinanceKlines(normSym, '5m', 350);
  } else if (tf === '10m') {
    const klines5m = await fetchBinanceKlines(normSym, '5m', 500);
    return aggregateKlinesTo10m(klines5m);
  } else if (tf === '15m') {
    return await fetchBinanceKlines(normSym, '15m', 350);
  }
  return await fetchBinanceKlines(normSym, '3m', 350);
}

// 1-Hour Macro Trend Regime Filter: guards against counter-trend suicide trades (Official Version)
async function getMacroRegime(normSym) {
  try {
    const klines1h = await fetchBinanceKlines(normSym, '1h', 150);
    if (!klines1h || klines1h.length < 50) return { regime: 'NEUTRAL' };
    const closes = klines1h.map(k => k.close);
    const currPrice = closes[closes.length - 1];
    const ema50Series = calculateEMA(closes, 50);
    const ema200Series = calculateEMA(closes, Math.min(200, closes.length - 1));
    const ema50 = ema50Series[ema50Series.length - 1] || currPrice;
    const ema200 = ema200Series.length ? ema200Series[ema200Series.length - 1] : ema50;

    if (currPrice > ema50 && ema50 >= ema200 * 0.998) {
      return { regime: 'BULL', ema50, ema200, currPrice };
    } else if (currPrice < ema50 && ema50 <= ema200 * 1.002) {
      return { regime: 'BEAR', ema50, ema200, currPrice };
    } else if (currPrice < ema50) {
      return { regime: 'WEAK_BEAR', ema50, ema200, currPrice };
    } else {
      return { regime: 'WEAK_BULL', ema50, ema200, currPrice };
    }
  } catch (e) {
    return { regime: 'NEUTRAL' };
  }
}

// 顺势版大趋势研判引擎：综合分析 5m、10m、15m、30m、1h 多周期K线 + KC + BBI + 量价
async function getTrendMacroRegime(normSym) {
  try {
    const [k5m, k15m, k30m, k1h] = await Promise.all([
      fetchBinanceKlines(normSym, '5m', 160).catch(() => []),
      fetchBinanceKlines(normSym, '15m', 80).catch(() => []),
      fetchBinanceKlines(normSym, '30m', 80).catch(() => []),
      fetchBinanceKlines(normSym, '1h', 120).catch(() => [])
    ]);

    // 聚合 10m K线（严格按整10分钟对齐）
    const k10m = aggregateKlinesTo10m(k5m);

    const calcTfSlope = (klines, weight) => {
      if (!klines || klines.length < 25) return 0;
      const closes = klines.map(k => k.close);
      const bbi = calculateBBI(closes);
      const kc = calculateKC(klines, 20, 14, 1.8);
      const last = closes.length - 1;
      const b = bbi[last];
      const bPrev = bbi[last - 1];
      const kcM = kc.middle[last];
      const kcMPrev = kc.middle[last - 1];
      let score = 0;
      if (b && bPrev) {
        const slope = (b - bPrev) / b;
        if (slope > 0.0003) score += 50;
        else if (slope < -0.0003) score -= 50;
      }
      if (kcM && kcMPrev) {
        const slope = (kcM - kcMPrev) / kcM;
        if (slope > 0.0003) score += 30;
        else if (slope < -0.0003) score -= 30;
      }
      if (closes[last] > b) score += 10;
      else if (closes[last] < b) score -= 10;
      if (closes[last] > kcM) score += 10;
      else if (closes[last] < kcM) score -= 10;
      return score * weight;
    };

    let totalScore = 0;
    totalScore += calcTfSlope(k1h, 0.35);
    totalScore += calcTfSlope(k30m, 0.25);
    totalScore += calcTfSlope(k15m, 0.20);
    totalScore += calcTfSlope(k10m, 0.12);
    totalScore += calcTfSlope(k5m, 0.08);

    const isBull = totalScore >= 18;
    const isBear = totalScore <= -18;
    return {
      score: Math.round(totalScore),
      isBull,
      isBear,
      regime: isBull ? 'BULL' : (isBear ? 'BEAR' : 'NEUTRAL')
    };
  } catch (e) {
    return { score: 0, isBull: false, isBear: false, regime: 'NEUTRAL' };
  }
}



async function getOrGenerateSignals(symbol, chartKlines, signalTf = '3m', version = 'official') {
  const normSym = normalizeSymbol(symbol);
  const tf = SIGNAL_CONFIGS[signalTf] ? signalTf : '3m';
  const cfg = SIGNAL_CONFIGS[tf];
  const horizonMs = cfg.horizonMs;
  const ver = (version === 'trend') ? 'trend' : 'official';
  const registryKey = `${normSym}:${tf}`;

  if (!signalRegistry[ver]) signalRegistry[ver] = {};
  if (!signalRegistry[ver][registryKey]) {
    signalRegistry[ver][registryKey] = [];
  }
  const registryList = signalRegistry[ver][registryKey];

  // Guarantee high-resolution 1m candles (1000 bars) for continuous natural minute timing
  let klines1m = (chartKlines && chartKlines.length >= 400) ? chartKlines : null;
  if (!klines1m) {
    try {
      klines1m = await fetchBinanceKlines(normSym, '1m', 1000);
    } catch (e) {
      klines1m = chartKlines || [];
    }
  }

  // Fetch dedicated timeframe candles (completely decoupled across 3m, 5m, 10m, 15m)
  let evalCandles = [];
  try {
    evalCandles = await fetchTimeframeCandles(normSym, tf);
  } catch (e) {
    evalCandles = klines1m || [];
  }

  if (!evalCandles || evalCandles.length < 50) {
    evalCandles = klines1m || [];
  }

  // Multi-timeframe trend regime calculation
  let macro = null;
  let trendMacro = null;
  if (ver === 'trend') {
    trendMacro = await getTrendMacroRegime(normSym);
  } else {
    macro = await getMacroRegime(normSym);
  }

  const now = Date.now();
  let hasChanges = false;

  // 1. Settle any existing pending signals ('等') whose horizon has passed
  for (const sig of registryList) {
    if (sig.status === '等') {
      const targetSettleTime = sig.settleTime || (sig.openTime + horizonMs);
      if (now >= targetSettleTime) {
        let settleCandle = null;
        if (chartKlines && chartKlines.length) {
          settleCandle = chartKlines.find(c => c.openTime <= targetSettleTime && targetSettleTime < (c.openTime + 60000)) ||
                         chartKlines.find(c => c.openTime >= targetSettleTime);
          if (!settleCandle && now >= targetSettleTime) {
            settleCandle = chartKlines[chartKlines.length - 1];
          }
        }
        if (!settleCandle && evalCandles && evalCandles.length) {
          settleCandle = evalCandles.find(c => c.openTime >= targetSettleTime) || evalCandles[evalCandles.length - 1];
        }

        if (settleCandle) {
          const isBuy = sig.typeKey === 'BUY';
          const isWin = isBuy ? settleCandle.close > sig.price : settleCandle.close < sig.price;
          sig.status = isWin ? '吃' : '败';
          sig.settlePrice = settleCandle.close;
          hasChanges = true;
        }
      }
    }
  }

  // 2. Precalculate timeframe indicators (100% causal, strictly aligned with candle index)
  const nCandles = evalCandles.length;
  const closes = evalCandles.map(k => k.close);
  const volumes = evalCandles.map(k => k.volume);

  const bbiSeries = calculateBBI(closes);
  const kcSeries = calculateKC(evalCandles, 20, 14, 1.8);

  const volMA20 = new Array(nCandles).fill(0);
  for (let i = 0; i < nCandles; i++) {
    const s = Math.max(0, i - 19);
    let sum = 0;
    for (let j = s; j <= i; j++) sum += volumes[j];
    volMA20[i] = sum / (i - s + 1);
  }

  // 2. 更新最新量化标尺缓存与实时碰撞判断 (绝不再回溯历史K线出信号，只基于实时分笔跳动即时出信号)
  if (evalCandles.length >= 25) {
    const lastIdx = evalCandles.length - 1;
    const lastK = evalCandles[lastIdx];
    const prevK = evalCandles[lastIdx - 1];
    const bLive = bbiSeries[lastIdx - 1];
    const bLivePrev = bbiSeries[lastIdx - 2];
    const kcU_Live = kcSeries.upper[lastIdx - 1];
    const kcL_Live = kcSeries.lower[lastIdx - 1];
    const kcM_Live = kcSeries.middle[lastIdx - 1];
    const avgVolLive = volMA20[lastIdx - 1] || 1;

    if (bLive && bLivePrev && kcU_Live && kcL_Live && kcM_Live && prevK) {
      if (!strategyBaselines[ver]) strategyBaselines[ver] = {};
      const bbiSlopeLive = (bLive - bLivePrev) / bLive;

      if (ver === 'trend') {
        strategyBaselines[ver][registryKey] = {
          b: bLive,
          b_prev: bLivePrev,
          kcU: kcU_Live,
          kcL: kcL_Live,
          kcM: kcM_Live,
          prevHigh: prevK.high,
          prevLow: prevK.low,
          avgVol: avgVolLive,
          recentLow: Math.min(prevK.low, lastK ? lastK.low : prevK.low),
          recentHigh: Math.max(prevK.high, lastK ? lastK.high : prevK.high),
          isMacroBull: trendMacro ? trendMacro.isBull : false,
          isMacroBear: trendMacro ? trendMacro.isBear : false,
          trendScore: trendMacro ? trendMacro.score : 0,
          updated: Date.now()
        };
      } else {
        strategyBaselines[ver][registryKey] = {
          b: bLive,
          b_prev: bLivePrev,
          kcU: kcU_Live,
          kcL: kcL_Live,
          kcM: kcM_Live,
          prevHigh: prevK.high,
          prevLow: prevK.low,
          avgVol: avgVolLive,
          recentLow: Math.min(prevK.low, lastK ? lastK.low : prevK.low),
          recentHigh: Math.max(prevK.high, lastK ? lastK.high : prevK.high),
          isBBITrendUp: bbiSlopeLive >= 0.0001,
          isBBITrendDown: bbiSlopeLive <= -0.0001,
          isMacroBear: macro && (macro.regime === 'BEAR' || macro.regime === 'WEAK_BEAR'),
          isMacroBull: macro && (macro.regime === 'BULL' || macro.regime === 'WEAK_BULL'),
          updated: Date.now()
        };
      }

      const livePrice = (klines1m && klines1m.length) ? klines1m[klines1m.length - 1].close : lastK.close;
      processLiveTick(normSym, livePrice, ver);
    }
  }

  // 严格只保留与记录当天真实发出的信号
  const todaySignals = registryList.filter(s => isToday(s.triggerTime || s.openTime));

  if (todaySignals.length !== registryList.length) {
    signalRegistry[ver][registryKey] = todaySignals;
    hasChanges = true;
  }

  if (hasChanges) {
    saveSignalRegistry();
  }

  // 3. Map signals onto chartKlines (仅映射当天信号到K线图上)
  const markers = [];
  const sortedSignals = [...todaySignals].sort((a, b) => (a.openTime || a.triggerTime) - (b.openTime || b.triggerTime));

  for (const s of sortedSignals) {
    let matchedCandle = null;
    const sigT = s.openTime || s.triggerTime;

    // 1. Direct match on openTime
    if (chartKlines && chartKlines.length) {
      matchedCandle = chartKlines.find(c => c.openTime === sigT);
    }

    // 2. Interval match: c.openTime <= sigT < nextC.openTime
    if (!matchedCandle && chartKlines && chartKlines.length) {
      for (let i = 0; i < chartKlines.length; i++) {
        const c = chartKlines[i];
        const nextC = chartKlines[i + 1];
        if (nextC) {
          if (sigT >= c.openTime && sigT < nextC.openTime) {
            matchedCandle = c;
            break;
          }
        } else {
          if (sigT >= c.openTime) {
            matchedCandle = c;
            break;
          }
        }
      }
    }

    // 3. Fallback for pending signals that trigger at or beyond current closed bars
    if (!matchedCandle && s.status === '等' && chartKlines && chartKlines.length) {
      matchedCandle = chartKlines[chartKlines.length - 1];
    }

    if (matchedCandle) {
      const isBuy = s.typeKey === 'BUY';
      let markerColor = '#f59e0b';
      if (s.status === '吃') markerColor = '#10b981';
      else if (s.status === '败') markerColor = '#64748b';

      const displayText = s.status === '等' ? (isBuy ? '多' : '空') : s.status;

      markers.push({
        time: Math.floor(matchedCandle.openTime / 1000),
        position: isBuy ? 'belowBar' : 'aboveBar',
        color: markerColor,
        shape: isBuy ? 'arrowUp' : 'arrowDown',
        text: displayText,
        status: s.status,
        type: s.typeKey,
        wavePattern: s.wavePattern || (ver === 'trend' ? '多周期支撑压力顺势' : 'BBI+KC量价共振'),
        isLive: s.status === '等',
        openTime: s.openTime,
        price: s.price,
        signalTf: s.signalTf,
        version: ver
      });
    }
  }

  // Deduplicate markers by time (keep latest, but always prioritize live pending signals)
  const uniqueMarkersMap = new Map();
  for (const m of markers) {
    const existing = uniqueMarkersMap.get(m.time);
    if (!existing || m.status === '等' || (m.openTime >= existing.openTime && existing.status !== '等')) {
      uniqueMarkersMap.set(m.time, m);
    }
  }
  const finalMarkers = Array.from(uniqueMarkersMap.values());

  // Recent signals for sidebar (仅当天真实发出的信号，降序展示)
  const recentSignals = [...todaySignals].sort((a, b) => (b.triggerTime || b.openTime) - (a.triggerTime || a.openTime)).slice(0, 35);

  const winCount = todaySignals.filter(s => s.status === '吃').length;
  const lossCount = todaySignals.filter(s => s.status === '败').length;
  const pendingCount = todaySignals.filter(s => s.status === '等').length;
  const settledCount = winCount + lossCount;
  const todayTotal = winCount + lossCount + pendingCount;

  let winRate = '0.0';
  if (settledCount > 0) {
    winRate = ((winCount / settledCount) * 100).toFixed(1);
  }

  const backtestStats = computeBacktestStatsForSymbol(normSym, ver);

  return {
    markers: finalMarkers,
    stats: {
      winRate: winRate,
      todayTotal: todayTotal,
      winCount: winCount,
      lossCount: lossCount,
      pendingCount: pendingCount
    },
    recentSignals,
    backtestStats,
    version: ver
  };
}

// Compute real quantitative statistics across all timeframes for a symbol (仅统计当天真实发出的信号)
function computeBacktestStatsForSymbol(normSym, version = 'official') {
  const ver = (version === 'trend') ? 'trend' : 'official';
  const bucket = signalRegistry[ver] || {};
  const tfs = ['3m', '5m', '10m', '15m'];
  const result = {};
  let totalWins = 0;
  let totalLosses = 0;

  for (const t of tfs) {
    const list = (bucket[`${normSym}:${t}`] || []).filter(s => isToday(s.triggerTime || s.openTime));
    const wins = list.filter(s => s.status === '吃').length;
    const losses = list.filter(s => s.status === '败').length;
    const settled = wins + losses;
    const rate = settled > 0 ? ((wins / settled) * 100).toFixed(1) : '0.0';
    result[t] = { rate, wins, losses, total: settled };
    totalWins += wins;
    totalLosses += losses;
  }

  const totalSettled = totalWins + totalLosses;
  const overallRate = totalSettled > 0 ? ((totalWins / totalSettled) * 100).toFixed(1) : '0.0';
  result['overall'] = { rate: overallRate, wins: totalWins, losses: totalLosses, total: totalSettled };
  return result;
}

// Evaluate Standard Indicators for a timeframe
function evaluateSignals(klines) {
  const closes = klines.map(k => k.close);
  const currentPrice = closes[closes.length - 1];
  const lastCandle = klines[klines.length - 1];

  // 1. RSI
  const rsiResult = calculateRSI(closes, 14);
  const rsiVal = rsiResult.current;
  let rsiSignal = 'NEUTRAL';
  if (rsiVal >= 52) rsiSignal = 'BUY';
  else if (rsiVal <= 48) rsiSignal = 'SELL';

  // 2. MACD
  const macdResult = calculateMACD(closes);
  let macdSignal = 'NEUTRAL';
  if (macdResult.histogram > 0) macdSignal = 'BUY';
  else if (macdResult.histogram < 0) macdSignal = 'SELL';

  // 3. EMAs
  const ema7Series = calculateEMA(closes, 7);
  const ema21Series = calculateEMA(closes, 21);
  const ema50Series = calculateEMA(closes, 50);

  const ema7Val = ema7Series[ema7Series.length - 1] || currentPrice;
  const ema21Val = ema21Series[ema21Series.length - 1] || currentPrice;
  const ema50Val = ema50Series[ema50Series.length - 1] || currentPrice;

  const ema7Signal = currentPrice >= ema7Val ? 'BUY' : 'SELL';
  const ema21Signal = currentPrice >= ema21Val ? 'BUY' : 'SELL';
  const ema50Signal = currentPrice >= ema50Val ? 'BUY' : 'SELL';

  // 4. Bollinger Bands
  const bbResult = calculateBollingerBands(closes, 20, 2);
  let bbSignal = 'NEUTRAL';
  if (currentPrice <= bbResult.lower) bbSignal = 'BUY';
  else if (currentPrice >= bbResult.upper) bbSignal = 'SELL';

  // 5. Stochastic RSI
  const stochRsiResult = calculateStochRSI(closes, 14, 14, 3, 3);
  let stochRsiSignal = 'NEUTRAL';
  if (stochRsiResult.k > stochRsiResult.d) stochRsiSignal = 'BUY';
  else if (stochRsiResult.k < stochRsiResult.d) stochRsiSignal = 'SELL';

  // 6. Volume
  const volResult = calculateVolumeAnalysis(klines, 20);
  let volSignal = 'NEUTRAL';
  if (volResult.current > volResult.average) {
    volSignal = lastCandle.close >= lastCandle.open ? 'BUY' : 'SELL';
  }

  // 7. ADX
  const adxResult = calculateADX(klines, 14);
  let adxSignal = 'NEUTRAL';
  if (adxResult.adx >= 25) {
    if (adxResult.plusDI > adxResult.minusDI + 1) adxSignal = 'BUY';
    else if (adxResult.minusDI > adxResult.plusDI + 1) adxSignal = 'SELL';
  }

  // 8. Williams %R
  const willR = calculateWilliamsR(klines, 14);
  let willRSignal = 'NEUTRAL';
  if (willR > -50) willRSignal = 'BUY';
  else if (willR < -50) willRSignal = 'SELL';

  // 9. CCI
  const cciVal = calculateCCI(klines, 20);
  let cciSignal = 'NEUTRAL';
  if (cciVal > 20) cciSignal = 'BUY';
  else if (cciVal < -20) cciSignal = 'SELL';

  // 10. MFI
  const mfiVal = calculateMFI(klines, 14);
  let mfiSignal = 'NEUTRAL';
  if (mfiVal > 50) mfiSignal = 'BUY';
  else if (mfiVal < 50) mfiSignal = 'SELL';

  const indicators = {
    rsi: { value: roundTo(rsiVal, 1), signal: rsiSignal },
    macd: { value: roundTo(macdResult.macd, 2), signal: macdSignal, histogram: roundTo(macdResult.histogram, 2) },
    ema7: { value: roundTo(ema7Val, 2), signal: ema7Signal },
    ema21: { value: roundTo(ema21Val, 2), signal: ema21Signal },
    ema50: { value: roundTo(ema50Val, 2), signal: ema50Signal },
    bb: { upper: roundTo(bbResult.upper, 2), middle: roundTo(bbResult.middle, 2), lower: roundTo(bbResult.lower, 2), signal: bbSignal },
    stochRsi: { k: Math.round(stochRsiResult.k), d: Math.round(stochRsiResult.d), signal: stochRsiSignal },
    volume: { current: roundTo(volResult.current, 2), average: roundTo(volResult.average, 2), signal: volSignal },
    adx: { value: roundTo(adxResult.adx, 1), signal: adxSignal },
    williamsR: { value: roundTo(willR, 1), signal: willRSignal },
    cci: { value: roundTo(cciVal, 1), signal: cciSignal },
    mfi: { value: roundTo(mfiVal, 1), signal: mfiSignal }
  };

  const scoreMap = { BUY: 1, SELL: -1, NEUTRAL: 0 };
  const emaAvgScore = (scoreMap[ema7Signal] + scoreMap[ema21Signal] + scoreMap[ema50Signal]) / 3;

  const totalWeightedScore =
    (scoreMap[rsiSignal] * 12) +
    (scoreMap[macdSignal] * 15) +
    (emaAvgScore * 13) +
    (scoreMap[bbSignal] * 10) +
    (scoreMap[stochRsiSignal] * 10) +
    (scoreMap[volSignal] * 8) +
    (scoreMap[adxSignal] * 8) +
    (scoreMap[willRSignal] * 8) +
    (scoreMap[cciSignal] * 8) +
    (scoreMap[mfiSignal] * 8);

  const allSignals = [
    rsiSignal, macdSignal, ema7Signal, ema21Signal, ema50Signal,
    bbSignal, stochRsiSignal, volSignal, adxSignal, willRSignal, cciSignal, mfiSignal
  ];

  const summary = {
    buy: allSignals.filter(s => s === 'BUY').length,
    sell: allSignals.filter(s => s === 'SELL').length,
    neutral: allSignals.filter(s => s === 'NEUTRAL').length
  };

  return {
    currentPrice,
    indicators,
    score: totalWeightedScore,
    summary
  };
}

// Higher-Timeframe Trend & Bull/Bear Benchmark (15m, 1h, 4h)
function evaluateHigherTimeframe(klines, label) {
  if (!klines || klines.length < 30) {
    return { trend: 'NEUTRAL', score: 0, ema200: null, ema50: null, desc: '数据积累中' };
  }

  const closes = klines.map(k => k.close);
  const currentPrice = closes[closes.length - 1];

  const ema50Series = calculateEMA(closes, 50);
  const ema200Series = closes.length >= 100 ? calculateEMA(closes, Math.min(200, closes.length - 1)) : [];

  const ema50 = ema50Series[ema50Series.length - 1];
  const ema200 = ema200Series.length ? ema200Series[ema200Series.length - 1] : null;

  const rsi = calculateRSI(closes, 14).current;
  const macd = calculateMACD(closes);

  let trendScore = 0;

  // EMA200 is the ultimate bull/bear line
  if (ema200) {
    if (currentPrice > ema200) trendScore += 35;
    else trendScore -= 35;
  }

  // EMA50
  if (currentPrice > ema50) trendScore += 25;
  else trendScore -= 25;

  // MACD
  if (macd.histogram > 0) trendScore += 20;
  else trendScore -= 20;

  // RSI
  if (rsi > 55) trendScore += 20;
  else if (rsi < 45) trendScore -= 20;

  let trend = 'NEUTRAL';
  let desc = '区间震荡';

  if (trendScore >= 40) {
    trend = 'BULLISH';
    desc = ema200 && currentPrice > ema200 ? '强势多头（站稳EMA200上方）' : '波段看涨';
  } else if (trendScore <= -40) {
    trend = 'BEARISH';
    desc = ema200 && currentPrice < ema200 ? '弱势空头（受制于EMA200下方）' : '波段看跌';
  }

  return {
    label,
    trend,
    score: trendScore,
    currentPrice: roundTo(currentPrice, 2),
    ema50: ema50 ? roundTo(ema50, 2) : null,
    ema200: ema200 ? roundTo(ema200, 2) : null,
    distEma200Pct: ema200 ? roundTo(((currentPrice - ema200) / ema200) * 100, 2) : null,
    rsi: roundTo(rsi, 1),
    macdHist: roundTo(macd.histogram, 2),
    desc
  };
}

// Multi-Timeframe Resonance Engine
function computeMTFPredictions(eval1m, eval5m, htf15m, htf1h, htf4h) {
  const s1m = eval1m.score;
  const s5m = eval5m.score;
  const s15m = htf15m.score;
  const s1h = htf1h.score;

  // Resonance Alignment
  const isAllBull = (s1m > 15 && s5m > 15 && s15m > 15 && s1h > 10);
  const isAllBear = (s1m < -15 && s5m < -15 && s15m < -15 && s1h < -10);

  let alignmentState = 'MIXED';
  let alignmentDesc = '大小周期分化，震荡洗盘';
  let resonanceBonus = 0;

  if (isAllBull) {
    alignmentState = 'STRONG_BULL_RESONANCE';
    alignmentDesc = '🔥 多周期强共振看涨（1m/5m/15m/1h全线做多）';
    resonanceBonus = 18;
  } else if (isAllBear) {
    alignmentState = 'STRONG_BEAR_RESONANCE';
    alignmentDesc = '🩸 多周期强共振看跌（1m/5m/15m/1h全线做空）';
    resonanceBonus = -18;
  } else if (s1h <= -30 && s1m > 20) {
    alignmentState = 'COUNTER_TREND_BOUNCE';
    alignmentDesc = '⚠️ 逆大势弱反弹（1小时处于空头，短多警惕诱多回落）';
  } else if (s1h >= 30 && s1m < -20) {
    alignmentState = 'COUNTER_TREND_PULLBACK';
    alignmentDesc = '⚠️ 牛市健康回踩（1小时处于多头，短空警惕急跌插针拉升）';
  } else if (s1h > 20 && s15m > 20) {
    alignmentState = 'BULL_TREND';
    alignmentDesc = '📈 大级别多头主导';
  } else if (s1h < -20 && s15m < -20) {
    alignmentState = 'BEAR_TREND';
    alignmentDesc = '📉 大级别空头压制';
  }

  // Timeframe Weights incorporating long-term context:
  // 3m: 45% 1m + 30% 5m + 15% 15m + 10% 1h + bonus
  const rawScore3m = (s1m * 0.45) + (s5m * 0.30) + (s15m * 0.15) + (s1h * 0.10) + resonanceBonus;

  // 5m: 25% 1m + 40% 5m + 20% 15m + 15% 1h + bonus
  const rawScore5m = (s1m * 0.25) + (s5m * 0.40) + (s15m * 0.20) + (s1h * 0.15) + resonanceBonus;

  // 10m: 15% 1m + 30% 5m + 30% 15m + 25% 1h + bonus
  const rawScore10m = (s1m * 0.15) + (s5m * 0.30) + (s15m * 0.30) + (s1h * 0.25) + resonanceBonus;

  const formatPrediction = (score, tfLabel) => {
    const clampedScore = Math.max(-100, Math.min(100, Math.round(score)));
    const direction = clampedScore >= 0 ? 'UP' : 'DOWN';
    
    // Higher base confidence if resonance alignment aligns
    let confBase = 52 + Math.abs(clampedScore) * 0.45;
    if (Math.abs(resonanceBonus) > 0) confBase += 6;
    
    // Penalize counter-trend setups
    if (alignmentState.startsWith('COUNTER_TREND')) {
      confBase = Math.min(68, confBase);
    }

    const confidence = roundTo(Math.min(96.5, Math.max(50.1, confBase)), 1);

    return {
      direction,
      confidence,
      score: clampedScore,
      resonanceBonus
    };
  };

  return {
    predictions: {
      '3m': formatPrediction(rawScore3m, '3m'),
      '5m': formatPrediction(rawScore5m, '5m'),
      '10m': formatPrediction(rawScore10m, '10m')
    },
    alignment: {
      state: alignmentState,
      description: alignmentDesc
    }
  };
}

// ==========================================
// API ROUTES
// ==========================================

// 1. Current Price & 24h Stats
app.get('/api/price/:symbol', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const [priceData, stats24h] = await Promise.all([
      fetchBinancePrice(symbol),
      fetchBinance24hStats(symbol).catch(() => null)
    ]);
    if (priceData && priceData.price) {
      processLiveTick(symbol, priceData.price, 'official');
      processLiveTick(symbol, priceData.price, 'trend');
    }
    res.json({
      symbol: priceData.symbol,
      price: priceData.price,
      change24h: stats24h ? stats24h.priceChangePercent : 0,
      high24h: stats24h ? stats24h.highPrice : 0,
      low24h: stats24h ? stats24h.lowPrice : 0
    });
  } catch (err) {
    console.error(`Error in /api/price/${req.params.symbol}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. Orderbook Depth Route
app.get('/api/depth/:symbol', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const limit = parseInt(req.query.limit, 10) || 8;
    const depth = await fetchBinanceDepth(symbol, Math.min(limit, 20));
    res.json(depth);
  } catch (err) {
    console.error(`Error in /api/depth/${req.params.symbol}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. Klines with extended support, markers, stats & live settlement list (支持 version: official | trend)
app.get('/api/klines/:symbol/:interval', async (req, res) => {
  try {
    const { symbol, interval } = req.params;
    const signalTf = req.query.signalTf || '3m';
    const version = req.query.version || 'official';
    const limit = parseInt(req.query.limit, 10) || 500;
    const normSym = normalizeSymbol(symbol);
    const klines = await fetchBinanceKlines(symbol, interval, Math.min(limit, 1000));

    // Ensure all strategy timeframes have real backtesting data generated for requested version
    for (const t of ['3m', '5m', '10m', '15m']) {
      if (!signalRegistry[version] || !signalRegistry[version][`${normSym}:${t}`] || signalRegistry[version][`${normSym}:${t}`].length === 0) {
        await getOrGenerateSignals(normSym, klines, t, version);
      }
    }

    const markerData = await getOrGenerateSignals(normSym, klines, signalTf, version);
    res.json({
      symbol: normSym,
      interval,
      signalTf,
      version,
      klines,
      markers: markerData.markers,
      stats: markerData.stats,
      recentSignals: markerData.recentSignals,
      backtestStats: markerData.backtestStats
    });
  } catch (err) {
    console.error(`Error in /api/klines/${req.params.symbol}/${req.params.interval}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. Complete Prediction Signal & Multi-Timeframe Resonance Engine
app.get('/api/signal/:symbol', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const version = req.query.version || 'official';
    const cacheKey = `signal:${symbol}:${version}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Parallel fetch: 1m, 5m, 15m, 1h, 4h klines + 24h ticker
    const [klines1m, klines5m, klines15m, klines1h, klines4h, tickerPrice, stats24h] = await Promise.all([
      fetchBinanceKlines(symbol, '1m', 150),
      fetchBinanceKlines(symbol, '5m', 120),
      fetchBinanceKlines(symbol, '15m', 120),
      fetchBinanceKlines(symbol, '1h', 250),
      fetchBinanceKlines(symbol, '4h', 80),
      fetchBinancePrice(symbol),
      fetchBinance24hStats(symbol).catch(() => null)
    ]);

    // Micro evaluations
    const eval1m = evaluateSignals(klines1m);
    const eval5m = evaluateSignals(klines5m);

    // Higher Timeframe Evaluations (Longer Horizon Context)
    const htf15m = evaluateHigherTimeframe(klines15m, '15分钟');
    const htf1h = evaluateHigherTimeframe(klines1h, '1小时');
    const htf4h = evaluateHigherTimeframe(klines4h, '4小时');

    // Key Levels (Pivot points & 24h high/low)
    const keyLevels = calculateKeyLevels(klines1h);

    // Multi-Timeframe Resonance Predictions
    const { predictions, alignment } = computeMTFPredictions(eval1m, eval5m, htf15m, htf1h, htf4h);

    const result = {
      symbol: symbol,
      version: version,
      currentPrice: tickerPrice.price,
      change24h: stats24h ? stats24h.priceChangePercent : 0,
      timestamp: Date.now(),
      predictions,
      alignment,
      higherTimeframes: {
        '15m': htf15m,
        '1h': htf1h,
        '4h': htf4h
      },
      keyLevels,
      indicators: eval1m.indicators,
      summary: eval1m.summary
    };

    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error(`Error in /api/signal/${req.params.symbol}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. Notifications Aggregator (BTC & ETH across all 4 timeframes, 支持 version: official | trend | ALL | 组合)
app.get('/api/notifications', (req, res) => {
  try {
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const timeframes = ['3m', '5m', '10m', '15m'];
    const notifs = [];

    let targetVersions = ['official'];
    if (req.query.version) {
      if (req.query.version === 'ALL') {
        targetVersions = ['official', 'trend'];
      } else {
        targetVersions = req.query.version.split(',').map(v => v.trim()).filter(Boolean);
      }
    }

    const queryCoin = req.query.coin ? req.query.coin.toUpperCase() : null;
    const queryTf = req.query.timeframe ? req.query.timeframe.toLowerCase() : null;

    for (const ver of targetVersions) {
      const bucket = signalRegistry[ver] || {};

      for (const sym of symbols) {
        const coin = sym.replace('USDT', '');
        if (queryCoin && queryCoin !== 'ALL' && queryCoin !== coin) continue;

        for (const tf of timeframes) {
          if (queryTf && queryTf !== 'ALL' && queryTf !== tf) continue;

          const key = `${sym}:${tf}`;
          const list = (bucket[key] || []).filter(s => isToday(s.triggerTime || s.openTime));

          for (const s of list) {
            const cleanTime = (s.time || s.dateStr || '').replace(/^今天\s*/, '');
            notifs.push({
              id: `${ver}-${sym}-${tf}-${s.openTime}`,
              version: ver,
              symbol: sym,
              coin: coin,
              timeframe: tf,
              type: s.type || (s.typeKey === 'BUY' ? '做多' : '做空'),
              typeKey: s.typeKey || (s.type === '做多' ? 'BUY' : 'SELL'),
              wavePattern: s.wavePattern || (ver === 'trend' ? '多周期支撑压力顺势' : 'BBI+KC量价共振'),
              price: s.price,
              settlePrice: s.settlePrice || null,
              status: s.status,
              time: cleanTime,
              openTime: s.openTime,
              triggerTime: s.triggerTime || s.openTime,
              settleTime: s.settleTime || ((s.triggerTime || s.openTime) + (SIGNAL_DURATIONS[tf] || 5*60*1000))
            });
          }
        }
      }
    }

    // Sort newest first
    notifs.sort((a, b) => (b.triggerTime || b.openTime) - (a.triggerTime || a.openTime));

    res.json({
      version: req.query.version || 'official',
      versions: targetVersions,
      notifications: notifs.slice(0, 150),
      total: notifs.length,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('Error in /api/notifications:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Dedicated Comprehensive Backtest Statistics Endpoint (双版本 · 双币种 全周期实时统计)
app.get('/api/backtest-stats', (req, res) => {
  try {
    const stats = {
      official: {
        BTC: computeBacktestStatsForSymbol('BTCUSDT', 'official'),
        ETH: computeBacktestStatsForSymbol('ETHUSDT', 'official')
      },
      trend: {
        BTC: computeBacktestStatsForSymbol('BTCUSDT', 'trend'),
        ETH: computeBacktestStatsForSymbol('ETHUSDT', 'trend')
      },
      timestamp: Date.now()
    };

    const calcVerTotal = (verStats) => {
      const wins = (verStats.BTC.overall.wins || 0) + (verStats.ETH.overall.wins || 0);
      const losses = (verStats.BTC.overall.losses || 0) + (verStats.ETH.overall.losses || 0);
      const total = wins + losses;
      const rate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
      return { wins, losses, total, rate };
    };

    stats.official.total = calcVerTotal(stats.official);
    stats.trend.total = calcVerTotal(stats.trend);

    const grandWins = stats.official.total.wins + stats.trend.total.wins;
    const grandLosses = stats.official.total.losses + stats.trend.total.losses;
    const grandTotal = grandWins + grandLosses;
    const grandRate = grandTotal > 0 ? ((grandWins / grandTotal) * 100).toFixed(1) : '0.0';

    stats.grandTotal = {
      wins: grandWins,
      losses: grandLosses,
      total: grandTotal,
      rate: grandRate
    };

    res.json(stats);
  } catch (err) {
    console.error('Error in /api/backtest-stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Background sync poller to keep BTC & ETH all 4 timeframes updated and settled (双引擎后台运行，绝不休眠)
async function syncAllSignals() {
  try {
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      let klines1m = null;
      try {
        klines1m = await fetchBinanceKlines(sym, '1m', 1000);
      } catch (e) {}

      for (const tf of ['3m', '5m', '10m', '15m']) {
        await getOrGenerateSignals(sym, klines1m, tf, 'official');
        await getOrGenerateSignals(sym, klines1m, tf, 'trend');
      }
    }
  } catch (e) {
    // ignore transient fetch errors
  }
}

// 每秒高频实时行情监听轮询器（1000ms），双引擎同时触发信号！
async function highFreqTickerLoop() {
  try {
    const prices = await fetchWithFallback('/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22%5D');
    if (Array.isArray(prices)) {
      for (const item of prices) {
        const p = parseFloat(item.price);
        if (p > 0) {
          processLiveTick(item.symbol, p, 'official');
          processLiveTick(item.symbol, p, 'trend');
        }
      }
    }
  } catch (e) {
    try {
      const pBtc = await fetchBinancePrice('BTCUSDT');
      if (pBtc && pBtc.price) {
        processLiveTick('BTCUSDT', pBtc.price, 'official');
        processLiveTick('BTCUSDT', pBtc.price, 'trend');
      }
      const pEth = await fetchBinancePrice('ETHUSDT');
      if (pEth && pEth.price) {
        processLiveTick('ETHUSDT', pEth.price, 'official');
        processLiveTick('ETHUSDT', pEth.price, 'trend');
      }
    } catch (err) {}
  }
}

// 每1秒实时检测分笔跳动，满足条件即刻在当前秒出信号！
setInterval(highFreqTickerLoop, 1000);
setTimeout(highFreqTickerLoop, 800);

// 每8秒同步一次K线基准标尺
setInterval(syncAllSignals, 8000);
setTimeout(syncAllSignals, 1500);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Crypto Signal Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
