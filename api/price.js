import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const GRADERS = ['PSA', 'BGS', 'CGC', 'EAS', 'TAG'];
const BASE_WEIGHTS = { PSA: 0.35, BGS: 0.25, CGC: 0.15, EAS: 0.15, TAG: 0.1 };
const LANGUAGES = ['English', 'Japanese', 'Chinese', 'Korean'];
const JUNK_KEYWORDS = /\b(lot|bundle|set of|proxy|custom|reprint|replica|orica|empty slab|slab only|fake)\b/i;
const LANG_PATTERNS = {
  Japanese: /\b(japanese|japan|jpn|jp)\b/i,
  Korean: /\b(korean|korea|kor)\b/i,
  Chinese: /\b(chinese|china|chn|simplified|traditional)\b/i,
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function errMsg(err) {
  let m = err && err.message ? err.message : String(err);
  const key = process.env.SCRAPER_API_KEY;
  if (key) m = m.split(key).join('[redacted-key]');
  return m.replace(/https?:\/\/\S+/g, '[url]');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { card, language, grade } = req.query;
  if (!card || !language || !grade) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const parsedGrade = parseInt(grade, 10);
  if (!Number.isInteger(parsedGrade) || parsedGrade < 1 || parsedGrade > 10) {
    return res.status(400).json({ error: 'Invalid grade' });
  }
  if (!LANGUAGES.includes(language)) {
    return res.status(400).json({ error: 'Invalid language' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SCRAPER_API_KEY) {
    console.error('price lookup failed: a required environment variable is not set');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  const queryKey = card.trim().toLowerCase().replace(/\s+/g, ' ');

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: cachedData } = await supabase
      .from('price_cache')
      .select('*')
      .eq('query_key', queryKey)
      .eq('language', language)
      .eq('grade', parsedGrade)
      .single();

    if (cachedData && (Date.now() - new Date(cachedData.updated_at).getTime() < CACHE_TTL_MS)) {
      return res.status(200).json(cachedData);
    }

    const perGraderResults = {};
    let totalSalesCount = 0;
    let totalFetches = 0;
    let failedFetches = 0;

    for (const grader of GRADERS) {
      let sales = [];
      try {
        totalFetches++;
        sales = await fetchEbaySoldData(queryKey, grader, parsedGrade, language, 90);
        if (sales.length < 3) {
          totalFetches++;
          const extended = await fetchEbaySoldData(queryKey, grader, parsedGrade, language, 365);
          if (extended.length > 0) sales = extended;
        }
      } catch (err) {
        failedFetches++;
        // Message only: never log request URLs, they contain the API key.
        console.error('sales fetch failed for grader ' + grader + ': ' + errMsg(err));
      }

      if (sales.length > 0) {
        const prices = sales.map(s => s.price);
        prices.sort((a, b) => a - b);
        const half = Math.floor(prices.length / 2);
        const median = prices.length % 2 ? prices[half] : (prices[half - 1] + prices[half]) / 2;

        perGraderResults[grader] = { price: median, count: sales.length };
        totalSalesCount += sales.length;
      } else {
        perGraderResults[grader] = { price: null, count: 0 };
      }
    }

    // A partial provider outage must not yield an apparently complete quote
    // reweighted over fewer graders: any failed fetch fails the whole request.
    if (failedFetches > 0) {
      return res.status(502).json({ error: 'Sales data provider unavailable' });
    }

    const activeGraders = GRADERS.filter(g => perGraderResults[g].count > 0);
    if (activeGraders.length === 0) {
      return res.status(404).json({ error: 'No data found' });
    }

    const totalActiveBaseWeight = activeGraders.reduce((sum, g) => sum + BASE_WEIGHTS[g], 0);
    let finalPokeValue = 0;
    const finalBreakdown = {};

    for (const g of GRADERS) {
      if (perGraderResults[g].count > 0) {
        const effectiveWeight = BASE_WEIGHTS[g] / totalActiveBaseWeight;
        finalPokeValue += perGraderResults[g].price * effectiveWeight;
        finalBreakdown[g] = { price: perGraderResults[g].price, count: perGraderResults[g].count };
      }
    }

    finalPokeValue = Math.round(finalPokeValue * 100) / 100;

    const payload = {
      query_key: queryKey,
      card_name: card.trim(),
      language,
      grade: parsedGrade,
      poke_value: finalPokeValue,
      total_sales: totalSalesCount,
      source: 'sold',
      breakdown: finalBreakdown,
      updated_at: new Date().toISOString()
    };

    try {
      await supabase.from('price_cache').upsert(payload, { onConflict: 'query_key,language,grade' });
    } catch (cacheErr) {
      // Cache trouble must not fail a good live result.
      console.error('cache write failed: ' + errMsg(cacheErr));
    }

    return res.status(200).json(payload);

  } catch (error) {
    console.error('price lookup failed: ' + errMsg(error));
    return res.status(502).json({ error: 'Server error' });
  }
}

async function fetchEbaySoldData(cardQuery, grader, grade, language, days) {
  // `days` keeps the 90/365 fallback structure; the eBay sold search itself
  // has no day-range parameter, it always returns recent completed listings.
  let searchString = `${cardQuery} ${grader} ${grade}`;
  if (language !== 'English') searchString += ` ${language}`;

  const targetUrl = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(searchString) + '&LH_Sold=1&LH_Complete=1';
  // ScraperAPI requires its own parameters to come before the url parameter.
  const proxyUrl = 'https://api.scraperapi.com/?api_key=' + encodeURIComponent(process.env.SCRAPER_API_KEY) + '&url=' + encodeURIComponent(targetUrl);

  // Never log proxyUrl: it contains the API key.
  const response = await fetch(proxyUrl);
  if (!response.ok) {
    throw new Error('data provider responded with HTTP ' + response.status);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const listings = [];

  if ($('li.s-item, li.s-card').length === 0) {
    if (/no exact matches|0 results/i.test(html)) return [];   // genuinely no results
    if (/pardon our interruption|captcha|security measure|are you a robot/i.test(html)) {
      throw new Error('blocked by bot check');
    }
    throw new Error('unexpected page structure from sales provider');
  }

  $('li.s-item, li.s-card').each((index, element) => {
    const title = $(element).find('.s-item__title').text().trim();
    const priceText = $(element).find('.s-item__price').text().trim();
    if (!title || !priceText || JUNK_KEYWORDS.test(title)) return;
    if (/\bto\b/i.test(priceText)) return;      // price range, not a single sale
    if (!/^(US\s*)?\$/.test(priceText)) return;  // dollar-denominated prices only

    if (language === 'English') {
      if (Object.values(LANG_PATTERNS).some(regex => regex.test(title))) return;
    } else {
      if (!LANG_PATTERNS[language].test(title)) return;
    }

    const exactGradeRegex = new RegExp(`\\b${grader}\\s*-?\\s*${grade}(?!\\d|\\.\\d)`, 'i');
    if (!exactGradeRegex.test(title)) return;

    const numericPrice = parseFloat(priceText.replace(/[^0-9.]/g, ''));
    if (!isNaN(numericPrice) && numericPrice > 0) {
      listings.push({ price: numericPrice });
    }
  });

  return listings.slice(0, 10);
}
