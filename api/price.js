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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const { card, language, grade } = req.query;
  if (!card || !language || !grade) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const parsedGrade = parseInt(grade, 10);
  const queryKey = card.trim().toLowerCase().replace(/\s+/g, ' ');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: cachedData } = await supabase
      .from('price_cache')
      .select('*')
      .eq('query_key', queryKey)
      .eq('language', language)
      .eq('grade', parsedGrade)
      .single();

    if (cachedData && (Date.now() - new Date(cachedData.updated_at).getTime() < 24 * 60 * 60 * 1000)) {
      return res.status(200).json(cachedData);
    }

    const perGraderResults = {};
    let totalSalesCount = 0;

    for (const grader of GRADERS) {
      let sales = await fetchEbaySoldData(queryKey, grader, parsedGrade, language, 90);
      if (sales.length < 3) {
        sales = await fetchEbaySoldData(queryKey, grader, parsedGrade, language, 365);
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

    await supabase.from('price_cache').upsert(payload, { onConflict: 'query_key,language,grade' });
    return res.status(200).json(payload);

  } catch (error) {
    return res.status(502).json({ error: 'Server error' });
  }
}

async function fetchEbaySoldData(cardQuery, grader, grade, language, days) {
  let searchString = `${cardQuery} ${grader} ${grade}`;
  if (language !== 'English') searchString += ` ${language}`;

  const targetUrl = `https://ebay.com{encodeURIComponent(searchString)}&LH_Sold=1&LH_Complete=1`;
  const proxyUrl = `https://scraperapi.com{encodeURIComponent(process.env.SCRAPER_API_KEY)}&url=${encodeURIComponent(targetUrl)}`;

  const response = await fetch(proxyUrl);
  if (!response.ok) return [];

  const html = await response.text();
  const $ = cheerio.load(html);
  const listings = [];

  $('li.s-item, li.s-card').each((index, element) => {
    const title = $(element).find('.s-item__title').text().trim();
    const priceText = $(element).find('.s-item__price').text().trim();
    if (!title || !priceText || JUNK_KEYWORDS.test(title)) return;

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
