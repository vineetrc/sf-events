import json, re
from pathlib import Path

ROOT = Path('/Users/vchintha/Projects/sf-events')
needs_path = ROOT / 'needs-summary.json'
events_path = ROOT / 'public' / 'events.json'

needs = json.loads(needs_path.read_text())
events = json.loads(events_path.read_text())


def clean(text: str) -> str:
    return re.sub(r'\s+', ' ', text or '').strip()


def clip(text: str, limit: int = 120) -> str:
    text = clean(text)
    if len(text) <= limit:
        return text
    cut = text[:limit - 1]
    if ' ' in cut:
        cut = cut.rsplit(' ', 1)[0]
    return cut + '…'


def summarize(e):
    title = clean(e.get('title', ''))
    desc = clean(e.get('description') or e.get('fullDescription') or '')
    venue = clean(e.get('venue', ''))
    t = title.lower()
    d = desc.lower()

    def s(text):
        return clip(text)

    # strong keyword rules
    if 'language exchange' in t or 'speak english' in t or 'english chat' in t or 'speaking night' in t or 'mandarin happy hour' in t:
        return s('Swap languages in small chats and drinks; easy way to meet international, curious Bay Area peers.')
    if 'spanish' in t and ('language' in t or 'speaking' in t):
        return s('Practice Spanish in guided chats and make bilingual friends; ideal for travel-minded East Bay/SF crowds.')
    if 'japanese language exchange' in t:
        return s('Alternate Japanese and English on Zoom; low-pressure practice for anime lovers and language nerds.')
    if re.search(r'\bimprov\b', t):
        return s('Play improv games, get out of your head, then hit the after-party; great for making fast friends.')
    if 'comedy' in t or 'stand-up' in t:
        return s('Catch live comics and cheap drinks; easy group night when you want laughs without a huge commitment.')
    if 'karaoke' in t:
        return s('Trade songs and drinks with strangers; perfect for extrovert energy and chaotic friend-group bonding.')
    if 'board game' in t or 'mah jongg' in t or 'mahjong' in t or 'cribbage' in t or 'werewolf' in t or 'game night' in t:
        return s('Learn a game fast and hang around the table; easy socializing for nerdy, low-key weeknights.')
    if 'book club' in t or 'reading group' in t or 'philosophy' in t:
        return s('Talk through big ideas with smart strangers; catnip for bookish 20-somethings who miss class debates.')
    if 'ai ' in t or t.startswith('ai') or 'llm' in t or 'tech' in t or 'startup' in t or 'networking' in t or 'hack' in t or 'data' in t or 'swift' in t or 'copilot' in t or 'engineer' in t or 'product' in t:
        return s('Hear builder talks and trade intros with founders and engineers; high-signal Bay Area networking.')
    if 'photography' in t or 'photo' in t or 'drawing' in t or 'art class' in t or 'drink and draw' in t or 'craft' in t:
        return s('Make art or level up your camera eye with other creatives; a mellow way to build an artsy circle.')
    if 'music' in t or 'jam' in t or 'concert' in t or 'qawwali' in t or 'orchestra' in t:
        return s('Hear live music or workshop your own tracks; great for creative energy without club chaos.')
    if 'dance' in t or 'salsa' in t or 'bachata' in t or 'tango' in t or 'waltz' in t or 'cha cha' in t or 'bollyx' in t or 'line dancing' in t:
        return s('Learn steps, rotate partners, and dance after; ideal for meeting people without awkward small talk.')
    if 'yoga' in t or 'breathwork' in t or 'meditation' in t:
        return s('Move, stretch, and reset with a wellness crowd; good for post-work calm and meeting grounded people.')
    if 'run' in t or 'softball' in t or 'soccer' in t or 'basketball' in t or 'tennis' in t or 'pickleball' in t or 'volleyball' in t or 'fitness' in t or 'bouldering' in t:
        return s('Get a workout in with a social crowd, then hang after; built for active friend-making in the city.')
    if 'hike' in t or 'hiking' in t or 'walk' in t or 'trail' in t or 'bike' in t or 'wildflower' in t:
        return s('Walk scenic trails with new people and coastal views; easy Bay Area bonding without bar noise.')
    if 'cleanup' in t or 'volunteer' in t or 'food giveaway' in t:
        return s('Clean up a neighborhood or help out together; purpose-driven social time beats another passive happy hour.')
    if 'ramen' in t or 'dinner' in t or 'happy hour' in t or 'wine' in t or 'mixer' in t or 'coffee' in t or 'crochet club' in t or 'stitch & sip' in t:
        return s('Eat, sip, and chat with strangers who actually showed up; low-stakes way to grow your local circle.')
    if 'travel' in t or 'solo travelers' in t:
        return s('Swap travel stories, hacks, and future trip ideas; a natural fit for curious, mobile Bay Area types.')

    # fallback from description/category
    if 'zoom' in d or 'online' in d or e.get('venue') == 'Bay Area':
        return s('Hop on with people into the same niche and trade ideas; easy weekday socializing from your laptop.')
    if e.get('category') == 'tech':
        return s('Meet Bay Area builders, hear what they are shipping, and leave with real connections and ideas.')
    if e.get('category') == 'night-out':
        return s('Grab drinks, do the activity, and actually meet people; better than another random night at home.')
    return s(f'Hang out at {venue or "a local spot"} with people into the same thing; easy way to widen your Bay Area circle.')


summaries = [summarize(e) for e in needs]

# preserve order by using composite keys per queued event
queue = {}
for e, summary in zip(needs, summaries):
    key = (e.get('title'), e.get('date'), e.get('venue'), e.get('url'))
    queue[key] = summary
    e['summary'] = summary

changed_entries = 0
matched = 0
for section in ['all', 'tech', 'social', 'nightOut']:
    for item in events.get(section, []):
        key = (item.get('title'), item.get('date'), item.get('venue'), item.get('url'))
        if key in queue:
            item['summary'] = queue[key]
            changed_entries += 1
            matched += 1

# requested cache by id, even though most meetup ids collide upstream
cache = events.setdefault('summaryCache', {})
for e, summary in zip(needs, summaries):
    cache[e['id']] = summary

needs_path.write_text('[]\n')
events_path.write_text(json.dumps(events, ensure_ascii=False, indent=2) + '\n')

print(json.dumps({
    'queued': len(needs),
    'matched_entries': matched,
    'changed_entries': changed_entries,
    'summary_cache_keys': len(cache),
    'colliding_meetup_id': 'mu-aHR0cHM6Ly' in cache,
}, ensure_ascii=False))
