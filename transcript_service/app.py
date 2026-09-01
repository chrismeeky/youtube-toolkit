#!/usr/bin/env python3
"""Transcript service for the YouTube Toolkit extension — runs locally or hosted.

Same job as before: hand yt-dlp a video id, get back timestamped segments. What changed is
that it can now run on a public host, which brings three problems the localhost-only version
never had to answer.

  Abuse    A public yt-dlp endpoint is a free downloader for anyone who finds it, so a token
           is required whenever ACCESS_TOKEN is set.
  Blocking YouTube refuses caption requests from datacenter IPs far more often than from a
           home connection. YTDLP_COOKIES_B64 and YTDLP_PROXY exist for that.
  Cost     Free tiers are small. Results are cached, concurrent yt-dlp runs are capped, and
           per-IP rate limiting keeps one caller from eating the whole instance.

Config is all environment variables (see README.md). Serves:

    GET <prefix>/transcript?v=VIDEO_ID -> {"ok": true, "segments": [{"time","text"}, ...]}
    GET <prefix>/health                -> {"ok": true, "ytdlp": "...", "cookies": bool}

where <prefix> is "" locally, or "/k/<ACCESS_TOKEN>" when a token is configured.
"""

# This file sits inside the folder Chrome loads as an unpacked extension, and Chrome rejects
# any directory whose name begins with "_" — a stray __pycache__ makes the whole extension
# fail with "Could not load manifest", after which the profile silently keeps running the
# build it loaded last. Set before any local import can generate one.
import sys
sys.dont_write_bytecode = True

import base64
import concurrent.futures
import importlib.util
import json
import math
from datetime import datetime, timedelta, timezone
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict, defaultdict, deque
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote


def _int(name, default):
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


# Hosts differ on how they name the port: Spaces defaults to 7860, Render and Koyeb inject
# $PORT, and the old local helper used YTC_HELPER_PORT. Accept all three.
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = _int("PORT", _int("YTC_HELPER_PORT", 7860))

ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN", "").strip()
PROXY = os.environ.get("YTDLP_PROXY", "").strip()
# yt-dlp's own defaults track YouTube's changes, so pass nothing unless asked. See the
# README for the client overrides worth trying when a host starts getting blocked.
EXTRACTOR_ARGS = os.environ.get("YTDLP_EXTRACTOR_ARGS", "").strip()
SUB_LANGS = os.environ.get("YTDLP_SUB_LANGS", "en.*,en").strip()

MAX_CONCURRENCY = _int("MAX_CONCURRENCY", 2)

# ─── channel index ───────────────────────────────────────────────────────────

# Backs "Similar channels". The extension cannot query this itself: doing so would need the
# Supabase service key and an OpenAI key in an extension anyone can unpack.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMS = 512                  # must match vector(512) in migration 0003
INDEX_READY = bool(SUPABASE_URL and SUPABASE_KEY)


def _post_json(url, payload, headers, timeout=30):
    body = json.dumps(payload).encode()
    hdrs = {"Content-Type": "application/json"}
    hdrs.update(headers)
    req = urllib.request.Request(url, data=body, headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
    return json.loads(raw.decode("utf-8", "replace")) if raw else None


def _supabase(path, payload, timeout=30, prefer=None):
    headers = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY}
    if prefer:
        headers["Prefer"] = prefer
    return _post_json(SUPABASE_URL + path, payload, headers, timeout)


def embed(text):
    """One embedding, for the channel being asked about.

    The query channel is usually already indexed, in which case its stored vector is used and
    this is never called. It matters for a channel nobody has crawled yet: the extension sends
    the text it can already see on the page, so an unknown channel still gets an answer.
    """
    if not OPENAI_KEY:
        return None
    data = {"model": EMBED_MODEL, "input": text[:2000], "dimensions": EMBED_DIMS}
    out = _post_json("https://api.openai.com/v1/embeddings", data,
                     {"Authorization": "Bearer " + OPENAI_KEY}, timeout=30)
    rows = (out or {}).get("data") or []
    return rows[0]["embedding"] if rows else None


def indexed_channel(handle):
    """Look up a channel by handle. Case-insensitively — the YouTube API returns customUrl
    lowercased, so what is stored rarely matches what appears in the address bar."""
    query = ("/rest/v1/channels?select=id,handle,title,embedding,topic_coherence"
             "&handle=ilike." + urllib.parse.quote(handle) + "&limit=1")
    req = urllib.request.Request(
        SUPABASE_URL + query,
        headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY})
    # One retry: Supabase drops idle keep-alive connections, and a RemoteDisconnected here
    # does not fail the request — it quietly downgrades the answer to page-text embedding.
    # That made results differ run to run for the same channel.
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                return (json.loads(res.read().decode("utf-8", "replace")) or [None])[0]
        except Exception as e:
            # Never silently. A failure here does not stop an answer being produced, so
            # swallowing it turned a broken lookup into quietly worse results that still
            # claimed to come from the index.
            print("  indexed_channel(%s) attempt %d failed: %s: %s"
                  % (handle, attempt, type(e).__name__, e), flush=True)
    return None


# ─── niche RPM ───────────────────────────────────────────────────────────────

# Reference RPMs by niche, in US dollars per thousand monetised views on long-form video.
#
# These are the midpoints of ranges reported publicly by creators, not measured figures, and
# they are the weakest part of any earnings estimate. Audience geography moves RPM further
# than niche does — a US-heavy finance channel and an India-heavy one sit several times apart
# inside this same row — so the number is a scale, not a prediction. The extension already
# says so where it shows it.
#
# The description is what gets embedded. It is written as the channel would describe itself,
# because that is what it is matched against.
NICHES = [
    # ── money, business, professional ──────────────────────────────────────────
    ("Personal finance", 16.0, "investing, saving money, budgeting, retirement, credit scores, debt, personal finance"),
    ("Stock trading", 15.0, "stock market, day trading, options, technical analysis, portfolios, dividends"),
    ("Cryptocurrency", 11.0, "crypto, bitcoin, ethereum, blockchain, altcoins, defi, web3, trading crypto"),
    ("Business and entrepreneurship", 14.0, "starting a business, entrepreneurship, startups, founders, scaling a company"),
    ("Ecommerce and dropshipping", 13.0, "ecommerce, dropshipping, amazon fba, shopify, online store, print on demand"),
    ("Making money online", 12.0, "side hustles, making money online, freelancing, passive income, work from home"),
    ("Real estate", 15.0, "real estate investing, property, mortgages, landlords, buying a house, rentals"),
    ("Insurance and legal", 20.0, "insurance, lawyers, legal advice, claims, attorneys, lawsuits, compensation"),
    ("Taxes and accounting", 14.0, "taxes, accounting, bookkeeping, deductions, payroll, small business finance"),
    ("Digital marketing", 13.0, "digital marketing, SEO, advertising, agency, social media growth, email marketing, funnels"),
    ("YouTube and content growth", 11.0, "growing a youtube channel, content creation, thumbnails, algorithm, creator advice"),
    ("Career and job hunting", 11.0, "careers, job interviews, resumes, salary negotiation, workplace advice, hiring"),
    ("Productivity and tools", 8.0, "productivity, note taking, workflows, organisation, planners, time management"),

    # ── technology ─────────────────────────────────────────────────────────────
    ("Software and tech reviews", 9.0, "tech reviews, gadgets, phones, laptops, headphones, consumer electronics"),
    ("Tech news", 8.0, "technology news, product launches, industry analysis, leaks, rumours"),
    ("Programming and web development", 10.0, "programming, coding tutorials, web development, javascript, python, software engineering"),
    ("Data science and AI", 11.0, "artificial intelligence, machine learning, data science, neural networks, AI tools, prompting"),
    ("Cybersecurity", 12.0, "cybersecurity, hacking, penetration testing, privacy, malware, network security"),
    ("Cloud and IT", 12.0, "cloud computing, aws, azure, devops, sysadmin, IT certification, networking"),
    ("PC building and hardware", 7.5, "pc building, graphics cards, processors, overclocking, custom computers, benchmarks"),
    ("Smart home and gadgets", 8.0, "smart home, home automation, iot devices, cameras, assistants"),

    # ── home, craft, making ────────────────────────────────────────────────────
    ("Home improvement and DIY", 8.5, "home improvement, DIY projects, renovation, plumbing, electrical, repairs"),
    ("Woodworking", 8.0, "woodworking, carpentry, furniture making, joinery, workshop, sawmill"),
    ("Construction and trades", 8.0, "construction, building, contractors, roofing, concrete, trades, site work"),
    ("Engineering and machining", 7.5, "engineering, machining, metalwork, welding, CNC, fabrication, mechanics"),
    ("3D printing and making", 7.0, "3d printing, makers, electronics projects, arduino, raspberry pi, prototyping"),
    ("Interior design", 7.5, "interior design, home decor, styling, furniture, room makeovers"),
    ("Gardening and plants", 6.0, "gardening, plants, vegetables, landscaping, houseplants, growing food"),
    ("Farming and agriculture", 6.5, "farming, agriculture, livestock, tractors, homesteading, crops"),
    ("Art and drawing", 4.5, "drawing, painting, illustration, digital art, sketching, art tutorials"),
    ("Crafts and sewing", 5.0, "crafts, sewing, knitting, crochet, quilting, handmade, resin"),

    # ── vehicles and machines ──────────────────────────────────────────────────
    ("Automotive reviews", 8.0, "car reviews, new cars, test drives, buying a car, vehicle comparisons"),
    ("Car repair and modification", 7.5, "car repair, mechanics, engine rebuild, restoration, tuning, modifications"),
    ("Motorsport", 5.5, "formula 1, racing, rally, nascar, motorsport, track days, drifting"),
    ("Motorcycles", 6.5, "motorcycles, riding, bikes, gear reviews, touring"),
    ("Trucking and heavy machinery", 7.0, "trucking, lorries, excavators, heavy equipment, logistics, haulage"),
    ("Aviation and transport", 5.0, "aviation, aircraft, pilots, air crash investigation, airlines, flying"),
    ("Trains and railways", 4.5, "trains, railways, locomotives, rail travel, model railways"),
    ("Boating and marine", 8.0, "boats, sailing, yachts, marine, fishing boats, liveaboard"),

    # ── health, body, mind ─────────────────────────────────────────────────────
    ("Health and fitness", 7.5, "fitness, workouts, gym, strength training, exercise, bodybuilding"),
    ("Nutrition and diet", 7.5, "nutrition, diet, weight loss, meal plans, supplements, healthy eating"),
    ("Medical and healthcare", 9.0, "medicine, doctors, health conditions, surgery, nursing, medical explained"),
    ("Mental health", 6.5, "mental health, anxiety, depression, therapy, psychology, wellbeing"),
    ("Self-improvement", 6.5, "motivation, self improvement, discipline, mindset, habits, confidence"),
    ("Meditation and sleep", 3.0, "meditation, mindfulness, sleep, breathing, calm, guided relaxation"),
    ("Relaxation and ASMR", 2.0, "asmr, relaxing sounds, whispering, tingles, ambient, white noise"),

    # ── beauty, style, life ────────────────────────────────────────────────────
    ("Beauty and skincare", 7.5, "beauty, makeup, skincare, cosmetics, routines, hair care"),
    ("Fashion and style", 7.0, "fashion, style, outfits, clothing hauls, streetwear, lookbooks"),
    ("Luxury and watches", 9.0, "luxury goods, watches, designer, high end, collecting, jewellery"),
    ("Weddings and events", 8.0, "weddings, planning, ceremonies, events, celebrations"),
    ("Parenting and family", 6.5, "parenting, babies, motherhood, family life, raising children, pregnancy"),
    ("Relationships and dating", 5.0, "relationships, dating, marriage, breakups, advice, attraction"),
    ("Shopping and deals", 8.0, "deals, discounts, shopping hauls, product recommendations, buying guides"),

    # ── food ───────────────────────────────────────────────────────────────────
    ("Cooking and recipes", 6.0, "cooking, recipes, home cooking, meals, kitchen technique, chefs"),
    ("Baking and desserts", 6.0, "baking, cakes, bread, pastry, desserts, decorating"),
    ("Food reviews and street food", 5.0, "food reviews, street food, restaurants, tasting, mukbang, eating"),

    # ── travel and place ───────────────────────────────────────────────────────
    ("Travel", 5.5, "travel, destinations, itineraries, hotels, flights, tourism, backpacking"),
    ("Travel vlogs and van life", 4.5, "travel vlog, van life, road trip, living abroad, nomad, camping trips"),
    ("Outdoors and hiking", 6.0, "hiking, camping, backpacking, bushcraft, survival, gear reviews, wilderness"),
    ("Hunting and fishing", 6.0, "hunting, fishing, angling, outdoors sport, catch and cook"),

    # ── knowledge ──────────────────────────────────────────────────────────────
    ("Education and tutorials", 7.0, "education, tutorials, how to, teaching, exam revision, study help"),
    ("Language learning", 6.5, "language learning, english, spanish, grammar, vocabulary, speaking practice"),
    ("Science and space", 5.0, "science, space, astronomy, physics, chemistry, biology explained"),
    ("Nature and wildlife", 4.5, "nature, wildlife, animals in the wild, oceans, ecosystems, documentaries"),
    ("History", 5.5, "history, ancient civilisations, wars, historical figures, archaeology"),
    ("Documentary and investigation", 6.0, "documentary, investigation, deep dive, long form analysis, exposé"),
    ("Philosophy and ideas", 4.5, "philosophy, ethics, ideas, thinkers, meaning, essays"),
    ("Religion and spirituality", 4.5, "church, sermons, faith, prayer, bible, gospel, spirituality, pastor"),

    # ── news, crime, culture ───────────────────────────────────────────────────
    ("News and politics", 5.0, "news, politics, current affairs, commentary, elections, government"),
    ("Finance and economy news", 12.0, "economy, markets, inflation, recession, business news, economic analysis"),
    ("Legal commentary", 10.0, "legal analysis, court cases, trials, lawyers reacting, verdicts"),
    ("True crime", 6.0, "true crime, murder cases, criminal investigations, disappearances, cold cases"),
    ("Mystery and unexplained", 4.5, "mysteries, unexplained, conspiracy, lost places, strange events"),
    ("Paranormal and horror", 4.0, "paranormal, ghosts, haunted, horror stories, scary, supernatural"),
    ("Celebrity and gossip", 3.0, "celebrities, gossip, drama, influencers, scandals, pop culture"),

    # ── entertainment ──────────────────────────────────────────────────────────
    ("Storytelling and drama", 3.5, "narrated stories, folktales, fiction, drama series, moral stories, tales, audio stories"),
    ("Reddit and internet stories", 3.0, "reddit stories, aita, text stories, internet drama, narrated posts"),
    ("Comedy and sketches", 3.5, "comedy, sketches, stand up, parody, funny videos, humour"),
    ("Reactions and commentary", 2.5, "reaction videos, commentary, watching, first time hearing, reacting"),
    ("Vlogs and daily life", 3.0, "vlog, daily life, day in the life, lifestyle, routine, personal"),
    ("Challenges and stunts", 3.0, "challenges, stunts, experiments, extreme, dares, competitions"),
    ("Movies and TV analysis", 4.0, "film analysis, movie reviews, tv shows, cinema, breakdowns, theories"),
    ("Anime and manga", 2.5, "anime, manga, otaku, episode reviews, recaps, japanese animation"),
    ("Animation and cartoons", 3.0, "animation, cartoons, animated shorts, animators, motion graphics"),
    ("Music", 2.5, "music, songs, covers, instrumentals, playlists, artists, albums"),
    ("Music production", 6.0, "music production, beats, mixing, mastering, DAW, studio, sound design"),
    ("Photography and video", 7.5, "photography, cameras, lenses, filmmaking, video editing, cinematography"),
    ("Design and creative software", 8.0, "graphic design, photoshop, figma, branding, illustration software, UI design"),
    ("Podcasts and interviews", 6.0, "podcast, interviews, long conversations, guests, discussion"),

    # ── games ──────────────────────────────────────────────────────────────────
    ("Gaming", 3.0, "gaming, gameplay, lets play, walkthrough, playthrough, video games"),
    ("Gaming news and reviews", 4.0, "game reviews, gaming news, releases, previews, industry"),
    ("Esports and competitive", 3.5, "esports, competitive gaming, tournaments, ranked, pro players"),
    ("Sandbox and survival games", 2.5, "minecraft, roblox, survival games, building, mods, servers"),
    ("Mobile gaming", 2.5, "mobile games, android games, ios games, gacha, phone gaming"),

    # ── sport ──────────────────────────────────────────────────────────────────
    ("Sports", 4.5, "sports, highlights, matches, athletes, leagues, commentary"),
    ("Football and soccer", 4.0, "football, soccer, premier league, transfers, goals, matches"),
    ("Combat sports", 4.5, "MMA, boxing, UFC, wrestling, fighters, fights, martial arts"),
    ("Basketball", 4.0, "basketball, NBA, highlights, players, dunks, courts"),

    # ── children ───────────────────────────────────────────────────────────────
    ("Kids and family content", 2.5, "kids, children, nursery rhymes, family friendly, learning for children"),
    ("Toys and unboxing", 2.5, "toys, unboxing, play, collectibles, surprise eggs, figures"),

    # ── animals ────────────────────────────────────────────────────────────────
    ("Pets and animals", 4.0, "pets, dogs, cats, puppies, animal rescue, aquariums, training"),
]

NICHE_TEMP = 0.02          # see niche_for: the useful gaps between niches are hundredths
_niche_vectors = None


def niche_vectors():
    """Embedded once per process. Twenty-eight short strings is a single batch, so a restart
    costs one API call and nothing thereafter."""
    global _niche_vectors
    if _niche_vectors is None:
        vecs = embed_many([("%s. %s" % (n, d)) for n, _, d in NICHES])
        if not vecs or len(vecs) != len(NICHES):
            return None
        _niche_vectors = vecs
    return _niche_vectors


def _cosine(a, b):
    dot = num = 0.0
    den = 0.0
    for x, y in zip(a, b):
        dot += x * y
        num += x * x
        den += y * y
    if num <= 0 or den <= 0:
        return 0.0
    return dot / ((num ** 0.5) * (den ** 0.5))


# How far the best niche stands above the channel's own average across all of them, in
# standard deviations — not the raw score.
#
# A raw threshold measures how richly a channel describes itself rather than how well it
# matches. A news channel whose description reads only "ORIGINAL CONTENTS AT ITS BEST" scored
# 0.310 against News and politics, below a 0.38 floor, while scoring 2.7 deviations above its
# own baseline — a clearer signal than a channel that passed the floor at 0.418. Thin text
# scores low against everything, so the comparison has to be against the rest of that
# channel's own scores.
#
# The absolute minimum stays as a backstop against a match that is nominally distinctive but
# too weak to mean anything.
NICHE_MIN_Z = 2.0
NICHE_MIN_COS = 0.25


def niche_for(vector, top=2):
    """The closest niches, and an RPM blended between them by how close each one is.

    Two rather than one, because a channel rarely sits inside a single label — an aviation
    documentary channel is part aviation and part documentary, and averaging the two is
    closer to the truth than forcing a choice between them.
    """
    vecs = niche_vectors()
    if not vecs or not vector:
        return None
    every = [(_cosine(vector, v), NICHES[i]) for i, v in enumerate(vecs)]
    scored = sorted(every, key=lambda pair: pair[0], reverse=True)[:max(1, top)]

    # The channel's own spread, which is what the best score has to stand out from.
    raw = [sc for sc, _ in every]
    mean = sum(raw) / len(raw)
    sd = (sum((x - mean) ** 2 for x in raw) / len(raw)) ** 0.5 or 1e-9

    # Softmax rather than raw cosine. Every niche scores between about 0.40 and 0.52 against
    # any channel, so weighting by the score directly gives a plainly wrong runner-up almost
    # equal say — UFC came out half Sports and half Anime. The temperature is small because
    # the gaps that matter here are hundredths: a 0.05 lead leaves the second niche about a
    # quarter of the weight, and a near-tie still blends, which is the case blending is for.
    best = scored[0][0]
    weights = [math.exp((sc - best) / NICHE_TEMP) for sc, _ in scored]
    total = sum(weights) or 1.0
    rpm = sum(w * n[1] for w, (_, n) in zip(weights, scored)) / total
    zscore = (best - mean) / sd
    if best < NICHE_MIN_COS or zscore < NICHE_MIN_Z:
        return {"niche": None, "confidence": round(best, 3), "z": round(zscore, 2),
                "reason": "no niche fits this channel well enough"}
    return {
        "niche": scored[0][1][0],
        "also": [n[0] for _, n in scored[1:]],
        "confidence": round(scored[0][0], 3),
        "z": round(zscore, 2),
        "rpm": round(rpm, 2)
    }


def similar_channels(handle, text, limit, min_subs, max_subs, min_similarity, channel_id=None):
    """Nearest channels by topic, with the source channel excluded.

    Ranking happens in Postgres via the match_channels RPC rather than here, so the rule
    lives in one place and the vector never crosses the network twice.
    """
    known = indexed_channel(handle) if handle else None
    vector = None
    # Exclusion must not hang on the lookup succeeding. When it comes back empty — the row was
    # written moments ago by ingest, or the lookup itself failed and was swallowed — the source
    # channel used to be free to rank against itself, which is how Eagle FC appeared in its own
    # list at 84%: page text embedded on one side, stored description on the other.
    exclude = None
    if known:
        exclude = known.get("id")
        raw = known.get("embedding")
        # PostgREST returns a vector as its text form, "[0.1,0.2,...]".
        if isinstance(raw, str):
            try:
                vector = json.loads(raw)
            except ValueError:
                vector = None
        elif isinstance(raw, list):
            vector = raw
    elif channel_id:
        exclude = channel_id
    used_stored = vector is not None
    if vector is None:
        if known:
            # The row exists but its vector did not survive the round trip. Say so: reporting
            # indexed=True here made a page-text fallback look like an index hit, which is how
            # UFC and Bellator ended up disagreeing about how similar they are.
            print("  %s is indexed but its embedding was unusable (%s)"
                  % (handle, type(known.get("embedding")).__name__), flush=True)
        if not text:
            return {"ok": False, "reason": "channel not indexed yet and no text supplied"}
        vector = embed(text)
    if vector is None:
        return {"ok": False, "reason": "could not embed this channel"}

    rows = _supabase("/rest/v1/rpc/match_channels", {
        "query_embedding": vector,
        "match_count": limit,
        "exclude_id": exclude,
        "min_subscribers": min_subs,
        "max_subscribers": max_subs,
        "min_similarity": min_similarity,
        # Only meaningful for a channel we can identify; without it the RPC ranks on text
        # alone, which is exactly the previous behaviour.
        "graph_source": exclude,
    }, timeout=30)
    # Last line of defence: the id may be absent or stale, but the handle came from the URL.
    want = (handle or "").lstrip("@").lower()
    out = [r for r in (rows or [])
           if (r.get("handle") or "").lstrip("@").lower() != want]
    # A channel that covers several unrelated subjects has an average vector sitting between
    # all of them, near none. The neighbours it returns are then arbitrary, and the only
    # honest thing to do is say so rather than rank noise — @valorreviews produced six
    # unrelated channels at a confident-looking 0.55-0.61 this way. Only meaningful when the
    # stored vector was used: page text embedded on the fly has no coherence measurement.
    coherence = known.get("topic_coherence") if known else None
    scattered = bool(used_stored and coherence is not None
                     and coherence < COHERENCE_FLOOR)
    # "indexed" means the stored vector was used, not merely that a row exists.
    return {"ok": True, "indexed": used_stored, "scattered": scattered,
            "coherence": coherence, "channels": out}


def _clamp(query, name, default, low, high):
    try:
        return max(low, min(high, int((query.get(name) or [default])[0])))
    except (TypeError, ValueError):
        return default


def _clamp_float(query, name, default, low, high):
    try:
        return max(low, min(high, float((query.get(name) or [default])[0])))
    except (TypeError, ValueError):
        return default


def _opt_int(query, name):
    raw = (query.get(name) or [""])[0]
    try:
        return int(raw) if raw else None
    except ValueError:
        return None


YT_API = "https://www.googleapis.com/youtube/v3"
YT_KEY = os.environ.get("YOUTUBE_API_KEY") or os.environ.get("NEXT_PUBLIC_YOUTUBE_API_KEY", "")
# Below this, a channel is not a competitor anybody is looking for, and indexing it only
# crowds the results. The 11-subscriber channel that reached the index during seeding is
# exactly what this keeps out.
MIN_INDEX_SUBS = 100
# Below this a match is noise. It was 0.55, which withheld everything for a channel whose
# best neighbour scored 50% — the panel then read as though nothing had been indexed at all,
# when the truth was "indexed, but not close". A scored 50% match the reader can judge beats
# silence they cannot.
DEFAULT_FLOOR = 0.35   # see background.js: 0.45 hid genuine neighbours scoring 0.449

# Below this, a channel's own videos disagree with each other so much that its average vector
# points nowhere and its neighbours are noise wearing a confident number. Drawn between two
# measured populations that do not overlap: a topically mixed channel's videos agreed at 0.250
# (max 0.452), a single-subject channel's at 0.674 (min 0.571).
COHERENCE_FLOOR = float(os.environ.get("COHERENCE_FLOOR") or 0.45)
INGEST_READY = bool(INDEX_READY and OPENAI_KEY and YT_KEY)

# How many search-discovered channels /similar will enrich before answering. This is the one
# place the extension pays for recall synchronously, so it is capped: each channel costs a
# channels.list share plus one playlistItems call, and the caller is a panel someone is
# watching. The rest of what the extension found still goes to /ingest in the background.
SIMILAR_CANDIDATES = _int("SIMILAR_CANDIDATES", 20)


def _get_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8", "replace"))


def resolve_handles(handles):
    """Handle -> channel id, one quota unit each.

    Ingest keys off channel ids, so a payload carrying only a handle used to be dropped in
    silence. That is affordable here because it runs for the handful of channels a person
    actually visits, not for bulk discovery, which always arrives with ids attached.
    """
    out = {}
    for h in handles[:5]:
        handle = h if h.startswith("@") else "@" + h
        url = ("%s/channels?part=id&forHandle=%s&key=%s"
               % (YT_API, quote(handle), YT_KEY))
        try:
            data = _get_json(url)
        except Exception:
            continue
        items = data.get("items") or []
        if items:
            out[handle] = items[0]["id"]
    return out


def fetch_channel_records(ids):
    """Up to 50 channels for a single quota unit — the reason ingesting from user activity
    is affordable rather than something that needs rationing."""
    out = {}
    for i in range(0, len(ids), 50):
        batch = [c for c in ids[i:i + 50] if re.match(r"^UC[\w-]{20,24}$", c or "")]
        if not batch:
            continue
        url = ("%s/channels?part=snippet,statistics,contentDetails&id=%s&maxResults=50&key=%s"
               % (YT_API, ",".join(batch), YT_KEY))
        try:
            data = _get_json(url)
        except Exception:
            continue
        for item in data.get("items") or []:
            out[item["id"]] = item
    return out


def embed_many(texts):
    data = {"model": EMBED_MODEL, "input": texts, "dimensions": EMBED_DIMS}
    out = _post_json("https://api.openai.com/v1/embeddings", data,
                     {"Authorization": "Bearer " + OPENAI_KEY}, timeout=60)
    rows = sorted((out or {}).get("data") or [], key=lambda r: r["index"])
    return [r["embedding"] for r in rows]


def already_indexed(ids):
    if not ids:
        return set()
    quoted = ",".join('"' + i + '"' for i in ids)
    url = SUPABASE_URL + "/rest/v1/channels?select=id&id=in.(" + urllib.parse.quote(quoted) + ")"
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return {r["id"] for r in json.loads(res.read().decode("utf-8", "replace"))}
    except Exception:
        return set()


# Boilerplate every channel carries: business emails, socials, support pleas, copyright
# notices. It is noise they all share, so leaving it in pulls unrelated channels together,
# and it crowds out the description proper. Air Crash Investigation's embedded text opened
# with a business email, an X link and a support plea; what the channel actually does
# appeared 300 characters in, competing for the same 800-character budget.
_DESC_URL    = re.compile(r"https?://\S+|www\.\S+", re.I)
_DESC_EMAIL  = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
_DESC_HANDLE = re.compile(r"(?<!\w)@[\w.]+")
_DESC_HASH   = re.compile(r"#\w+")
_DESC_STAMP  = re.compile(r"\b\d{1,2}:\d{2}(:\d{2})?\b")
_DESC_EMOJI  = re.compile("[\U0001F000-\U0001FAFF\u2190-\u27BF\uFE0F]")
# Never topic signal, at any length.
_DESC_HARD = re.compile(
    r"\b(business (inquiries|enquiries)|for (business|collaborations?|sponsorships?)|"
    r"contact (me|us)|support(ing)? (the|my|this) channel|buy me a|use code|"
    r"affiliate|merch(andise)?|patreon|paypal|donat(e|ion)|"
    r"copyright disclaimer|fair use|all rights reserved)\b", re.I)
# These can carry signal — "Subscribe for weekly aviation documentaries" says what the
# channel is about — so they go only when the line is nothing but the ask.
_DESC_SOFT = re.compile(
    r"\b(subscribe|like and share|smash that|turn on notifications?|hit the bell)\b", re.I)


def clean_description(desc):
    """Drop the promotional furniture, keep the sentences that say what the channel covers."""
    out = []
    for line in (desc or "").split("\n"):
        t = _DESC_URL.sub(" ", line)
        t = _DESC_EMAIL.sub(" ", t)
        t = _DESC_HANDLE.sub(" ", t)
        t = _DESC_HASH.sub(" ", t)
        t = _DESC_STAMP.sub(" ", t)
        t = _DESC_EMOJI.sub(" ", t)
        t = re.sub(r"\s+", " ", t).strip(" -\u2022|\u00b7:,")
        # Whatever is left of a line that was only a link, a handle, or a fragment.
        if len(t) < 25 or len(t.split()) < 4:
            continue
        if _DESC_HARD.search(t):
            continue
        if _DESC_SOFT.search(t) and len(t.split()) < 12:
            continue
        out.append(t)
    return "\n".join(out)


def recent_uploads(playlist_id, want=15):
    """Recent uploads: cadence, last upload, the titles that go into the embedding, and the
    video ids the transcript fallback samples when there is no description to embed.

    One quota unit per channel. seed.py has always done this; ingest did not, so channels
    that arrived through user activity had no Uploads/mo or Last upload and a thinner
    embedding than crawled ones — two grades of row in the same table.
    """
    url = ("%s/playlistItems?part=snippet&playlistId=%s&maxResults=%d&key=%s"
           % (YT_API, playlist_id, want, YT_KEY))
    try:
        data = _get_json(url)
    except Exception:
        return [], None, None, []
    titles, newest, oldest, videos = [], None, None, []
    for item in data.get("items") or []:
        snip = item.get("snippet") or {}
        title = (snip.get("title") or "").strip()
        if title and title.lower() not in ("private video", "deleted video"):
            titles.append(title)
            vid = ((snip.get("resourceId") or {}).get("videoId") or "").strip()
            if vid:
                videos.append({"id": vid, "title": title})
        stamp = snip.get("publishedAt")
        if stamp:
            if newest is None or stamp > newest:
                newest = stamp
            if oldest is None or stamp < oldest:
                oldest = stamp
    return titles, newest, oldest, videos


def uploads_per_month(count, oldest, newest):
    """Uploads per month across the sampled window, not the channel's lifetime — a channel
    that posted daily for a year then stopped is not uploading thirty times a month now."""
    if not oldest or not newest or count < 2:
        return None
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    try:
        a = datetime.strptime(oldest, fmt)
        b = datetime.strptime(newest, fmt)
    except ValueError:
        return None
    months = max((b - a).days / 30.0, 0.25)
    return round(count / months, 2)


# The dashboard is one self-contained page: it is served from the same token-gated path it
# queries, so it needs no build step, no CDN and no second origin to configure.
DASHBOARD_HTML = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Channel index</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#fff; --fg:#0f0f0f; --dim:#606060; --line:rgba(0,0,0,.12); --card:#fafafa;
    --ok:#0f9d58; --bad:#c5221f; --warn:#e37400;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f0f0f; --fg:#f1f1f1; --dim:#aaa; --line:rgba(255,255,255,.16); --card:#1b1b1b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 20px 60px; background:var(--bg); color:var(--fg);
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--dim); margin:0 0 24px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:26px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card b { display:block; font-size:26px; font-weight:600; letter-spacing:-.5px; }
  .card span { color:var(--dim); font-size:12px; }
  h2 { font-size:14px; margin:26px 0 10px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--dim); font-weight:500; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:7px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td.wide { white-space:normal; color:var(--dim); }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .run { color:var(--warn); }
  button { font:inherit; padding:8px 14px; border-radius:999px; cursor:pointer;
           border:1px solid var(--line); background:var(--card); color:var(--fg); }
  button:hover:not(:disabled) { border-color:var(--fg); }
  button:disabled { opacity:.45; cursor:default; }
  .bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .note { color:var(--dim); font-size:12px; margin-top:10px; }
  .err { color:var(--bad); }
</style>
<div class="wrap">
  <h1>Channel index</h1>
  <p class="sub" id="updated">Loading…</p>

  <div class="grid" id="cards"></div>

  <div class="bar">
    <button id="go" disabled>Run crawl</button>
    <select id="preset">
      <option value="drain">Queue + graph (60)</option>
      <option value="drain-wide">Queue + graph (150)</option>
      <option value="queue-only">Queue only, no graph (100)</option>
    </select>
    <span class="note" id="runnote"></span>
  </div>

  <h2>Recent runs</h2>
  <table id="runs"><thead><tr>
    <th>Started</th><th>Mode</th><th>In</th><th>Stored</th><th>Edges</th><th>Quota</th><th>Result</th>
  </tr></thead><tbody></tbody></table>
  <p class="note" id="foot"></p>
</div>
<script>
  // Same directory as this page, so the token path carries over without being written down.
  const API = location.pathname.replace(/\\/dashboard$/, '');
  const $ = (id) => document.getElementById(id);

  const num = (n) => n == null ? '—' : n.toLocaleString();
  const ago = (iso) => {
    if (!iso) return '—';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return Math.round(s) + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  };

  function card(v, label) {
    return '<div class="card"><b>' + v + '</b><span>' + label + '</span></div>';
  }

  async function load() {
    let d;
    try {
      d = await (await fetch(API + '/stats', { cache: 'no-store' })).json();
    } catch (e) {
      $('updated').innerHTML = '<span class="err">Cannot reach the service.</span>';
      return;
    }
    if (!d.ok) {
      $('updated').innerHTML = '<span class="err">' + (d.reason || 'unavailable') + '</span>';
      return;
    }

    const runs = d.runs || [];
    const last = runs[0];
    $('cards').innerHTML =
      card(num(d.channels), 'channels indexed') +
      card(num(d.edges), 'edges') +
      card(num(d.small_channels), 'under 5K subs') +
      card(num(d.queue), 'queued, not yet indexed') +
      card(last ? ago(last.started_at) : 'never', 'last crawl started');

    // A crawl that stopped weeks ago looks exactly like one with nothing to do, which is the
    // whole reason this page exists — so say it outright rather than leaving it to be read
    // off a timestamp.
    let health = '';
    if (!last) health = '<span class="bad">The crawler has never run.</span>';
    else {
      const days = (Date.now() - Date.parse(last.started_at)) / 86400000;
      if (d.crawl_running) health = '<span class="run">A crawl is running now.</span>';
      else if (last.ok === false) health = '<span class="bad">The last run failed.</span>';
      else if (days > 2) health = '<span class="bad">No crawl in ' + Math.floor(days) +
        ' days — the schedule may have stopped.</span>';
      else health = '<span class="ok">Healthy.</span>';
    }
    $('updated').innerHTML = health + ' Updated ' + new Date().toLocaleTimeString() + '.';

    $('runs').querySelector('tbody').innerHTML = runs.map((r) => {
      const result = r.ok === true ? '<span class="ok">ok</span>'
        : r.ok === false ? '<span class="bad">' + (r.error || 'failed') + '</span>'
        : '<span class="run">running…</span>';
      return '<tr><td>' + ago(r.started_at) + '</td><td>' + (r.mode || '—') + '</td><td>' +
        num(r.channels_in) + '</td><td>' + num(r.channels_out) + '</td><td>' +
        num(r.edges_out) + '</td><td>' + num(r.quota_units) + '</td><td class="wide">' +
        result + '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="wide">No runs recorded yet.</td></tr>';

    const can = d.crawler_available && !d.crawl_running;
    $('go').disabled = !can;
    $('runnote').textContent = !d.crawler_available
      ? 'This host cannot crawl — a datacenter IP gets blocked, so run it from your own machine.'
      : d.crawl_running ? 'Running…' : (d.crawl_last || '');
    $('foot').textContent = 'Discovery is free scraping; only enrichment spends quota, ' +
      'roughly one unit per new channel against 10,000 a day.';
  }

  $('go').addEventListener('click', async () => {
    $('go').disabled = true;
    $('runnote').textContent = 'Starting…';
    try {
      const r = await (await fetch(API + '/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: $('preset').value })
      })).json();
      if (!r.ok) $('runnote').textContent = r.reason || 'could not start';
    } catch (e) {
      $('runnote').textContent = 'could not start';
    }
    setTimeout(load, 1500);
  });

  load();
  setInterval(load, 15000);
</script>
"""


def _rest_get(path, timeout=20):
    req = urllib.request.Request(
        SUPABASE_URL + path,
        headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
                 "Prefer": "count=exact", "Range": "0-0"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        # PostgREST reports the true total in Content-Range as "0-0/1234" even when one row
        # was asked for, which is far cheaper than pulling the rows to count them.
        rng = res.headers.get("Content-Range") or ""
        body = res.read().decode("utf-8", "replace")
    total = None
    if "/" in rng:
        try:
            total = int(rng.rsplit("/", 1)[1])
        except ValueError:
            total = None
    return total, (json.loads(body) if body.strip() else [])


# PRIVACY.md is the single source of truth for the policy; this renders it rather than
# holding a second copy that would drift from it. The file sits at the repository root, which
# is what a Render checkout deploys — a Docker image built from transcript_service/ alone
# would not carry it, so a missing file is reported rather than silently served as a blank
# page. A privacy URL that 404s during review is a rejection.
PRIVACY_PATHS = [
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "PRIVACY.md"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "PRIVACY.md"),
]


def _md_inline(text):
    text = (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\w)_([^_]+)_(?!\w)", r"<em>\1</em>", text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    return text


def privacy_html():
    """The policy as a page. A deliberately small Markdown subset — headings, lists,
    paragraphs, tables are not used in it — because pulling in a renderer for one document
    would be a dependency to keep updated forever."""
    body = None
    for path in PRIVACY_PATHS:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                body = fh.read()
            break
    if body is None:
        return None

    out, in_list = [], False
    for line in body.split("\n"):
        line = line.rstrip()
        if line.startswith("- "):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append("<li>%s</li>" % _md_inline(line[2:]))
            continue
        if in_list:
            out.append("</ul>")
            in_list = False
        if not line.strip():
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            lvl = len(m.group(1))
            out.append("<h%d>%s</h%d>" % (lvl, _md_inline(m.group(2)), lvl))
        else:
            out.append("<p>%s</p>" % _md_inline(line))
    if in_list:
        out.append("</ul>")

    # Concatenated, not %-formatted: the stylesheet contains "90%", which % formatting reads
    # as a broken conversion and raises.
    return """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YouTube Toolkit \u2014 Privacy Policy</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 720px; margin: 0 auto; padding: 48px 20px 80px;
         font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
         color: #1a1a1a; background: #fff; }
  h1 { font-size: 28px; margin: 0 0 6px; }
  h2 { font-size: 19px; margin: 34px 0 10px; }
  p, li { margin: 10px 0; }
  ul { padding-left: 22px; }
  code { background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 4px; font-size: 90%; }
  a { color: #0b57d0; }
  em { color: #555; font-style: normal; font-size: 14px; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8e8; background: #121212; }
    code { background: rgba(255,255,255,.1); }
    a { color: #8ab4f8; }
    em { color: #aaa; }
  }
</style>
""" + "\n".join(out) + "\n"


def index_stats():
    """Numbers for the dashboard: how big the index is, how much of it has been walked, and
    whether the crawler has run recently."""
    if not INDEX_READY:
        return {"ok": False, "reason": "channel index not configured"}
    out = {"ok": True}
    try:
        out["channels"], _ = _rest_get("/rest/v1/channels?select=id")
        out["edges"], _ = _rest_get("/rest/v1/channel_edges?select=source_id")
        out["small_channels"], _ = _rest_get("/rest/v1/channels?select=id&subscribers=lt.5000")
        out["queue"], _ = _rest_get("/rest/v1/channel_sightings?select=id&fetched=is.false")
        req = urllib.request.Request(
            SUPABASE_URL + "/rest/v1/crawl_runs?select=*&order=started_at.desc&limit=12",
            headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY})
        with urllib.request.urlopen(req, timeout=20) as res:
            out["runs"] = json.loads(res.read().decode("utf-8", "replace"))
    except Exception as e:
        return {"ok": False, "reason": "%s: %s" % (type(e).__name__, e)}
    out["crawler_available"] = CRAWLER_ENABLED and os.path.exists(SEED_SCRIPT)
    return out


# Whether this host may crawl is declared, not inferred. The first attempt tested for the
# crawler script on disk, on the assumption the deployed image held only app.py — but Render
# runs from a repo checkout, so the file is there and the button appeared on a host whose
# datacenter IP gets the bot interstitial. An explicit opt-in, set by run_local.sh and by
# nothing else, cannot be wrong about this the way a guess can.
CRAWLER_ENABLED = os.environ.get("CRAWLER_ENABLED") == "1"
SEED_SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "channel_index", "seed.py")
CRAWL_LOCK = threading.Lock()
CRAWL_STATE = {"running": False, "started": None, "last": ""}


def start_crawl(mode_args):
    """Run the crawler in the background and return immediately.

    Deliberately fire-and-forget: a graph walk takes minutes, far longer than any sensible
    HTTP request, so the dashboard polls /stats for the run row rather than holding a socket
    open for it.
    """
    if not (CRAWLER_ENABLED and os.path.exists(SEED_SCRIPT)):
        return {"ok": False,
                "reason": "this host cannot crawl — run it from a residential connection"}
    with CRAWL_LOCK:
        if CRAWL_STATE["running"]:
            return {"ok": False, "reason": "a crawl is already running"}
        CRAWL_STATE["running"] = True
        CRAWL_STATE["started"] = time.time()

    def run():
        try:
            proc = subprocess.run([sys.executable, SEED_SCRIPT] + mode_args,
                                  capture_output=True, text=True, timeout=3600)
            tail = (proc.stdout or proc.stderr or "").strip().splitlines()
            CRAWL_STATE["last"] = tail[-1] if tail else "finished"
        except Exception as e:
            CRAWL_STATE["last"] = "%s: %s" % (type(e).__name__, e)
        finally:
            CRAWL_STATE["running"] = False

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True, "started": True}


def video_owners(video_ids):
    """Video id -> who published it and when, 50 per quota unit.

    Shorts are why this returns the whole record rather than a bare channel id. YouTube's
    shorts lockups carry a title and a view count and nothing else — no byline, no upload
    date, in the DOM or in ytInitialData — so a short on a results page has no channel to look
    up and no age to divide views by, which is every badge the extension draws. One
    videos.list call answers fifty of them for a single quota unit, which is the only
    affordable way to ask: the alternative is a ~1MB watch page per short.
    """
    out = {}
    ids = [v for v in video_ids if re.match(r"^[\w-]{11}$", v or "")][:50]
    if not ids or not YT_KEY:
        return out
    url = ("%s/videos?part=snippet&id=%s&maxResults=50&key=%s"
           % (YT_API, ",".join(ids), YT_KEY))
    try:
        data = _get_json(url)
    except Exception as e:
        print("  video_owners failed: %s: %s" % (type(e).__name__, e), flush=True)
        return out
    for item in data.get("items") or []:
        snip = item.get("snippet") or {}
        cid = (snip.get("channelId") or "").strip()
        if not cid:
            continue
        out[item.get("id") or ""] = {
            # The key form the extension already uses for a channel it knows only by id, so
            # the answer drops straight into the subscriber cache beside the handle-keyed
            # ones rather than needing a second lookup to turn it into a handle.
            "channel": "channel/" + cid,
            "channelId": cid,
            "channelTitle": snip.get("channelTitle") or "",
            "publishedAt": snip.get("publishedAt") or "",
        }
    return out


def channels_for_videos(video_ids):
    """Just the channel ids, for callers that only need to know who is involved."""
    return {rec["channelId"] for rec in video_owners(video_ids).values()}


# A page is fifty items: YouTube's maximum for both playlistItems and videos.list, so every
# extra fifty videos costs exactly two quota units. The cap is what stops one request for a
# channel that uploads hourly from spending a day's quota by itself.
VIDEO_PAGE = 50
VIDEO_MAX_PAGES = _int("VIDEO_MAX_PAGES", 24)      # 1,200 videos, 48 units, worst case


def channel_videos(handle, channel_id=None, want=50, days=None):
    """A channel's recent uploads with durations and view counts, through the API.

    The first version of this scraped the channel's videos grid from the browser. That was
    wrong twice over: the markup moved from videoId renderers to lockupViewModel and the
    parser silently returned nothing, and YouTube rate-limits the fetch anyway. The API costs
    two quota units for fifty videos, cannot be rate-limited by IP, and returns the durations
    the grid only renders as text.

    `days` asks for a period rather than a count, which is what a chart with Day/Week/Month/
    Year buttons actually needs: a channel posting fifty times a month has a whole year of
    history that one page of fifty cannot reach, and showing it thirty days under a button
    marked Year is simply wrong. The uploads playlist comes back newest first, so paging can
    stop at the first video older than the cutoff instead of walking the entire channel —
    a year costs what that year holds, not what the channel has ever published.
    """
    if not YT_KEY:
        return {"ok": False, "reason": "no youtube key"}

    cid = channel_id
    if not cid:
        row = indexed_channel(handle)
        cid = row.get("id") if row else None
    if not cid:
        found = resolve_handles([handle])
        cid = found.get(handle if handle.startswith("@") else "@" + handle)
    if not cid:
        return {"ok": False, "reason": "unknown channel"}

    records = fetch_channel_records([cid])
    ch = records.get(cid)
    uploads = (((ch or {}).get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads")
    if not uploads:
        return {"ok": False, "reason": "no uploads playlist"}

    cutoff = None
    if days:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=float(days))).isoformat()
    limit = max(1, int(want or VIDEO_PAGE))

    order, meta, token, pages, truncated = [], {}, None, 0, False
    while pages < VIDEO_MAX_PAGES:
        url = ("%s/playlistItems?part=snippet&playlistId=%s&maxResults=%d&key=%s%s"
               % (YT_API, uploads, VIDEO_PAGE, YT_KEY,
                  ("&pageToken=" + token) if token else ""))
        try:
            listing = _get_json(url)
        except Exception as e:
            if not order:
                return {"ok": False, "reason": "%s: %s" % (type(e).__name__, e)}
            truncated = True
            break
        pages += 1

        past = False
        for item in listing.get("items") or []:
            snip = item.get("snippet") or {}
            vid = ((snip.get("resourceId") or {}).get("videoId") or "").strip()
            if not vid:
                continue
            when = snip.get("publishedAt") or ""
            # Newest first, so the first video older than the cutoff ends the walk. Checked
            # per item rather than per page: a page straddling the boundary must contribute
            # the part that falls inside it.
            if cutoff and when and when < cutoff:
                past = True
                break
            order.append(vid)
            meta[vid] = {"id": vid, "title": snip.get("title") or "",
                         "publishedAt": when}
            if len(order) >= limit:
                break

        token = listing.get("nextPageToken")
        if past or not token or len(order) >= limit:
            # Out of period, out of channel, or out of allowance — only the last is a cut.
            truncated = truncated or (len(order) >= limit and bool(token) and not past)
            break
    else:
        truncated = True

    if not order:
        return {"ok": True, "videos": [], "truncated": False, "pages": pages}

    # Durations and view counts, fifty ids per unit.
    for start in range(0, len(order), VIDEO_PAGE):
        chunk = order[start:start + VIDEO_PAGE]
        url2 = ("%s/videos?part=contentDetails,statistics&id=%s&maxResults=%d&key=%s"
                % (YT_API, ",".join(chunk), VIDEO_PAGE, YT_KEY))
        try:
            detail = _get_json(url2)
        except Exception as e:
            print("  channel_videos detail failed: %s: %s" % (type(e).__name__, e), flush=True)
            continue
        for item in detail.get("items") or []:
            row = meta.get(item.get("id"))
            if not row:
                continue
            row["seconds"] = _iso_duration_seconds(
                ((item.get("contentDetails") or {}).get("duration") or ""))
            stats = item.get("statistics") or {}
            try:
                row["views"] = int(stats.get("viewCount"))
            except (TypeError, ValueError):
                row["views"] = None

    return {"ok": True, "videos": [meta[v] for v in order if v in meta],
            "truncated": truncated, "pages": pages}


def _iso_duration_seconds(iso):
    """PT20M36S -> 1236. The API reports duration only in this form."""
    m = re.match(r"^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$", iso or "")
    if not m:
        return None
    h, mi, se = (int(g) if g else 0 for g in m.groups())
    total = h * 3600 + mi * 60 + se
    return total or None


# ─── velocity sampling ───────────────────────────────────────────────────────
#
# The cards on a search page carry views and an age, and dividing one by the other gives a
# LIFETIME AVERAGE — not a current rate. It falls as a video gets older no matter what the
# audience does, because the denominator keeps growing, so charting it against publish date
# draws the same decaying curve for a topic that is exploding and one that is dead.
#
# Real velocity is the difference between two counts taken at two known times. That is all
# this section does: pin a set of videos to a keyword, record what their counts were, and
# subtract. Which also means it needs no history to get started — unlike a per-video "first
# 24 hours" curve, where the first sample has to land at upload, two samples an hour apart
# are already a real data point for a keyword.

SAMPLE_BATCH = 50          # ids per statistics call; the API charges one unit either way
KEYWORD_SET_TTL_H = 24     # how long a resolved video set stands before it is re-read

# Its own flag rather than INGEST_READY, which also demands an OpenAI key: sampling view
# counts embeds nothing, and an operator with a YouTube key but no OpenAI credit should still
# get velocity. Reading a series back needs neither — only the database.
SAMPLE_READY = bool(INDEX_READY and YT_KEY)


def _sb_get(path, timeout=20):
    """A GET against PostgREST, with the one retry the rest of this file uses."""
    req = urllib.request.Request(
        SUPABASE_URL + path,
        headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY})
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.loads(res.read().decode("utf-8", "replace") or "[]")
        except Exception as e:
            if attempt == 2:
                print("  _sb_get(%s) failed: %s: %s" % (path, type(e).__name__, e), flush=True)
                return None
            time.sleep(0.4)
    return None


def _sb_patch(path, payload, timeout=30):
    """An in-place column update. Upsert would work, but writing only the columns that changed
    keeps a half-finished enrichment from resetting anything else on the row."""
    req = urllib.request.Request(
        SUPABASE_URL + path, data=json.dumps(payload).encode(), method="PATCH",
        headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
                 "Content-Type": "application/json", "Prefer": "return=minimal"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        res.read()


def track_keyword(keyword, video_ids):
    """Pin the videos that represent a keyword.

    The ids come from the extension, off a search page the user opened anyway — the same
    division of labour the channel index already uses. A server running the search itself
    would get the bot interstitial, and would be guessing at the ranking the user actually
    saw.
    """
    keyword = (keyword or "").strip().lower()
    ids = [v for v in (video_ids or []) if isinstance(v, str) and len(v) == 11][:SAMPLE_BATCH]
    if not SAMPLE_READY or not keyword or not ids:
        return {"ok": False, "reason": "keyword and video ids required"}

    # Still inside the current window: keep the existing set rather than starting a rival one,
    # or the series would be spliced together from two different populations.
    fresh = _sb_get(
        "/rest/v1/keyword_videos?select=resolved_at&keyword=eq."
        + urllib.parse.quote(keyword) + "&order=resolved_at.desc&limit=1")
    if fresh:
        try:
            seen = datetime.fromisoformat(
                fresh[0]["resolved_at"].replace("Z", "+00:00"))
            age_h = (datetime.now(timezone.utc) - seen).total_seconds() / 3600
            if age_h < KEYWORD_SET_TTL_H:
                return {"ok": True, "reused": True, "videos": len(ids)}
        except Exception:
            pass

    now = datetime.now(timezone.utc).isoformat()
    _supabase("/rest/v1/keyword_videos?on_conflict=keyword,video_id,resolved_at",
              [{"keyword": keyword, "video_id": v, "resolved_at": now, "rank": i}
               for i, v in enumerate(ids)],
              prefer="resolution=merge-duplicates")
    _supabase("/rest/v1/tracked_videos?on_conflict=id",
              [{"id": v} for v in ids], prefer="resolution=ignore-duplicates")
    # Sample immediately: the second point needs a first one, and taking it now rather than
    # waiting for the next cron means the series starts from when the keyword was asked about.
    sample_videos(ids)
    return {"ok": True, "reused": False, "videos": len(ids)}


def sample_videos(ids=None, limit=500):
    """Record what a batch of videos' view counts are right now."""
    if not SAMPLE_READY:
        return {"ok": False, "reason": "not configured"}

    if ids is None:
        stale = _sb_get("/rest/v1/tracked_videos?select=id"
                        "&order=last_sampled.asc.nullsfirst&limit=%d" % limit) or []
        ids = [r["id"] for r in stale]
    ids = list(dict.fromkeys(ids))
    if not ids:
        return {"ok": True, "sampled": 0}

    now = datetime.now(timezone.utc).isoformat()
    rows, seen = [], 0
    for i in range(0, len(ids), SAMPLE_BATCH):
        chunk = ids[i:i + SAMPLE_BATCH]
        url = ("%s/videos?part=statistics&id=%s&maxResults=%d&key=%s"
               % (YT_API, ",".join(chunk), SAMPLE_BATCH, YT_KEY))
        try:
            out = _get_json(url)
        except Exception as e:
            print("  sample_videos batch failed: %s: %s" % (type(e).__name__, e), flush=True)
            continue
        for item in out.get("items") or []:
            vid = item.get("id")
            count = ((item.get("statistics") or {}).get("viewCount"))
            if not vid or count is None:
                continue          # private, deleted, or counts hidden — no row is honest here
            rows.append({"video_id": vid, "sampled_at": now, "views": int(count)})
            seen += 1

    if rows:
        _supabase("/rest/v1/video_samples?on_conflict=video_id,sampled_at", rows,
                  timeout=60, prefer="resolution=merge-duplicates")
        _supabase("/rest/v1/tracked_videos?on_conflict=id",
                  [{"id": r["video_id"], "last_sampled": now} for r in rows],
                  timeout=60, prefer="resolution=merge-duplicates")
    return {"ok": True, "sampled": seen, "asked": len(ids)}


def keyword_series(keyword, hours=168, buckets=24):
    """Views per hour for a keyword over time, from the differences between samples.

    Only videos present in BOTH ends of a step contribute to it. A video that entered the set
    late, or whose sample failed, would otherwise arrive as a spike the size of its entire
    view count — the series would show a surge that is really just bookkeeping.
    """
    keyword = (keyword or "").strip().lower()
    if not INDEX_READY or not keyword:
        return {"ok": False, "reason": "keyword required"}

    kv = _sb_get("/rest/v1/keyword_videos?select=video_id,resolved_at&keyword=eq."
                 + urllib.parse.quote(keyword) + "&order=resolved_at.desc&limit=200")
    if not kv:
        return {"ok": True, "points": [], "reason": "not tracked yet"}
    newest = kv[0]["resolved_at"]
    ids = sorted({r["video_id"] for r in kv if r["resolved_at"] == newest})
    if not ids:
        return {"ok": True, "points": []}

    since = (datetime.now(timezone.utc)
             - timedelta(hours=hours)).isoformat()
    quoted = ",".join('"%s"' % v for v in ids)
    samples = _sb_get(
        "/rest/v1/video_samples?select=video_id,sampled_at,views"
        "&video_id=in.(" + urllib.parse.quote(quoted) + ")"
        "&sampled_at=gte." + urllib.parse.quote(since) +
        "&order=sampled_at.asc&limit=20000") or []
    # Group by the instant they were taken: the sampler writes one timestamp per run, so a run
    # is a column of counts across the whole set.
    runs = {}
    for r in samples:
        runs.setdefault(r["sampled_at"], {})[r["video_id"]] = int(r["views"])
    stamps = sorted(runs)

    # Runs, not rows. Counting rows passes trivially the moment more than one video is
    # tracked — twelve videos sampled once is twelve rows and still no elapsed time to divide
    # by — so the answer came back as an empty series with no reason given rather than as the
    # honest "nothing to compare against yet".
    if len(stamps) < 2:
        return {"ok": True, "points": [], "videos": len(ids),
                "samples": len(stamps), "reason": "needs a second sample"}

    points = []
    for a, b in zip(stamps, stamps[1:]):
        ta = datetime.fromisoformat(a.replace("Z", "+00:00"))
        tb = datetime.fromisoformat(b.replace("Z", "+00:00"))
        gap_h = (tb - ta).total_seconds() / 3600
        if gap_h <= 0:
            continue
        both = runs[a].keys() & runs[b].keys()
        if not both:
            continue
        # Counts do go down — YouTube prunes views it decides were not real. That is a
        # correction, not negative watching, so it contributes nothing rather than a dip.
        gained = sum(max(0, runs[b][v] - runs[a][v]) for v in both)
        points.append({"at": b, "vph": round(gained / gap_h, 1),
                       "videos": len(both), "gap_h": round(gap_h, 2)})

    if len(points) > buckets:
        # Thin evenly rather than dropping the tail, so the shape survives and the last point
        # is still the most recent one.
        step = len(points) / float(buckets)
        points = [points[min(len(points) - 1, int(i * step))] for i in range(buckets)]

    return {"ok": True, "keyword": keyword, "videos": len(ids),
            "resolved_at": newest, "points": points}


def record_edges(source_handle, target_handles, video_ids=None, source_id=None):
    """Store co-recommendation edges the extension observed on a watch page.

    Only channels already in the index are stored. Targets are matched by handle in a single
    query — free — and anything unknown is dropped rather than resolved, because resolving
    costs a quota unit each and an edge to a channel the ranker can never return is worth
    nothing anyway. That also bounds the work: a heavily browsed session cannot run up a bill.
    """
    if not INDEX_READY:
        return {"ok": False, "reason": "channel index not configured"}

    wanted = {h.strip().lower() for h in ([source_handle] + list(target_handles or []))
              if h and h.strip()}
    wanted = {h if h.startswith("@") else "@" + h for h in wanted}
    # Video ids are a second source of targets, resolved further down, so their presence is
    # reason enough to continue even when no handle was readable from the page.
    if len(wanted) < 2 and not video_ids:
        return {"ok": True, "edges": 0, "reason": "nothing to record"}

    # customUrl comes back lowercased from the API, so that is how handles are stored; the
    # DOM preserves display case (@BellatorMMA), which would match nothing without folding.
    quoted = ",".join('"%s"' % h.replace('"', "") for h in list(wanted)[:64])
    query = ("/rest/v1/channels?select=id,handle&handle=in.(" +
             urllib.parse.quote(quoted) + ")")
    req = urllib.request.Request(
        SUPABASE_URL + query,
        headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            rows = json.loads(res.read().decode("utf-8", "replace"))
    except Exception as e:
        print("  record_edges lookup failed: %s: %s" % (type(e).__name__, e), flush=True)
        return {"ok": False, "reason": "lookup failed"}

    by_handle = {(r.get("handle") or "").lower(): r["id"] for r in rows}
    src = by_handle.get((source_handle or "").lower())
    if not src and source_id:
        # Index the source first rather than discarding the edges. A channel is usually met
        # through one of its videos, not its channel page, so refusing to record until it had
        # been indexed some other way threw away the commonest case entirely.
        ingest_channels([{"id": source_id, "handle": source_handle}])
        try:
            req3 = urllib.request.Request(
                SUPABASE_URL + "/rest/v1/channels?select=id&id=eq." +
                urllib.parse.quote(source_id),
                headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY})
            with urllib.request.urlopen(req3, timeout=20) as res3:
                found = json.loads(res3.read().decode("utf-8", "replace"))
            if found:
                src = found[0]["id"]
        except Exception as e:
            print("  source re-lookup failed: %s: %s" % (type(e).__name__, e), flush=True)

    if not src:
        # Still nothing to hang the edges on — the channel is below the index's size floor, or
        # has no usable text. Reported rather than silently dropped.
        return {"ok": True, "edges": 0, "reason": "source could not be indexed"}
    targets = [i for h, i in by_handle.items() if i != src]

    if video_ids:
        from_videos = channels_for_videos(video_ids)
        from_videos.discard(src)
        if from_videos:
            # Only those already indexed: an edge to a channel the ranker can never return is
            # worth nothing, and resolving the rest would cost a unit each.
            known = set()
            quoted = ",".join('"%s"' % c.replace('"', "") for c in list(from_videos)[:50])
            try:
                req2 = urllib.request.Request(
                    SUPABASE_URL + "/rest/v1/channels?select=id&id=in.(" +
                    urllib.parse.quote(quoted) + ")",
                    headers={"apikey": SUPABASE_KEY,
                             "Authorization": "Bearer " + SUPABASE_KEY})
                with urllib.request.urlopen(req2, timeout=20) as res2:
                    known = {r["id"] for r in json.loads(res2.read().decode("utf-8", "replace"))}
            except Exception as e:
                print("  edge target lookup failed: %s: %s" % (type(e).__name__, e), flush=True)
            targets = list(set(targets) | (known - {src}))

    if not targets:
        return {"ok": True, "edges": 0, "reason": "no indexed targets"}

    out = _supabase("/rest/v1/rpc/record_edges",
                    {"p_source": src, "p_targets": targets}, timeout=30)
    return {"ok": True, "edges": out if isinstance(out, int) else len(targets)}


def ingest_channels(pairs):
    """Index channels the extension discovered, so a niche fills itself in from use.

    The division of labour is what makes this work: the extension scrapes search from a
    residential connection, because a server doing the same gets the bot interstitial, and
    the server enriches through the API, because that needs keys no extension should carry.
    """
    if not INGEST_READY:
        return {"ok": False, "reason": "ingest not configured"}

    wanted = [p.get("id") for p in pairs if p.get("id")][:50]
    # Anything that arrived with only a handle: look the id up rather than dropping it.
    bare = [p.get("handle") for p in pairs if not p.get("id") and p.get("handle")]
    if bare and len(wanted) < 50:
        wanted += [cid for cid in resolve_handles(bare).values() if cid not in wanted]
    fresh = [c for c in wanted if c not in already_indexed(wanted)]
    if not fresh:
        return {"ok": True, "added": 0, "skipped": len(wanted)}

    records = fetch_channel_records(fresh)
    rows, texts, keep = [], [], []
    for cid, ch in records.items():
        stats = ch.get("statistics") or {}
        subs = int(stats.get("subscriberCount") or 0)
        if subs and subs < MIN_INDEX_SUBS:
            continue
        snip = ch.get("snippet") or {}
        uploads = (((ch.get("contentDetails") or {}).get("relatedPlaylists") or {})
                   .get("uploads"))
        titles, newest, oldest, _vids = (recent_uploads(uploads) if uploads
                                         else ([], None, None, []))
        # Titles as well as the description: a channel whose description is a business email
        # has nothing else saying what it is about. seed.py embeds both; this now matches.
        text = "\n".join(x for x in [snip.get("title") or "",
                                      clean_description(snip.get("description"))[:800],
                                      " \u00b7 ".join(titles[:10])] if x)[:2000]
        if not text.strip():
            continue
        texts.append(text)
        keep.append((cid, ch, text, titles, newest, oldest))

    if not texts:
        return {"ok": True, "added": 0, "skipped": len(wanted)}

    vectors = embed_many(texts)
    for (cid, ch, text, titles, newest, oldest), vec in zip(keep, vectors):
        snip = ch.get("snippet") or {}
        stats = ch.get("statistics") or {}
        views = int(stats.get("viewCount") or 0)
        count = int(stats.get("videoCount") or 0)
        handle = (snip.get("customUrl") or "").strip()
        if handle and not handle.startswith("@"):
            handle = "@" + handle
        thumbs = snip.get("thumbnails") or {}
        avatar = ((thumbs.get("medium") or thumbs.get("default") or {}).get("url")) or None
        rows.append({
            "id": cid,
            "handle": handle or None,
            "avatar_url": avatar,
            "title": snip.get("title") or cid,
            "description": (snip.get("description") or "")[:2000] or None,
            "subscribers": int(stats.get("subscriberCount") or 0) or None,
            "total_views": views or None,
            "video_count": count or None,
            "country": snip.get("country"),
            "published_at": snip.get("publishedAt"),
            "avg_views": (views // count) if count else None,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "last_upload_at": newest,
            "uploads_per_mo": uploads_per_month(len(titles), oldest, newest),
            "embedding": vec,
            "embed_source": text[:500],
            # enriched_at stays null: a channel with no description is thereby queued for the
            # transcript pass, which /enrich drains. Ingest itself never fetches captions —
            # one channel is minutes of yt-dlp, which no HTTP request should be holding open.
            "embed_basis": "titles",
        })

    if rows:
        _supabase("/rest/v1/channels?on_conflict=id", rows, timeout=60,
                  prefer="resolution=merge-duplicates,return=minimal")
    return {"ok": True, "added": len(rows), "skipped": len(wanted) - len(rows)}


# ─── transcript fallback ─────────────────────────────────────────────────────
#
# For the ~7% of indexed channels whose description is empty, the vector is built from the
# channel title plus recent video titles — and on a shorts channel those titles are hashtag
# soup. What is actually said in the videos is far more discriminating: embedded on its own, a
# $40-trillion-debt short lands on "economics" at 0.527 where its title managed 0.174.

TRANSCRIPT_SAMPLE = _int("TRANSCRIPT_SAMPLE", 8)      # usable transcripts wanted per channel
TRANSCRIPT_MIN_VIDEOS = _int("TRANSCRIPT_MIN_VIDEOS", 4)   # below this, don't trust the mean
TRANSCRIPT_MIN_WORDS = _int("TRANSCRIPT_MIN_WORDS", 25)    # shorter than this is not speech
TRANSCRIPT_WORD_CAP = _int("TRANSCRIPT_WORD_CAP", 700)     # per video, to bound token spend
# Caption fetches are independent of each other and almost entirely spent waiting on YouTube,
# so they overlap well: measured serially a channel took 2-7 minutes, which is six hours for a
# 107-channel backfill. Held at or below MAX_CONCURRENCY, because fetch_cached takes a slot
# from the same semaphore that guards the transcript route and gives up after 30s of waiting —
# more workers than slots would simply time each other out.
TRANSCRIPT_WORKERS = max(1, min(_int("TRANSCRIPT_WORKERS", 4), MAX_CONCURRENCY))
ENRICH_BATCH = _int("ENRICH_BATCH", 25)

ENRICH_LOCK = threading.Lock()
ENRICH_STATE = {"running": False, "started": None, "last": None}


def _mean_vector(vectors):
    """The centroid, renormalised. Each video counts once, however long it ran."""
    n = len(vectors)
    mean = [sum(v[i] for v in vectors) / n for i in range(len(vectors[0]))]
    norm = math.sqrt(sum(x * x for x in mean)) or 1.0
    return [x / norm for x in mean]


def _coherence(vectors):
    """Mean pairwise cosine among a channel's own videos: does it have one subject at all?

    This is the number that makes the transcript pass worth running even when it cannot help.
    A vector averaged over unrelated videos is not merely weak, it is confidently wrong-shaped,
    and nothing downstream can tell that from a good one. This can.
    """
    total = pairs = 0.0
    for i in range(len(vectors)):
        for j in range(i + 1, len(vectors)):
            total += _cosine(vectors[i], vectors[j])
            pairs += 1
    return (total / pairs) if pairs else None


def transcript_profile(videos):
    """A channel vector built from what its videos say, plus how much they agree.

    Videos are embedded one at a time and averaged, never concatenated. Concatenation weights a
    channel by whoever talked longest: on @valorreviews one 455-word explainer was 44% of the
    collected words and pulled the whole channel to "economics" at 0.511 while every other
    topic fell below 0.09 — a sharp answer, and the wrong one. Averaging gives each video a
    single vote.

    Very short tracks are dropped. Under ~25 words a caption file is music cues and filler
    ("Woah. Okay.") that embeds somewhere arbitrary and only blurs the mean.
    """
    # Fetched in parallel, then walked in the original order. Both halves matter: order keeps
    # the sample weighted towards recent uploads, and taking whichever finished first would
    # quietly bias every channel towards its videos with the smallest caption files.
    #
    # In waves of TRANSCRIPT_SAMPLE rather than one pass over twice that many. Most channels
    # caption everything, so the first wave is usually the whole job; fetching the spares
    # up front would double both the wall clock and the requests YouTube sees, every time,
    # to cover the minority of channels that need them.
    candidates = [v for v in videos[:TRANSCRIPT_SAMPLE * 2] if v.get("id")]
    picked, used, seen = [], [], 0
    while seen < len(candidates) and len(picked) < TRANSCRIPT_SAMPLE:
        wave = candidates[seen:seen + TRANSCRIPT_SAMPLE]
        seen += len(wave)
        fetched = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=TRANSCRIPT_WORKERS) as pool:
            futures = {pool.submit(fetch_cached, v["id"]): v["id"] for v in wave}
            for future in concurrent.futures.as_completed(futures):
                try:
                    fetched[futures[future]] = future.result()[0]
                except Exception:
                    fetched[futures[future]] = None
        for v in wave:
            if len(picked) >= TRANSCRIPT_SAMPLE:
                break
            segments = fetched.get(v["id"])
            if not segments:
                continue
            words = " ".join(s.get("text") or "" for s in segments).split()
            if len(words) < TRANSCRIPT_MIN_WORDS:
                continue
            picked.append(((v.get("title") or "") + ". "
                           + " ".join(words[:TRANSCRIPT_WORD_CAP])).strip())
            used.append(v["id"])

    # Two or three videos is not a channel, it is an anecdote; the coherence figure computed
    # from that few pairs is too unstable to gate anything on.
    if len(picked) < TRANSCRIPT_MIN_VIDEOS:
        return None
    vectors = embed_many(picked)
    if len(vectors) != len(picked):
        return None
    return {"vector": _mean_vector(vectors), "coherence": _coherence(vectors),
            "videos": used, "text": " \u00b7 ".join(t[:120] for t in picked)}


def enrich_channel(row):
    """Rebuild one description-less channel's vector from its captions."""
    cid = row.get("id") or ""
    # A channel's uploads playlist is its id with the UC prefix swapped for UU, so the video
    # list costs one quota unit and no extra channels.list call to find the playlist.
    if not cid.startswith("UC"):
        return None
    videos = recent_uploads("UU" + cid[2:], want=TRANSCRIPT_SAMPLE * 2)[3]
    return transcript_profile(videos) if videos else None


def enrich_channels(limit=None):
    """Drain the queue of channels whose description says nothing about them.

    A batch, not part of /ingest, because it is slow in a way an HTTP request cannot absorb:
    measured here, one caption fetch took 6.6s for a short and 40.3s for a long-form video, so
    a single channel runs to minutes. enriched_at is stamped either way — a channel whose
    videos have no captions must not come back round the queue forever.
    """
    if not INGEST_READY:
        return {"ok": False, "reason": "ingest not configured"}
    want = max(1, min(int(limit or ENRICH_BATCH), 200))
    # "Blank" is not only NULL and "". Eight rows hold a single newline — @valorreviews among
    # them, the channel this whole path exists for — so a description.eq. test walks straight
    # past them, and btrim's default strips spaces but not newlines, which makes the miss
    # invisible in a count. Ask the question that actually matters instead: does this text
    # contain any non-whitespace character at all? 110 rows, against 102 for the naive test.
    # [^[:space:]] rather than \S because the pattern has to survive a URL.
    blank = "description.not.match." + urllib.parse.quote("[^[:space:]]", safe="")
    rows = _sb_get("/rest/v1/channels?select=id,title,handle"
                   "&or=(description.is.null," + blank + ")"
                   "&enriched_at=is.null&limit=%d" % want)
    if rows is None:
        return {"ok": False, "reason": "could not read the enrichment queue"}

    done = skipped = scattered = 0
    for row in rows:
        try:
            profile = enrich_channel(row)
        except Exception as e:
            print("  enrich %s failed: %s: %s" % (row.get("id"), type(e).__name__, e),
                  flush=True)
            profile = None
        patch = {"enriched_at": datetime.now(timezone.utc).isoformat()}
        if profile:
            patch.update({
                "embedding": profile["vector"],
                "topic_coherence": round(profile["coherence"], 4),
                "embed_basis": "transcripts",
                "embed_source": profile["text"][:500],
            })
            done += 1
            if profile["coherence"] < COHERENCE_FLOOR:
                scattered += 1
        else:
            skipped += 1
        try:
            _sb_patch("/rest/v1/channels?id=eq." + urllib.parse.quote(row["id"]), patch)
        except Exception as e:
            print("  enrich write %s failed: %s" % (row.get("id"), e), flush=True)
    # scattered is reported rather than hidden: it is the share of the batch that gained an
    # honest "no single subject" marker, which is a result, not a failure.
    return {"ok": True, "considered": len(rows), "rebuilt": done,
            "no_captions": skipped, "scattered": scattered}


def start_enrich(limit=None):
    """Run a batch in the background; /stats-style polling beats holding the socket open."""
    with ENRICH_LOCK:
        if ENRICH_STATE["running"]:
            return {"ok": False, "reason": "an enrichment batch is already running"}
        ENRICH_STATE["running"] = True
        ENRICH_STATE["started"] = time.time()

    def run():
        try:
            out = enrich_channels(limit)
            ENRICH_STATE["last"] = out
        except Exception as e:
            ENRICH_STATE["last"] = {"ok": False,
                                    "reason": "%s: %s" % (type(e).__name__, e)}
        finally:
            ENRICH_STATE["running"] = False

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True, "started": True}


def record_sighting(channel_id, handle):
    """A channel someone looked at. The crawler drains this queue later.

    Deliberately fire-and-forget: a failure here must never affect the answer the user asked
    for, and the queue is a convenience for growing the corpus, not part of the request.
    """
    if not (INDEX_READY and channel_id):
        return
    try:
        _supabase("/rest/v1/channel_sightings?on_conflict=id",
                  [{"id": channel_id, "handle": handle or None}],
                  timeout=10, prefer="resolution=merge-duplicates,return=minimal")
    except Exception:
        pass

RATE_LIMIT = _int("RATE_LIMIT", 30)          # requests per IP per window
RATE_WINDOW = _int("RATE_WINDOW", 3600)      # seconds
CACHE_SIZE = _int("CACHE_SIZE", 256)
FETCH_TIMEOUT = _int("FETCH_TIMEOUT", 120)

def _resolve_ytdlp():
    """How to invoke yt-dlp, as an argv prefix.

    The console script is the obvious answer but not a dependable one off Docker: Render's
    native Python runtime installs the package into a virtualenv whose bin directory is not
    always on PATH for the process that ends up running this. Importing the module works
    wherever pip put it, so fall back to that rather than reporting yt-dlp missing when it is
    installed and merely unreachable by name.
    """
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    if importlib.util.find_spec("yt_dlp") is not None:
        return [sys.executable, "-m", "yt_dlp"]
    return None


YTDLP_CMD = _resolve_ytdlp()
YTDLP = YTDLP_CMD is not None          # kept as a boolean for the local entry point's check
VIDEO_ID = re.compile(r"^[\w-]{5,20}$")

_slots = threading.BoundedSemaphore(max(1, MAX_CONCURRENCY))
_cache = OrderedDict()
_cache_lock = threading.Lock()
_hits = defaultdict(deque)
_hits_lock = threading.Lock()


# ------------------------------------------------------------------ cookies

def _cookie_file():
    """Materialise cookies.txt from the environment, if provided.

    Hosts hand secrets over as single-line environment variables, but a Netscape cookie jar
    is inherently multi-line — hence the base64 variant, which is the one that survives every
    dashboard intact. yt-dlp rewrites this file as cookies refresh, so it has to be somewhere
    writable rather than baked into the image.
    """
    raw = os.environ.get("YTDLP_COOKIES_B64", "").strip()
    if raw:
        try:
            text = base64.b64decode(raw).decode("utf-8", "replace")
        except Exception:
            print("[helper] YTDLP_COOKIES_B64 is not valid base64 — ignoring", file=sys.stderr)
            return None
    else:
        text = os.environ.get("YTDLP_COOKIES", "").strip()
        if not text:
            return None
        text = text.replace("\\n", "\n")

    if "# Netscape HTTP Cookie File" not in text:
        text = "# Netscape HTTP Cookie File\n" + text

    path = os.path.join(tempfile.gettempdir(), "yt-cookies.txt")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text if text.endswith("\n") else text + "\n")
    os.chmod(path, 0o600)
    return path


COOKIE_FILE = _cookie_file()


# ------------------------------------------------------------------ parsing

def stamp(ms):
    total = int(ms // 1000)
    h, m, s = total // 3600, (total // 60) % 60, total % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def parse_json3(raw):
    data = json.loads(raw)
    out = []
    for event in data.get("events", []):
        text = "".join(seg.get("utf8", "") for seg in event.get("segs", []))
        text = " ".join(text.split())
        if text:
            out.append({"time": stamp(event.get("tStartMs", 0)), "text": text})
    return out


def parse_vtt(raw):
    """VTT repeats each line as the rolling caption scrolls, so drop consecutive repeats."""
    out = []
    time_re = re.compile(r"^(\d{2}):(\d{2}):(\d{2})\.\d{3}\s+-->")
    current = None
    for line in raw.splitlines():
        match = time_re.match(line.strip())
        if match:
            h, m, s = (int(x) for x in match.groups())
            current = (h * 3600 + m * 60 + s) * 1000
            continue
        text = re.sub(r"<[^>]+>", "", line).strip()
        if not text or text.startswith(("WEBVTT", "Kind:", "Language:")) or current is None:
            continue
        if out and out[-1]["text"] == text:
            continue
        out.append({"time": stamp(current), "text": text})
    return out


# ------------------------------------------------------------------ fetching

def _redact(text):
    """yt-dlp echoes the proxy URL (credentials included) and cookie path into its errors."""
    if PROXY:
        text = text.replace(PROXY, "<proxy>")
    if COOKIE_FILE:
        text = text.replace(COOKIE_FILE, "<cookies>")
    return text


def _ytdlp_command(template, url):
    cmd = YTDLP_CMD + [
        "--skip-download", "--write-subs", "--write-auto-subs",
        "--sub-langs", SUB_LANGS, "--sub-format", "json3/vtt/best",
        "--no-warnings", "--no-progress", "--output", template,
    ]
    if COOKIE_FILE:
        cmd += ["--cookies", COOKIE_FILE]
    if PROXY:
        cmd += ["--proxy", PROXY]
    if EXTRACTOR_ARGS:
        cmd += ["--extractor-args", EXTRACTOR_ARGS]
    cmd.append(url)
    return cmd


def fetch(video_id):
    if not YTDLP:
        return None, "yt-dlp is not installed"

    url = f"https://www.youtube.com/watch?v={video_id}"
    with tempfile.TemporaryDirectory() as tmp:
        template = os.path.join(tmp, "sub")
        try:
            proc = subprocess.run(_ytdlp_command(template, url),
                                  capture_output=True, text=True, timeout=FETCH_TIMEOUT)
        except subprocess.TimeoutExpired:
            return None, "yt-dlp timed out"

        files = sorted(os.listdir(tmp))
        if not files:
            detail = _redact(proc.stderr or proc.stdout or "").strip().splitlines()
            reason = detail[-1] if detail else "no subtitles available for this video"
            # The signature of a datacenter IP being turned away. Say so plainly, because the
            # fix is configuration (cookies or a proxy) rather than anything about the video.
            if "confirm you" in reason.lower() or "not a bot" in reason.lower():
                reason = ("YouTube is blocking this server as a bot — set YTDLP_COOKIES_B64 "
                          "or YTDLP_PROXY (see README)")
            return None, reason

        # Prefer manual captions over auto-generated, json3 over vtt.
        def rank(name):
            return (".json3" not in name, "auto" in name.lower())

        for name in sorted(files, key=rank):
            with open(os.path.join(tmp, name), encoding="utf-8", errors="replace") as handle:
                raw = handle.read()
            try:
                segments = parse_json3(raw) if name.endswith(".json3") else parse_vtt(raw)
            except (ValueError, json.JSONDecodeError):
                continue
            if segments:
                return segments, None

        return None, "subtitles downloaded but could not be parsed"


def fetch_cached(video_id):
    """A video's captions don't change, so a hit here saves an entire yt-dlp run."""
    with _cache_lock:
        if video_id in _cache:
            _cache.move_to_end(video_id)
            return _cache[video_id], None

    if not _slots.acquire(timeout=30):
        return None, "server busy — try again shortly"
    try:
        # Another thread may have populated the entry while this one waited for a slot.
        with _cache_lock:
            if video_id in _cache:
                _cache.move_to_end(video_id)
                return _cache[video_id], None
        segments, error = fetch(video_id)
    finally:
        _slots.release()

    if segments:
        with _cache_lock:
            _cache[video_id] = segments
            while len(_cache) > CACHE_SIZE:
                _cache.popitem(last=False)
    return segments, error


# ------------------------------------------------------------------ throttling

def rate_ok(ip):
    if RATE_LIMIT <= 0:
        return True
    now = time.time()
    with _hits_lock:
        window = _hits[ip]
        while window and now - window[0] > RATE_WINDOW:
            window.popleft()
        if not window and len(_hits) > 4096:
            _hits.clear()  # crude, but keeps a hostile caller from growing this without bound
        if len(window) >= RATE_LIMIT:
            return False
        window.append(now)
        return True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ytc-transcript/2.0"

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Helper-Token")
        # Required, and easy to miss: a POST carrying application/json is preflighted, and
        # Chrome rejects the preflight outright when the allowed methods are not stated. GET
        # is a simple request and works without this, so the omission only breaks POST.
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For", "")
        return forwarded.split(",")[0].strip() or self.client_address[0]

    def authorised(self, path, query):
        """Token may arrive in the path, a header, or a query param.

        The path form is what the extension actually uses: background.js builds requests as
        `helperUrl + '/transcript?v=...'`, so folding the token into the configured base URL
        authenticates every call without the extension knowing a token exists.
        """
        if not ACCESS_TOKEN:
            return True, path
        prefix = "/k/" + ACCESS_TOKEN
        if path == prefix or path.startswith(prefix + "/"):
            return True, path[len(prefix):] or "/"
        supplied = self.headers.get("X-Helper-Token", "") or (query.get("key") or [""])[0]
        if supplied and compare_digest(supplied, ACCESS_TOKEN):
            return True, path
        return False, path

    def do_OPTIONS(self):
        self._send(204, {})

    def do_POST(self):
        """POST carries the channel's own text, for channels not yet in the index.

        The extension is standing on the channel page and can already read its title,
        description and recent video titles. Sending those means an unknown channel still
        gets an answer — the server embeds what it was given rather than trying to fetch the
        channel itself, which from a datacenter IP would mostly be refused anyway.
        """
        route = urlparse(self.path)
        query = parse_qs(route.query)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        # Read the body before deciding anything, so every path below leaves the socket clean.
        # Returning early without reading it left those bytes in the buffer, where the next
        # request on the same keep-alive connection parsed them as its request line and got a
        # 501. It alternated 404, 501, 404 down a reused connection, and only showed up
        # through a proxy that pools connections — one curl per request hides it entirely.
        raw = self.rfile.read(length) if 0 < length <= 64000 else b""
        if 0 < length and length > 64000:
            # Oversized: drain it anyway rather than leaving a partial body behind.
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)

        ok, path = self.authorised(route.path, query)
        if not ok:
            self._send(404, {"ok": False, "reason": "not found"})
            return

        if length <= 0 or length > 64000:
            self._send(400, {"ok": False, "reason": "bad body"})
            return
        try:
            body = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            self._send(400, {"ok": False, "reason": "bad json"})
            return
        if not isinstance(body, dict):
            self._send(400, {"ok": False, "reason": "bad json"})
            return

        if path == "/similar":
            if not INDEX_READY:
                self._send(200, {"ok": False, "reason": "channel index not configured"})
                return
            handle = str(body.get("channel") or "").strip()
            if handle and not handle.startswith("@"):
                handle = "@" + handle
            if not handle:
                self._send(400, {"ok": False, "reason": "channel required"})
                return

            text = "\n".join(str(x) for x in [
                body.get("title") or "",
                (body.get("about") or "")[:800],
                " · ".join([str(t) for t in (body.get("videoTitles") or [])][:10]),
            ] if x)

            def as_int(name):
                try:
                    v = body.get(name)
                    return int(v) if v not in (None, "") else None
                except (TypeError, ValueError):
                    return None

            limit = as_int("limit") or 25

            # `or` treats 0.0 as absent, so a caller asking for no floor silently got the
            # default one — which made "show me everything" indistinguishable from "show me
            # good matches" while debugging an empty result.
            raw_floor = body.get("minSimilarity")
            try:
                floor = float(raw_floor) if raw_floor is not None else DEFAULT_FLOOR
            except (TypeError, ValueError):
                floor = DEFAULT_FLOOR

            # Channels the extension found by searching YouTube for this channel's own
            # topics, enriched before the match runs so they can be ranked in this answer
            # rather than the next one. The division of labour is the same as /ingest: the
            # extension scrapes search from a residential connection because a server doing it
            # gets the bot interstitial, and the server holds the keys to enrich and embed.
            # Failure is not fatal — an answer from the corpus alone is the previous
            # behaviour, which was never wrong, only narrow.
            candidates = body.get("candidates")
            if INGEST_READY and isinstance(candidates, list) and candidates:
                pairs = [{"id": str(p.get("id") or ""), "handle": str(p.get("handle") or "")}
                         for p in candidates if isinstance(p, dict)][:SIMILAR_CANDIDATES]
                try:
                    added = ingest_channels(pairs)
                    print("  /similar enriched %s candidates for %s (%s)"
                          % (len(pairs), handle, added.get("added")), flush=True)
                except Exception as exc:                       # noqa: BLE001
                    print("  /similar candidate ingest failed: %s" % exc, flush=True)

            result = similar_channels(
                handle, text, max(1, min(100, limit)),
                as_int("minSubs"), as_int("maxSubs"), max(0.0, min(1.0, floor)),
                channel_id=body.get("channelId") or None)
            # Growing the corpus is a side effect of being asked, never a precondition.
            record_sighting(body.get("channelId"), handle)
            self._send(200, result)
            return

        if path == "/run":
            preset = str(body.get("preset") or "drain")
            # A fixed menu, not free-form arguments: this endpoint runs a subprocess, and the
            # token is only as private as the extension package it ships in.
            presets = {
                "drain": ["--drain", "--graph", "--limit", "60"],
                "drain-wide": ["--drain", "--graph", "--limit", "150"],
                "queue-only": ["--drain", "--limit", "100"],
            }
            if preset not in presets:
                self._send(400, {"ok": False, "reason": "unknown preset"})
                return
            self._send(200, start_crawl(presets[preset]))
            return

        if path == "/videos":
            handle = str(body.get("channel") or "").strip()
            if handle and not handle.startswith("@"):
                handle = "@" + handle
            def _pos(name, default, high):
                try:
                    v = int(body.get(name) or default)
                except (TypeError, ValueError):
                    return default
                return max(1, min(v, high))
            # Asking for a period means asking for what that period holds. Defaulting to a
            # count here would silently cap a year at fifty videos, which is the exact bug
            # this parameter exists to fix.
            ceiling = VIDEO_PAGE * VIDEO_MAX_PAGES
            self._send(200, channel_videos(
                handle, str(body.get("channelId") or "") or None,
                want=_pos("want", ceiling if body.get("days") else 50, ceiling),
                days=(_pos("days", 0, 3650) if body.get("days") else None)))
            return

        if path == "/niche":
            if not INDEX_READY:
                self._send(200, {"ok": False, "reason": "channel index not configured"})
                return
            handle = str(body.get("channel") or "").strip()
            if handle and not handle.startswith("@"):
                handle = "@" + handle
            # The stored vector when the channel is indexed, which is the whole advantage of
            # having an index: it was built from the title, description and recent video
            # titles together, where a single video title is thin and often misleading.
            vector = None
            known = indexed_channel(handle) if handle else None
            if known:
                raw = known.get("embedding")
                if isinstance(raw, str):
                    try:
                        vector = json.loads(raw)
                    except ValueError:
                        vector = None
                elif isinstance(raw, list):
                    vector = raw
            if vector is None:
                text = "\n".join(str(x) for x in [
                    body.get("title") or "",
                    clean_description(body.get("about"))[:800],
                    " \u00b7 ".join([str(t) for t in (body.get("videoTitles") or [])][:10]),
                ] if x)
                if not text.strip():
                    self._send(200, {"ok": False, "reason": "nothing to classify"})
                    return
                vector = embed(text)
            out = niche_for(vector)
            if not out:
                self._send(200, {"ok": False, "reason": "could not classify"})
                return
            # Set before the refusal is returned as well: the caller needs to tell a channel
            # that does not fit any niche from one that simply is not in the index yet.
            out["indexed"] = bool(known)
            if not out.get("niche"):
                out["ok"] = False
                self._send(200, out)
                return
            out["ok"] = True
            self._send(200, out)
            return

        if path == "/keyword-seen":
            if not INDEX_READY:
                self._send(200, {"ok": False, "reason": "channel index not configured"})
                return
            self._send(200, track_keyword(str(body.get("keyword") or ""),
                                          body.get("videos") or []))
            return

        if path == "/keyword-series":
            if not INDEX_READY:
                self._send(200, {"ok": False, "reason": "channel index not configured"})
                return
            self._send(200, keyword_series(str(body.get("keyword") or ""),
                                           int(body.get("hours") or 168)))
            return

        # Driven by cron, not by the extension: one call takes a column of counts across
        # everything being followed. Sampling costs one quota unit per fifty videos.
        if path == "/sample":
            if not INDEX_READY:
                self._send(200, {"ok": False, "reason": "channel index not configured"})
                return
            self._send(200, sample_videos(limit=int(body.get("limit") or 500)))
            return

        if path == "/edges":
            if not INDEX_READY:
                self._send(200, {"ok": False, "reason": "channel index not configured"})
                return
            self._send(200, record_edges(str(body.get("source") or ""),
                                         body.get("targets") or [],
                                         body.get("videos") or [],
                                         str(body.get("sourceId") or "") or None))
            return

        if path == "/enrich":
            if not INGEST_READY:
                self._send(200, {"ok": False, "reason": "ingest not configured"})
                return
            # Returns as soon as the batch is running: a full batch is tens of minutes of
            # yt-dlp. Poll /health for the outcome.
            self._send(200, start_enrich(body.get("limit")))
            return

        if path == "/video-owners":
            ids = body.get("videos")
            if not isinstance(ids, list) or not ids:
                self._send(400, {"ok": False, "reason": "videos required"})
                return
            clean = [str(v) for v in ids if isinstance(v, (str, int))][:50]
            self._send(200, {"ok": True, "videos": video_owners(clean)})
            return

        if path == "/ingest":
            pairs = body.get("channels")
            if not isinstance(pairs, list) or not pairs:
                self._send(400, {"ok": False, "reason": "channels required"})
                return
            clean = [{"id": str(p.get("id") or ""), "handle": str(p.get("handle") or "")}
                     for p in pairs if isinstance(p, dict)][:50]
            self._send(200, ingest_channels(clean))
            return

        self._send(404, {"ok": False, "reason": "unknown route"})

    def do_GET(self):
        route = urlparse(self.path)
        query = parse_qs(route.query)

        # Liveness probe, deliberately outside the token check. A platform health check has
        # no way to hold the token, and with ACCESS_TOKEN set every other path answers 404 —
        # which reads as a failed deploy. This reveals nothing beyond "a server is here".
        if route.path == "/healthz":
            self._send(200, {"ok": True})
            return

        # Outside the token check, like the health probe. A policy that needs a secret to
        # read is not a published policy, and the store requires a URL anyone can open.
        if route.path in ("/privacy", "/privacy.html"):
            page = privacy_html()
            if page is None:
                print("  PRIVACY.md not found at any of %s" % PRIVACY_PATHS, flush=True)
                self._send(500, {"ok": False, "reason": "policy unavailable"})
                return
            raw = page.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        ok, path = self.authorised(route.path, query)
        if not ok:
            # 404 rather than 401: an unauthenticated scanner learns nothing about what is here.
            self._send(404, {"ok": False, "reason": "not found"})
            return

        if path == "/similar":
            if not INDEX_READY:
                self._send(200, {"ok": False, "reason": "channel index not configured"})
                return
            handle = (query.get("channel") or [""])[0].strip()
            if handle and not handle.startswith("@"):
                handle = "@" + handle
            if not handle:
                self._send(400, {"ok": False, "reason": "channel required"})
                return
            self._send(200, similar_channels(
                handle, "",
                _clamp(query, "limit", 25, 1, 100),
                _opt_int(query, "min_subs"),
                _opt_int(query, "max_subs"),
                _clamp_float(query, "min_similarity", DEFAULT_FLOOR, 0.0, 1.0)))
            return

        if path == "/stats":
            out = index_stats()
            out["crawl_running"] = CRAWL_STATE["running"]
            out["crawl_last"] = CRAWL_STATE["last"]
            self._send(200, out)
            return

        if path == "/dashboard":
            page = DASHBOARD_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(page)
            return

        if path == "/health":
            version = ""
            if YTDLP:
                try:
                    version = subprocess.run(YTDLP_CMD + ["--version"], capture_output=True,
                                             text=True, timeout=30).stdout.strip()
                except Exception:
                    version = "unknown"
            enrich = {"running": ENRICH_STATE["running"], "last": ENRICH_STATE["last"]}
            self._send(200, {"ok": bool(YTDLP), "ytdlp": version, "enrich": enrich,
                             "cookies": bool(COOKIE_FILE), "proxy": bool(PROXY)})
            return

        if path == "/":
            self._send(200, {"ok": True, "service": "yt-copy transcript helper"})
            return

        if path != "/transcript":
            self._send(404, {"ok": False, "reason": "unknown route"})
            return

        video_id = (query.get("v") or [""])[0]
        if not VIDEO_ID.match(video_id):
            self._send(400, {"ok": False, "reason": "bad video id"})
            return

        if not rate_ok(self.client_ip()):
            self._send(429, {"ok": False, "reason": "rate limited — try again later"})
            return

        segments, error = fetch_cached(video_id)
        if error:
            self._send(200, {"ok": False, "reason": error})
        else:
            self._send(200, {"ok": True, "segments": segments})

    def log_message(self, fmt, *args):
        sys.stderr.write("[helper] %s\n" % (fmt % args))


class QuietServer(ThreadingHTTPServer):
    """A client hanging up mid-request is normal here, not an error worth a traceback.

    The extension posts discoveries to /ingest fire-and-forget and drops the connection
    immediately, which is deliberate — filling the index must never delay the answer the user
    asked for. The default server treats that as an unhandled exception and prints a full
    stack trace for every one, burying anything that actually matters.
    """

    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main():
    """Report what this process can actually do, not what it was originally for.

    The banner used to announce a transcript service and its yt-dlp cookie and proxy
    settings. Transcripts moved into the extension and were deprecated; this is the channel
    index backend now, and the yt-dlp flags say nothing about whether it will work. What
    matters is which keys are present, because a missing one surfaces much later as
    "ingest not configured" with nothing pointing at the cause.
    """
    shown = "/k/<token>" if ACCESS_TOKEN else ""
    print(f"YouTube Toolkit service on http://{HOST}:{PORT}{shown}")
    print(f"  similar   {'ready' if INDEX_READY else 'OFF — needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY'}")
    print(f"  embedding {'ready' if OPENAI_KEY else 'OFF — needs OPENAI_API_KEY (unindexed channels cannot be matched)'}")
    print(f"  ingest    {'ready' if INGEST_READY else 'OFF — needs YOUTUBE_API_KEY (the index will not fill itself)'}")
    if YTDLP:
        print(f"  transcripts (deprecated) available"
              f"  cookies={'yes' if COOKIE_FILE else 'no'} proxy={'yes' if PROXY else 'no'}")
    QuietServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
