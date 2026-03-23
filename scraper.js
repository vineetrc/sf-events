#!/usr/bin/env node
/**
 * SF Events scraper for GitHub Actions
 * Sources: Luma (internal API) + Meetup (keyword sweep)
 * Partiful skipped (needs browser) — handled via OpenClaw cron
 */

const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

// ── Claude summarizer ────────────────────────────────────────────────────────
// Calls claude-3-5-haiku to generate 1-2 sentence summaries for event cards.
// Batches up to 20 events per request; skips events that already have summaries.

function claudePost(body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.write(payload);
    req.end();
  });
}

async function summarizeBatch(events) {
  // Build a numbered list for Claude
  const items = events.map((e, i) =>
    `${i + 1}. Title: ${e.title}\nDescription: ${(e.fullDescription || e.description || '').slice(0, 800)}`
  ).join('\n\n');

  const resp = await claudePost({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are writing brief summaries for event cards on a Bay Area events discovery app aimed at young professionals.

For each event below, write exactly 1-2 engaging sentences (under 120 chars total) that capture what attendees will actually DO and WHY it's worth going. Be specific, skip filler phrases like "Join us" or "Don't miss". Return ONLY a JSON array of strings, one per event, in the same order. No extra text.

Events:
${items}`,
    }],
  });

  try {
    const text = resp.content?.[0]?.text || '[]';
    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    const summaries = JSON.parse(match ? match[0] : '[]');
    return Array.isArray(summaries) ? summaries : [];
  } catch (e) {
    return [];
  }
}

async function addSummaries(events, existingSummaries = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠️  No ANTHROPIC_API_KEY — skipping AI summaries');
    return events;
  }

  // Only summarize events that don't already have a cached summary
  const needsSummary = events.filter(e => !existingSummaries[e.id]);
  if (!needsSummary.length) {
    console.log('✨ All events already have summaries (cached)');
    events.forEach(e => { if (existingSummaries[e.id]) e.summary = existingSummaries[e.id]; });
    return events;
  }

  console.log(`🤖 Summarizing ${needsSummary.length} new events with Claude...`);
  const BATCH = 20;
  for (let i = 0; i < needsSummary.length; i += BATCH) {
    const batch = needsSummary.slice(i, i + BATCH);
    const summaries = await summarizeBatch(batch);
    batch.forEach((e, j) => {
      if (summaries[j]) existingSummaries[e.id] = summaries[j];
    });
    if (i + BATCH < needsSummary.length) {
      // Small pause between batches to respect rate limits
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Apply summaries to all events
  events.forEach(e => { if (existingSummaries[e.id]) e.summary = existingSummaries[e.id]; });
  console.log(`  → ${Object.keys(existingSummaries).length} total summaries cached`);
  return events;
}
// ────────────────────────────────────────────────────────────────────────────

const OUTPUT = 'public/events.json';

const BAY_CITIES = ['san francisco','sf','oakland','berkeley','san jose','san mateo','palo alto','mountain view','sunnyvale','santa clara','fremont','hayward','richmond','san rafael','marin','redwood city','menlo park','east bay','south bay','soma','mission','castro','marina','haight','sunset','presidio','emeryville','alameda','daly city','south san francisco','burlingame','walnut creek','pleasanton','livermore','sausalito','mill valley'];

function isBayArea(text='') {
  const t=text.toLowerCase();
  if(/new york|brooklyn|\bnyc\b|los angeles|\bla\b|chicago|austin|boston|seattle|portland|denver|miami|atlanta|\bdc\b|williamsburg|central park|phoenix|san diego/i.test(t)) return false;
  if(BAY_CITIES.some(c=>t.includes(c))) return true;
  if(/\bca\b|california|bay area/i.test(t)) return true;
  return null;
}

function httpGet(url,headers={}) {
  return new Promise((resolve)=>{
    try {
      const u=new URL(url);
      https.get({hostname:u.hostname,path:u.pathname+u.search,headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json',...headers}},(res)=>{
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){resolve({});}});
      }).on('error',()=>resolve({}));
    } catch(e){resolve({});}
  });
}

function curl(url) {
  try { return execSync(`curl -s -A "Mozilla/5.0" --max-time 15 "${url}"`,{maxBuffer:10*1024*1024}).toString(); } catch(e){return '';}
}

function classify(title,desc='') {
  const t=(title+' '+desc).toLowerCase();
  const techKw=['tech','startup',' ai ','machine learning','developer','engineer','engineering','product manager','founder','venture',' vc ','hackathon','coding','software','saas','web3','crypto','blockchain','data science','devops','cloud',' api ','llm','gpt','robotics','cybersecurity','fintech','biotech','rsac','yc ','agents','agentic','platform engineering'];
  if(techKw.some(k=>t.includes(k))) return 'tech';
  const nightKw=['party','nightclub','cocktail','rooftop','happy hour','wine tasting','nightlife','speed dating','rave','dj set','dance night','lounge','open bar','bar hop'];
  if(nightKw.some(k=>t.includes(k))) return 'night-out';
  return 'social';
}

function getSubcategory(title,desc='',cat) {
  const t=(title+' '+desc).toLowerCase();
  if(cat==='night-out'){
    if(/speed dating|singles|dating event/i.test(t)) return 'dating';
    if(/happy hour|cocktail|wine|drinks/i.test(t)) return 'happy-hour';
    if(/dance|dancing|salsa|swing/i.test(t)) return 'dancing';
    if(/dj|rave|club/i.test(t)) return 'club';
    if(/comedy|improv/i.test(t)) return 'comedy';
    if(/concert|live music/i.test(t)) return 'live-music';
    return 'bars';
  }
  if(cat==='tech'){
    if(/ai|machine learning|llm|gpt|agents/i.test(t)) return 'ai-ml';
    if(/startup|founder|vc|venture|pitch|demo/i.test(t)) return 'startup';
    if(/hackathon|coding|developer/i.test(t)) return 'hackathon';
    if(/product|design|ux/i.test(t)) return 'product-design';
    if(/crypto|web3|blockchain/i.test(t)) return 'crypto';
    return 'tech-general';
  }
  if(/hike|hiking|trail|walk/i.test(t)) return 'hiking';
  if(/yoga|meditation|mindfulness/i.test(t)) return 'yoga';
  if(/workout|gym|fitness|crossfit|run|cycling/i.test(t)) return 'fitness';
  if(/happy hour|cocktail|wine|bar/i.test(t)) return 'happy-hour';
  if(/food|dinner|brunch|restaurant|cook/i.test(t)) return 'food-drink';
  if(/art|gallery|photography|painting/i.test(t)) return 'arts';
  if(/music|concert|band/i.test(t)) return 'music';
  if(/dance|dancing|salsa/i.test(t)) return 'dancing';
  if(/game|gaming|trivia|board game/i.test(t)) return 'games';
  if(/language|english|cultural|international/i.test(t)) return 'language';
  if(/outdoor|park|beach|nature/i.test(t)) return 'outdoors';
  if(/comedy|improv/i.test(t)) return 'comedy';
  if(/professional|career|networking/i.test(t)) return 'networking';
  return 'social-general';
}

function getGeoArea(venue='',address='') {
  const t=(venue+' '+address).toLowerCase();
  if(/san jose|santa clara|sunnyvale|mountain view|palo alto|cupertino|milpitas|campbell|los gatos|los altos/i.test(t)) return 'south-bay';
  if(/san mateo|redwood city|burlingame|south san francisco|san bruno|foster city|menlo park|daly city|pacifica/i.test(t)) return 'peninsula';
  if(/oakland|berkeley|fremont|hayward|emeryville|alameda|richmond|concord|walnut creek|pleasanton|livermore|dublin|san ramon/i.test(t)) return 'east-bay';
  if(/sausalito|mill valley|san rafael|novato|tiburon|marin|napa|sonoma/i.test(t)) return 'north-bay';
  return 'sf';
}

async function scrapeLuma() {
  console.log('🌟 Luma...');
  const events=[], seen=new Set();
  let cursor=null;
  for(let p=0;p<4;p++){
    const url=`https://api2.luma.com/discover/get-paginated-events?discover_place_api_id=discplace-BDj7GNbGlsF7Cka&pagination_limit=50${cursor?'&pagination_cursor='+encodeURIComponent(cursor):''}`;
    const data=await httpGet(url,{origin:'https://lu.ma',referer:'https://lu.ma/sf'});
    const entries=data?.entries||[];
    if(!entries.length) break;
    for(const entry of entries){
      const ev=entry.event;
      if(!ev?.name||seen.has(ev.api_id)) continue;
      seen.add(ev.api_id);
      const venueInfo=entry.venue?.name||ev.geo_address_info?.full_address||'';
      if(isBayArea(venueInfo)===false) continue;
      const slug=ev.url||'';
      const cat=classify(ev.name,ev.description||'');
      const fullDesc = (ev.description||ev.description_short||'').replace(/<[^>]*>/g,'').trim();
      events.push({id:'luma-'+ev.api_id,title:ev.name,date:ev.start_at,venue:venueInfo||'San Francisco, CA',url:slug?'https://lu.ma/'+slug:'https://lu.ma/sf',description:fullDesc.slice(0,200),fullDescription:fullDesc,source:'luma',category:cat,subcategory:getSubcategory(ev.name,ev.description||'',cat),geoArea:getGeoArea(venueInfo,'')});
    }
    if(!data.has_more||!data.next_cursor) break;
    cursor=data.next_cursor;
  }
  console.log(`  → ${events.length}`);
  return events;
}

function scrapeMeetup() {
  console.log('📅 Meetup...');
  const events=[], seen=new Set();
  const keywords=['social','hiking','tech','arts','fitness','music','food','networking','dance','gaming','language','photography','comedy','yoga','volunteering','sports','wine','professional'];
  for(const kw of keywords){
    try{
      const html=curl(`https://www.meetup.com/find/?location=us--ca--San+Francisco&source=EVENTS&radius=50&keywords=${kw}`);
      const matches=[...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
      for(const m of matches){
        try{
          const data=JSON.parse(m[1]);
          const items=Array.isArray(data)?data:[data];
          for(const item of items){
            if(item['@type']!=='Event'||!item.name||!item.url||seen.has(item.url)) continue;
            const locText=(item.location?.name||'')+' '+(item.location?.address?.addressLocality||'');
            if(isBayArea(locText)===false) continue;
            seen.add(item.url);
            const cat=classify(item.name,item.description||'');
            const fullDesc=(item.description||'').replace(/<[^>]*>/g,'').trim();
            events.push({id:'mu-'+Buffer.from(item.url).toString('base64').slice(0,10),title:item.name,date:item.startDate,venue:item.location?.name||item.location?.address?.addressLocality||'Bay Area',url:item.url,description:fullDesc.slice(0,200),fullDescription:fullDesc,group:item.organizer?.name,source:'meetup',category:cat,subcategory:getSubcategory(item.name,item.description||'',cat),geoArea:getGeoArea(item.location?.name||'',item.location?.address?.addressLocality||'')});
          }
        }catch(e){}
      }
    }catch(e){}
  }
  console.log(`  → ${events.length}`);
  return events;
}

async function run(){
  console.log('🗓️ Scraping Bay Area events...\n');
  const [luma,meetup]=await Promise.all([scrapeLuma(),Promise.resolve(scrapeMeetup())]);
  let all=[...luma,...meetup].filter(e=>e.title?.length>4&&e.url).sort((a,b)=>{if(a.date&&b.date) return new Date(a.date)-new Date(b.date); return 0;});

  // Load previously cached summaries to avoid re-summarizing
  let cachedSummaries = {};
  try {
    const existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    if (existing.summaryCache) cachedSummaries = existing.summaryCache;
    // Also pull summaries stored on individual events (legacy)
    for (const e of (existing.all || [])) {
      if (e.id && e.summary && !cachedSummaries[e.id]) cachedSummaries[e.id] = e.summary;
    }
  } catch (e) { /* first run */ }

  // Generate AI summaries for new events
  all = await addSummaries(all, cachedSummaries);

  // Strip fullDescription before saving to keep events.json lean
  const allClean = all.map(({ fullDescription, ...e }) => e);

  const result={
    lastRun:new Date().toISOString(),
    total:allClean.length,
    bySource:{luma:luma.length,meetup:meetup.length,partiful:0},
    summaryCache: cachedSummaries,
    tech:allClean.filter(e=>e.category==='tech'),
    social:allClean.filter(e=>e.category==='social'),
    nightOut:allClean.filter(e=>e.category==='night-out'),
    all:allClean,
  };
  fs.writeFileSync(OUTPUT,JSON.stringify(result,null,2));
  console.log(`\n✅ ${allClean.length} events → ${OUTPUT}`);
}

run().catch(console.error);
