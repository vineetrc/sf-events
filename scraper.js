#!/usr/bin/env node
/**
 * SF Events scraper for GitHub Actions
 * Sources: Luma (internal API) + Meetup (keyword sweep)
 * Partiful skipped (needs browser) — handled via OpenClaw cron
 */

const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

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
      events.push({id:'luma-'+ev.api_id,title:ev.name,date:ev.start_at,venue:venueInfo||'San Francisco, CA',url:slug?'https://lu.ma/'+slug:'https://lu.ma/sf',description:(ev.description_short||ev.description||'').slice(0,200),source:'luma',category:cat,subcategory:getSubcategory(ev.name,ev.description||'',cat),geoArea:getGeoArea(venueInfo,'')});
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
            events.push({id:'mu-'+Buffer.from(item.url).toString('base64').slice(0,10),title:item.name,date:item.startDate,venue:item.location?.name||item.location?.address?.addressLocality||'Bay Area',url:item.url,description:(item.description||'').replace(/<[^>]*>/g,'').slice(0,200),group:item.organizer?.name,source:'meetup',category:cat,subcategory:getSubcategory(item.name,item.description||'',cat),geoArea:getGeoArea(item.location?.name||'',item.location?.address?.addressLocality||'')});
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
  const all=[...luma,...meetup].filter(e=>e.title?.length>4&&e.url).sort((a,b)=>{if(a.date&&b.date) return new Date(a.date)-new Date(b.date); return 0;});
  const result={lastRun:new Date().toISOString(),total:all.length,bySource:{luma:luma.length,meetup:meetup.length,partiful:0},tech:all.filter(e=>e.category==='tech'),social:all.filter(e=>e.category==='social'),nightOut:all.filter(e=>e.category==='night-out'),all};
  fs.writeFileSync(OUTPUT,JSON.stringify(result,null,2));
  console.log(`\n✅ ${all.length} events → ${OUTPUT}`);
}

run().catch(console.error);
