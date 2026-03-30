#!/usr/bin/env node
/**
 * Bay Area Events scraper
 * Sources: Luma (API) + Meetup (keyword sweep) + Partiful (browser scrape)
 * Outputs:
 *   - public/events.json (lean, cached summaries applied)
 *   - needs-summary.json (full descriptions for AI summary cron)
 */

const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const OUTPUT = path.join(__dirname, 'public/events.json');
const NEEDS_SUMMARY = path.join(__dirname, 'needs-summary.json');

const BAY_CITIES = ['san francisco','sf','oakland','berkeley','san jose','san mateo','palo alto','mountain view','sunnyvale','santa clara','fremont','hayward','richmond','san rafael','marin','redwood city','menlo park','east bay','south bay','soma','mission','castro','marina','haight','sunset','presidio','pacific heights','emeryville','alameda','daly city','south san francisco','burlingame','walnut creek','pleasanton','livermore','sausalito','mill valley','tiburon','corte madera','novato','napa','sonoma','petaluma'];

function isBayArea(text = '') {
  const t = text.toLowerCase();
  if (/new york|brooklyn|\bnyc\b|los angeles|\bla\b|chicago|austin|boston|seattle|portland|denver|miami|atlanta|\bdc\b|williamsburg|central park|phoenix|san diego|london|paris|tokyo/i.test(t)) return false;
  if (BAY_CITIES.some(c => t.includes(c))) return true;
  if (/\bca\b|california|bay area/i.test(t)) return true;
  return null;
}

function isInBounds(lat, lng) {
  lat = parseFloat(lat); lng = parseFloat(lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return false;
  return lat >= 36.9 && lat <= 38.9 && lng >= -123.6 && lng <= -121.2;
}

function getGeoArea(venue = '', address = '', description = '') {
  const text = (venue + ' ' + address + ' ' + description).toLowerCase();

  if (/san jose|santa clara|sunnyvale|mountain view|palo alto|cupertino|milpitas|campbell|los gatos|saratoga|los altos|morgan hill|gilroy/i.test(text)) return 'south-bay';
  if (/san mateo|redwood city|burlingame|south san francisco|san bruno|foster city|belmont|san carlos|menlo park|atherton|half moon bay|daly city|pacifica/i.test(text)) return 'peninsula';
  if (/oakland|berkeley|fremont|hayward|emeryville|alameda|richmond|concord|walnut creek|pleasanton|livermore|dublin|san ramon|danville|lafayette|orinda|el cerrito|antioch|pittsburg/i.test(text)) return 'east-bay';
  if (/sausalito|mill valley|san rafael|novato|tiburon|corte madera|marin|napa|sonoma|petaluma|vallejo/i.test(text)) return 'north-bay';
  if (/san francisco|\bsf\b|soma|mission|castro|marina|haight|sunset|richmond|presidio|noe valley|potrero|dogpatch|bayview|tenderloin|financial district|north beach|chinatown|941/i.test(text)) return 'sf';
  return 'sf';
}

function classify(title, description = '') {
  const text = (title + ' ' + description).toLowerCase();
  const techKw = ['tech','startup',' ai ','artificial intelligence','machine learning','developer','engineer','engineering','product manager','founder','venture',' vc ','hackathon','coding','software','saas','web3','crypto','blockchain','data science','devops','cloud',' api ','llm','gpt','robotics','cybersecurity','fintech','biotech','rsac','yc ','agents','agentic','platform engineering','devtools'];
  if (techKw.some(k => text.includes(k))) return 'tech';
  const nightKw = ['party','nightclub','cocktail','rooftop','happy hour','wine tasting','nightlife','speed dating','rave','dj set','dance night','lounge','open bar','bar hop','afterparty'];
  if (nightKw.some(k => text.includes(k))) return 'night-out';
  return 'social';
}

function getSubcategory(title, description = '', category) {
  const text = (title + ' ' + description).toLowerCase();

  if (category === 'night-out') {
    if (/speed dating|singles|dating event/i.test(text)) return 'dating';
    if (/happy hour|cocktail|wine|bar hop|drinks/i.test(text)) return 'happy-hour';
    if (/dance|dancing|salsa|swing|tango|bachata/i.test(text)) return 'dancing';
    if (/dj|rave|club|nightclub/i.test(text)) return 'club';
    if (/comedy|improv/i.test(text)) return 'comedy';
    if (/concert|live music|band/i.test(text)) return 'live-music';
    return 'bars';
  }

  if (category === 'tech') {
    if (/ai|machine learning|llm|gpt|agents/i.test(text)) return 'ai-ml';
    if (/startup|founder|vc|venture|pitch|demo/i.test(text)) return 'startup';
    if (/hackathon|hacking|code|coding|developer/i.test(text)) return 'hackathon';
    if (/product|design|ux|ui/i.test(text)) return 'product-design';
    if (/crypto|web3|blockchain|defi/i.test(text)) return 'crypto';
    if (/networking|meetup|mixer/i.test(text)) return 'networking';
    return 'tech-general';
  }

  if (/hike|hiking|trail|walk|trek/i.test(text)) return 'hiking';
  if (/yoga|meditation|breathwork|mindfulness/i.test(text)) return 'yoga';
  if (/workout|gym|fitness|crossfit|strength|run|running|cycling/i.test(text)) return 'fitness';
  if (/happy hour|cocktail|wine|beer|bar hop|drinks/i.test(text)) return 'happy-hour';
  if (/dating|singles|speed friend|mixer/i.test(text)) return 'dating';
  if (/dance|dancing|salsa|swing/i.test(text)) return 'dancing';
  if (/food|dinner|brunch|restaurant|cook/i.test(text)) return 'food-drink';
  if (/art|gallery|museum|photography|painting|creative/i.test(text)) return 'arts';
  if (/music|concert|band|open mic/i.test(text)) return 'music';
  if (/game|gaming|trivia|board game|poker/i.test(text)) return 'games';
  if (/language|english|spanish|french|japanese|cultural|international/i.test(text)) return 'language';
  if (/volunteer|community|charity|nonprofit/i.test(text)) return 'volunteering';
  if (/book|reading|writing|literature/i.test(text)) return 'book-club';
  if (/outdoor|park|beach|nature|surf|kayak|climb/i.test(text)) return 'outdoors';
  if (/comedy|improv|standup/i.test(text)) return 'comedy';
  if (/professional|career|networking|workshop|seminar/i.test(text)) return 'networking';
  return 'social-general';
}

function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...headers } }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
      }).on('error', () => resolve({}));
    } catch {
      resolve({});
    }
  });
}

function curl(url) {
  try {
    return execSync(`curl -s -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120" --max-time 20 "${url}"`, { maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch {
    return '';
  }
}

async function scrapeLuma() {
  console.log('🌟 Luma...');
  const events = [];
  const seen = new Set();
  let cursor = null;

  for (let page = 0; page < 4; page++) {
    const url = `https://api2.luma.com/discover/get-paginated-events?discover_place_api_id=discplace-BDj7GNbGlsF7Cka&pagination_limit=50${cursor ? '&pagination_cursor=' + encodeURIComponent(cursor) : ''}`;
    const data = await httpGet(url, { origin: 'https://lu.ma', referer: 'https://lu.ma/sf' });
    const entries = data?.entries || [];
    if (!entries.length) break;

    for (const entry of entries) {
      const ev = entry.event;
      if (!ev?.name || seen.has(ev.api_id)) continue;
      seen.add(ev.api_id);
      const venueInfo = entry.venue?.name || ev.geo_address_info?.full_address || '';
      if (isBayArea(venueInfo) === false) continue;
      const slug = ev.url || '';
      const cat = classify(ev.name, ev.description || '');
      const desc = (ev.description_short || ev.description || '').replace(/<[^>]*>/g, '').trim();
      const fullDesc = (ev.description || ev.description_short || '').replace(/<[^>]*>/g, '').trim();
      events.push({
        id: 'luma-' + ev.api_id,
        title: ev.name,
        date: ev.start_at,
        venue: venueInfo || 'San Francisco, CA',
        url: slug ? 'https://lu.ma/' + slug : 'https://lu.ma/sf',
        description: desc.slice(0, 200),
        fullDescription: fullDesc,
        source: 'luma',
        category: cat,
        subcategory: getSubcategory(ev.name, fullDesc, cat),
        geoArea: getGeoArea(venueInfo, '', fullDesc),
      });
    }

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  console.log(`  → ${events.length}`);
  return events;
}

function scrapeMeetup() {
  console.log('📅 Meetup...');
  const events = [];
  const seen = new Set();
  const keywords = ['social','hiking','tech','arts','fitness','music','food','networking','dance','gaming','language','photography','comedy','yoga','volunteering','sports','travel','wine','crafts','professional'];

  for (const kw of keywords) {
    try {
      const html = curl(`https://www.meetup.com/find/?location=us--ca--San+Francisco&source=EVENTS&radius=50&keywords=${kw}`);
      const matches = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
      for (const m of matches) {
        try {
          const data = JSON.parse(m[1]);
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            if (item['@type'] !== 'Event' || !item.name || !item.url || seen.has(item.url)) continue;
            const locText = (item.location?.name || '') + ' ' + (item.location?.address?.addressLocality || '') + ' ' + (item.location?.address?.addressRegion || '');
            if (isBayArea(locText) === false) continue;
            seen.add(item.url);
            const cat = classify(item.name, item.description || '');
            const fullDesc = (item.description || '').replace(/<[^>]*>/g, '').trim();
            events.push({
              id: 'mu-' + Buffer.from(item.url).toString('base64').slice(0, 10),
              title: item.name,
              date: item.startDate,
              venue: item.location?.name || item.location?.address?.addressLocality || 'Bay Area',
              url: item.url,
              description: fullDesc.slice(0, 200),
              fullDescription: fullDesc,
              group: item.organizer?.name,
              source: 'meetup',
              category: cat,
              subcategory: getSubcategory(item.name, fullDesc, cat),
              geoArea: getGeoArea(item.location?.name || '', locText, fullDesc),
            });
          }
        } catch {}
      }
    } catch {}
  }

  console.log(`  → ${events.length}`);
  return events;
}

function scrapePartiful() {
  console.log('🎉 Partiful...');
  const events = [];
  try {
    execSync('agent-browser open "https://partiful.com/explore" > /dev/null 2>&1 && sleep 6', { timeout: 25000 });
    execSync(`agent-browser eval '(function(){const node=document.getElementById("__NEXT_DATA__"); if(!node) return "[]"; const data=JSON.parse(node.textContent); const items=data?.props?.pageProps?.trendingSections?.SF?.items||[]; return JSON.stringify(items.slice(0,40).map(i=>{const ev=i.event||{}; const loc=ev.locationInfo||{}; const maps=loc.mapsInfo||{}; return {id:ev.id,title:ev.title,startDate:ev.startDate||ev.startTime,desc:(ev.description||"").slice(0,400),venue:loc.displayName||maps.name||"",address:(maps.addressLines||[]).join(", "),approx:maps.approximateLocation||"",lat:maps.appleMapsUrl?.match(/sll=([\\d.]+)/)?.[1],lng:maps.appleMapsUrl?.match(/sll=[\\d.]+,(-[\\d.]+)/)?.[1]};}))})()' > /tmp/partiful_raw.json 2>/dev/null`, { timeout: 20000 });
    let raw = '';
    try { raw = fs.readFileSync('/tmp/partiful_raw.json', 'utf8').trim(); } catch {}
    if (raw) {
      if (raw.startsWith('"')) raw = JSON.parse(raw);
      const parsed = JSON.parse(raw || '[]');
      for (const item of parsed) {
        if (!item?.id || !item?.title) continue;
        if (item.lat && item.lng) {
          if (!isInBounds(item.lat, item.lng)) continue;
        } else {
          const geo = isBayArea(`${item.venue} ${item.address} ${item.approx}`);
          if (geo === false) continue;
        }
        const cat = classify(item.title, item.desc || '');
        const displayVenue = [item.venue, item.approx].filter(Boolean).join(' · ') || 'Bay Area';
        events.push({
          id: 'partiful-' + item.id,
          title: item.title,
          date: item.startDate,
          venue: displayVenue,
          address: item.address,
          url: `https://partiful.com/e/${item.id}`,
          description: (item.desc || '').slice(0, 200),
          fullDescription: item.desc || '',
          source: 'partiful',
          category: cat,
          subcategory: getSubcategory(item.title, item.desc || '', cat),
          geoArea: getGeoArea(item.venue || '', item.address || '', item.desc || ''),
          geoVerified: Boolean(item.lat && item.lng && isInBounds(item.lat, item.lng)),
        });
      }
    }
  } catch (err) {
    console.log('  Partiful error:', err.message);
  }
  console.log(`  → ${events.length}`);
  return events;
}

async function run() {
  console.log('🗓️ Scraping Bay Area events...\n');
  const [luma, meetup, partiful] = await Promise.all([
    scrapeLuma(),
    Promise.resolve(scrapeMeetup()),
    Promise.resolve(scrapePartiful()),
  ]);

  let all = [...luma, ...partiful, ...meetup]
    .filter(e => e.title?.length > 4 && e.url)
    .sort((a, b) => {
      if (a.date && b.date) return new Date(a.date) - new Date(b.date);
      return 0;
    });

  // Load cached summaries so we don't resend events that were already summarized
  let cachedSummaries = {};
  try {
    const existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    if (existing.summaryCache) cachedSummaries = existing.summaryCache;
    for (const e of (existing.all || [])) {
      if (e.id && e.summary && !cachedSummaries[e.id]) cachedSummaries[e.id] = e.summary;
    }
  } catch {}

  all.forEach(e => { if (cachedSummaries[e.id]) e.summary = cachedSummaries[e.id]; });

  const allClean = all.map(({ fullDescription, ...rest }) => rest);

  const result = {
    lastRun: new Date().toISOString(),
    total: allClean.length,
    bySource: { luma: luma.length, meetup: meetup.length, partiful: partiful.length },
    summaryCache: cachedSummaries,
    tech: allClean.filter(e => e.category === 'tech'),
    social: allClean.filter(e => e.category === 'social'),
    nightOut: allClean.filter(e => e.category === 'night-out'),
    all: allClean,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2));

  const needsSummary = all.filter(e => !e.summary && (e.fullDescription || e.description));
  fs.writeFileSync(NEEDS_SUMMARY, JSON.stringify(needsSummary, null, 2));

  console.log(`\n✅ ${allClean.length} events written → ${path.relative(process.cwd(), OUTPUT)}`);
  console.log(`📝 ${needsSummary.length} events still need summaries → ${path.relative(process.cwd(), NEEDS_SUMMARY)}`);
  console.log(`📊 Sources — Luma: ${luma.length} | Meetup: ${meetup.length} | Partiful: ${partiful.length}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
