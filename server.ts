import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import {
  translateFixturesToArabic,
  translateLeaguesToArabic,
  translateTermSync,
  translateTermsMap,
  type WikiLookupItem,
} from './server/arabicSportsTranslator.ts';
import {
  normalizeMatchEvents,
  normalizeMatchLineups,
  normalizeMatchStatistics,
  normalizeSquadPlayers,
  normalizeStandings,
  normalizeTeamStatistics,
  normalizeTopScorers,
} from './server/goalApiNormalizers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const GOAL_API_BASE = (
  process.env.GOAL_API_BASE_URL || 'https://api.goal-api.com/v1'
).replace(/\/+$/, '');

interface NormalizedGoalMatch {
  id: string;
  leagueId: string;
  leagueName: string;
  leagueCountry: string;
  leagueLogo: string;
  round: string;
  kickoffIso: string;
  kickoffTime: string;
  matchDateFormatted: string;
  status: 'LIVE' | 'SCHEDULED' | 'FINISHED' | 'POSTPONED';
  statusLabelAr: string;
  minute?: number | null;
  homeTeam: string;
  homeTeamId?: string;
  homeLogo: string;
  homeScore?: number | null;
  homeHalftimeScore?: number | null;
  awayTeam: string;
  awayTeamId?: string;
  awayLogo: string;
  awayScore?: number | null;
  awayHalftimeScore?: number | null;
  venue?: string;
  referee?: string;
}

function mapStatus(
  rawStatus: unknown,
  minute?: number | null,
  minuteText?: string
): {
  status: NormalizedGoalMatch['status'];
  label: string;
} {
  const s = String(rawStatus || '').toUpperCase();
  if (
    s.includes('LIVE') ||
    s.includes('IN_PLAY') ||
    s === '1H' ||
    s === '2H' ||
    s === 'HT' ||
    s === 'HALF_TIME' ||
    s === 'ET'
  ) {
    if (s === 'HT' || s === 'HALF_TIME') return { status: 'LIVE', label: 'استراحة' };
    if (minuteText && /^\d+(\+\d+)?$/.test(minuteText.trim())) {
      return { status: 'LIVE', label: `مباشر ${minuteText.trim()}'` };
    }
    return {
      status: 'LIVE',
      label: typeof minute === 'number' && minute > 0 ? `مباشر ${minute}'` : 'مباشر الآن',
    };
  }
  if (
    s.includes('FINISH') ||
    s === 'FT' ||
    s === 'AET' ||
    s === 'AFTER_ET' ||
    s === 'PEN' ||
    s === 'AFTER_PEN' ||
    s === 'AWARDED'
  ) {
    return { status: 'FINISHED', label: 'انتهت' };
  }
  if (
    s.includes('POSTPON') ||
    s.includes('CANCEL') ||
    s.includes('SUSPENDED') ||
    s.includes('ABANDONED')
  ) {
    return { status: 'POSTPONED', label: 'مؤجلة' };
  }
  return { status: 'SCHEDULED', label: 'لم تبدأ' };
}

function formatKickoffParts(isoValue: unknown): {
  kickoffTime: string;
  matchDateFormatted: string;
} {
  const str = String(isoValue || '');
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) {
    return { kickoffTime: '--:--', matchDateFormatted: '' };
  }
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  let formattedDate = '';
  try {
    formattedDate = new Intl.DateTimeFormat('ar-EG', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d);
  } catch {
    formattedDate = str.slice(0, 10);
  }
  return { kickoffTime: `${hh}:${mm}`, matchDateFormatted: formattedDate };
}

function normalizeFixtureRecord(item: Record<string, unknown>, idx: number): NormalizedGoalMatch {
  const homeObj = (item.homeTeam ||
    (item.teams as Record<string, unknown> | undefined)?.home ||
    item.home ||
    {}) as Record<string, unknown>;
  const awayObj = (item.awayTeam ||
    (item.teams as Record<string, unknown> | undefined)?.away ||
    item.away ||
    {}) as Record<string, unknown>;
  const leagueObj = (item.league || item.competition || {}) as Record<string, unknown>;
  const scoreObj = (item.score || item.goals || {}) as Record<string, unknown>;
  const fullTimeObj = (scoreObj.fullTime || scoreObj.current || scoreObj) as Record<
    string,
    unknown
  >;

  const rawDate =
    item.kickoffUtc ||
    item.utcDate ||
    item.startTime ||
    item.date ||
    (item.matchDate && item.matchTime
      ? `${item.matchDate}T${item.matchTime}:00Z`
      : item.matchDate) ||
    (item.match_date && item.match_time
      ? `${item.match_date}T${item.match_time}:00Z`
      : item.match_date) ||
    '';
  const { kickoffTime: parsedTime, matchDateFormatted } = formatKickoffParts(rawDate);
  const kickoffTime =
    parsedTime !== '--:--'
      ? parsedTime
      : typeof item.matchTime === 'string' && item.matchTime
      ? item.matchTime
      : typeof item.match_time === 'string' && item.match_time
      ? item.match_time
      : '--:--';

  const rawMinuteText = String(item.matchMinute || item.match_status || '').trim();
  const rawElapsed = item.matchElapsed ?? item.minute ?? item.elapsed ?? item.matchMinute;
  const minuteVal =
    typeof rawElapsed === 'number' && Number.isFinite(rawElapsed)
      ? rawElapsed
      : typeof rawElapsed === 'string' && /^\d+$/.test(rawElapsed.trim())
      ? Number(rawElapsed.trim())
      : null;

  const periodStr = String(item.matchPeriod || '').toUpperCase();
  const rawStatus = String(item.matchStatus || item.match_status || item.status || '').toUpperCase();
  const effectiveStatus =
    rawStatus ||
    (periodStr === 'FIRST_HALF' ||
    periodStr === 'SECOND_HALF' ||
    periodStr === 'EXTRA_TIME' ||
    periodStr === 'PENALTIES' ||
    periodStr === 'HALF_TIME'
      ? 'LIVE'
      : periodStr === 'FINISHED'
      ? 'FINISHED'
      : '');

  const { status, label } =
    periodStr === 'HALF_TIME' || periodStr === 'HALFTIME' || periodStr === 'HT'
      ? { status: 'LIVE' as const, label: 'استراحة' }
      : mapStatus(effectiveStatus, minuteVal, rawMinuteText);

  const parseScore = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
    return null;
  };

  const homeScore =
    parseScore(item.homeTeamScore) ??
    parseScore(item.match_hometeam_score) ??
    parseScore(item.homeScore) ??
    parseScore(fullTimeObj.home) ??
    parseScore(scoreObj.home);
  const awayScore =
    parseScore(item.awayTeamScore) ??
    parseScore(item.match_awayteam_score) ??
    parseScore(item.awayScore) ??
    parseScore(fullTimeObj.away) ??
    parseScore(scoreObj.away);
  const homeHalftimeScore = parseScore(
    item.homeTeamHalftimeScore ?? item.match_hometeam_halftime_score ?? item.homeHalftimeScore
  );
  const awayHalftimeScore = parseScore(
    item.awayTeamHalftimeScore ?? item.match_awayteam_halftime_score ?? item.awayHalftimeScore
  );

  const venueObj = (item.venue && typeof item.venue === 'object' ? item.venue : {}) as Record<string, unknown>;
  const venue = String(
    item.matchStadium ||
      item.stadiumName ||
      item.venueName ||
      venueObj.name ||
      (typeof item.venue === 'string' ? item.venue : '') ||
      ''
  ).trim();
  const referee = String(item.matchReferee || item.refereeName || item.referee || '').trim();

  return {
    id: String(item.id || item.match_id || item.fixtureId || `goalapi-${idx}`),
    leagueId: String(leagueObj.id || item.leagueId || item.league_id || 'league'),
    leagueName: String(
      leagueObj.name || item.leagueName || item.league_name || 'بطولة كرة قدم'
    ),
    leagueCountry: String(item.countryName || item.country_name || leagueObj.country || ''),
    leagueLogo: String(item.leagueLogo || item.league_logo || leagueObj.logo || leagueObj.flag || ''),
    round: String(
      item.matchRound || item.stageName || leagueObj.round || item.round || 'مباراة رسمية'
    ),
    kickoffIso: String(rawDate),
    kickoffTime,
    matchDateFormatted,
    status,
    statusLabelAr: label,
    minute: minuteVal,
    homeTeam: String(item.homeTeamName || item.match_hometeam_name || homeObj.name || 'الفريق المضيف'),
    homeTeamId: String(item.homeTeamId || item.match_hometeam_id || homeObj.id || '') || undefined,
    homeLogo: String(
      item.teamHomeBadge || item.team_home_badge || homeObj.badge || homeObj.logo || homeObj.crest || ''
    ),
    homeScore,
    homeHalftimeScore,
    awayTeam: String(item.awayTeamName || item.match_awayteam_name || awayObj.name || 'الفريق الضيف'),
    awayTeamId: String(item.awayTeamId || item.match_awayteam_id || awayObj.id || '') || undefined,
    awayLogo: String(
      item.teamAwayBadge || item.team_away_badge || awayObj.badge || awayObj.logo || awayObj.crest || ''
    ),
    awayScore,
    awayHalftimeScore,
    venue: venue || undefined,
    referee: referee || undefined,
  };
}

interface NormalizedGoalLeague {
  id: string;
  name: string;
  nameEn?: string;
  country: string;
  countryEn?: string;
  logo: string;
  type: string;
  isActive: boolean;
}

function extractArrayFromPayload(rawBody: unknown): unknown[] {
  if (Array.isArray(rawBody)) return rawBody;
  if (rawBody && typeof rawBody === 'object') {
    const obj = rawBody as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data;
    if (obj.data && typeof obj.data === 'object') {
      const inner = obj.data as Record<string, unknown>;
      if (Array.isArray(inner.matches)) return inner.matches;
      if (Array.isArray(inner.fixtures)) return inner.fixtures;
      if (Array.isArray(inner.leagues)) return inner.leagues;
    }
    if (Array.isArray(obj.leagues)) return obj.leagues;
    if (Array.isArray(obj.competitions)) return obj.competitions;
    if (Array.isArray(obj.fixtures)) return obj.fixtures;
    if (Array.isArray(obj.matches)) return obj.matches;
    if (Array.isArray(obj.response)) return obj.response;
  }
  return [];
}

function hasMorePages(rawBody: unknown, currentCount: number, limit: number): boolean {
  if (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)) {
    const obj = rawBody as Record<string, unknown>;
    const pagination = (obj.pagination || obj.meta || {}) as Record<string, unknown>;
    if (typeof pagination.hasMore === 'boolean') return pagination.hasMore;
    if (typeof pagination.hasNextPage === 'boolean') return pagination.hasNextPage;
    if (typeof pagination.total === 'number' && typeof pagination.offset === 'number') {
      return pagination.offset + currentCount < pagination.total;
    }
  }
  return currentCount >= limit;
}

function normalizeLeagueRecord(item: Record<string, unknown>, idx: number): NormalizedGoalLeague {
  const countryObj =
    item.country && typeof item.country === 'object'
      ? (item.country as Record<string, unknown>)
      : {};
  const id = String(item.id || item.leagueId || item.competitionId || `league-${idx}`);
  const name = String(item.name || item.leagueName || item.title || 'بطولة كرة قدم');
  const country = String(
    item.countryName ||
      countryObj.name ||
      (typeof item.country === 'string' ? item.country : '') ||
      'دولي'
  );
  const logo = String(
    item.logo ||
      item.leagueLogo ||
      item.badge ||
      item.emblem ||
      countryObj.flag ||
      ''
  );
  const type = String(item.type || item.leagueType || 'League');
  const isActive =
    typeof item.isActive === 'boolean'
      ? item.isActive
      : typeof item.active === 'boolean'
      ? item.active
      : true;

  return { id, name, country, logo, type, isActive };
}

let leaguesCache: { fetchedAt: number; leagues: NormalizedGoalLeague[] } | null = null;
const LEAGUES_CACHE_TTL_MS = 30 * 60 * 1000;

async function createAppServer() {
  const app = express();
  app.use(express.json());

  // GoalAPI.com Proxy: Fetch ALL supported leagues & tournaments
  app.get('/api/goalapi/leagues', async (_req, res) => {
    const apiKey = process.env.GOAL_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        ok: false,
        code: 'MISSING_API_KEY',
        message:
          'مفتاح GOAL_API_KEY غير مُضاف بعد. أضف مفتاح Goalapi.com في إعدادات الأسرار (Secrets) لجلب الدوريات والبطولات.',
      });
      return;
    }

    if (leaguesCache && Date.now() - leaguesCache.fetchedAt < LEAGUES_CACHE_TTL_MS) {
      res.json({
        ok: true,
        source: 'goal-api.com',
        cached: true,
        count: leaguesCache.leagues.length,
        leagues: leaguesCache.leagues,
      });
      return;
    }

    try {
      const PAGE_LIMIT = 100;
      const MAX_PAGES = 25;
      const collected: Record<string, unknown>[] = [];
      let offset = 0;

      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `${GOAL_API_BASE}/leagues?limit=${PAGE_LIMIT}&offset=${offset}`;
        const upstream = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        });

        const contentType = upstream.headers.get('content-type') || '';
        const rawBody = contentType.includes('application/json')
          ? await upstream.json()
          : await upstream.text();

        if (!upstream.ok) {
          if (collected.length > 0) break;
          const errObj =
            typeof rawBody === 'object' && rawBody
              ? (rawBody as Record<string, unknown>)
              : null;
          const errDetail =
            errObj?.message ||
            (errObj?.error as Record<string, unknown> | undefined)?.message ||
            (typeof rawBody === 'string' ? rawBody.slice(0, 180) : '');
          res.status(upstream.status).json({
            ok: false,
            code: 'UPSTREAM_ERROR',
            status: upstream.status,
            message: errDetail
              ? String(errDetail)
              : `تعذر جلب الدوريات من Goalapi.com (رمز ${upstream.status})`,
          });
          return;
        }

        const pageItems = extractArrayFromPayload(rawBody).filter(
          (x): x is Record<string, unknown> => Boolean(x && typeof x === 'object')
        );
        if (pageItems.length === 0) break;

        collected.push(...pageItems);

        if (!hasMorePages(rawBody, pageItems.length, PAGE_LIMIT)) {
          break;
        }
        offset += pageItems.length;
      }

      // Deduplicate by league id
      const dedupedMap = new Map<string, NormalizedGoalLeague>();
      collected.forEach((item, idx) => {
        const norm = normalizeLeagueRecord(item, idx);
        if (!dedupedMap.has(norm.id)) {
          dedupedMap.set(norm.id, norm);
        }
      });

      const translatedLeagues = await translateLeaguesToArabic(
        Array.from(dedupedMap.values())
      );

      leaguesCache = {
        fetchedAt: Date.now(),
        leagues: translatedLeagues,
      };

      res.json({
        ok: true,
        source: 'goal-api.com',
        cached: false,
        count: translatedLeagues.length,
        leagues: translatedLeagues,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        code: 'NETWORK_ERROR',
        message:
          err instanceof Error
            ? `تعذر الاتصال بخادم Goalapi.com: ${err.message}`
            : 'تعذر الاتصال بخادم Goalapi.com',
      });
    }
  });

  // GoalAPI.com Proxy: Fetch real matches (live, by date, or by leagueId)
  app.get('/api/goalapi/fixtures', async (req, res) => {
    const apiKey = process.env.GOAL_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        ok: false,
        code: 'MISSING_API_KEY',
        message:
          'مفتاح GOAL_API_KEY غير مُضاف بعد. أضف مفتاح Goalapi.com في إعدادات الأسرار (Secrets) لجلب المباريات الحقيقية.',
      });
      return;
    }

    const mode = String(req.query.mode || 'date');
    const dateParam = String(
      req.query.date || new Date().toISOString().slice(0, 10)
    );
    const leagueIdParam = String(req.query.leagueId || '').trim();

    const buildUrl = (offset = 0) => {
      if (mode === 'live') {
        return `${GOAL_API_BASE}/fixtures/live`;
      }
      if (mode === 'league' && leagueIdParam) {
        return `${GOAL_API_BASE}/fixtures?leagueId=${encodeURIComponent(leagueIdParam)}&limit=100&offset=${offset}`;
      }
      return `${GOAL_API_BASE}/fixtures?from=${encodeURIComponent(dateParam)}&to=${encodeURIComponent(dateParam)}&limit=100&offset=${offset}`;
    };

    try {
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const upstream = await fetch(buildUrl(0), { method: 'GET', headers });
      const contentType = upstream.headers.get('content-type') || '';
      const rawBody = contentType.includes('application/json')
        ? await upstream.json()
        : await upstream.text();

      if (!upstream.ok) {
        res.status(upstream.status).json({
          ok: false,
          code: 'UPSTREAM_ERROR',
          status: upstream.status,
          message:
            typeof rawBody === 'object' && rawBody && 'message' in rawBody
              ? String((rawBody as Record<string, unknown>).message)
              : `تعذر جلب البيانات من Goalapi.com (رمز ${upstream.status})`,
        });
        return;
      }

      let rawList = extractArrayFromPayload(rawBody);

      // Fetch up to 2 extra pages in parallel on busy matchdays
      if (mode !== 'live' && hasMorePages(rawBody, rawList.length, 100)) {
        const extraResponses = await Promise.allSettled([
          fetch(buildUrl(100), { method: 'GET', headers }).then((r) =>
            r.ok ? r.json() : null
          ),
          fetch(buildUrl(200), { method: 'GET', headers }).then((r) =>
            r.ok ? r.json() : null
          ),
        ]);
        for (const result of extraResponses) {
          if (result.status === 'fulfilled' && result.value) {
            rawList = rawList.concat(extractArrayFromPayload(result.value));
          }
        }
      }

      const seenIds = new Set<string>();
      const rawMatches = rawList
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map((item, idx) => normalizeFixtureRecord(item, idx))
        .filter((m) => {
          if (seenIds.has(m.id)) return false;
          seenIds.add(m.id);
          return true;
        });

      const matches = await translateFixturesToArabic(rawMatches);

      res.json({
        ok: true,
        source: 'goal-api.com',
        mode,
        date: dateParam,
        leagueId: leagueIdParam || undefined,
        count: matches.length,
        matches,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        code: 'NETWORK_ERROR',
        message:
          err instanceof Error
            ? `تعذر الاتصال بخادم Goalapi.com: ${err.message}`
            : 'تعذر الاتصال بخادم Goalapi.com',
      });
    }
  });

  async function fetchGoalJson(endpointPath: string, apiKey: string): Promise<unknown | null> {
    try {
      const res = await fetch(`${GOAL_API_BASE}${endpointPath}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // GoalAPI.com Proxy: Full Match Center (Fixture + Events + Statistics + Lineups + H2H)
  app.get('/api/goalapi/match/:fixtureId', async (req, res) => {
    const apiKey = process.env.GOAL_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        ok: false,
        code: 'MISSING_API_KEY',
        message: 'مفتاح GOAL_API_KEY غير مُضاف.',
      });
      return;
    }

    const fixtureId = encodeURIComponent(req.params.fixtureId);
    const queryHomeId = String(req.query.homeTeamId || '').trim();
    const queryAwayId = String(req.query.awayTeamId || '').trim();

    try {
      const [fixtureRaw, eventsRaw, statsRaw, lineupsRaw] = await Promise.all([
        fetchGoalJson(`/fixtures/${fixtureId}`, apiKey),
        fetchGoalJson(`/fixtures/${fixtureId}/events`, apiKey),
        fetchGoalJson(`/fixtures/${fixtureId}/statistics`, apiKey),
        fetchGoalJson(`/fixtures/${fixtureId}/lineups`, apiKey),
      ]);

      const fixtureData =
        fixtureRaw && typeof fixtureRaw === 'object'
          ? ((fixtureRaw as Record<string, unknown>).data ?? fixtureRaw)
          : null;

      if (!fixtureData || typeof fixtureData !== 'object') {
        res.status(404).json({
          ok: false,
          code: 'NOT_FOUND',
          message: 'لم يتم العثور على تفاصيل هذه المباراة.',
        });
        return;
      }

      const rawFixtureObj = fixtureData as Record<string, unknown>;
      const baseNormalized = normalizeFixtureRecord(rawFixtureObj, 0);
      const homeId = baseNormalized.homeTeamId || queryHomeId;
      const awayId = baseNormalized.awayTeamId || queryAwayId;

      // Fetch H2H if both team IDs are present and distinct
      let h2hRaw: unknown = null;
      let h2hStatsRaw: unknown = null;
      if (homeId && awayId && homeId !== awayId) {
        [h2hRaw, h2hStatsRaw] = await Promise.all([
          fetchGoalJson(`/h2h/${encodeURIComponent(homeId)}/${encodeURIComponent(awayId)}/direct?limit=10`, apiKey),
          fetchGoalJson(`/h2h/${encodeURIComponent(homeId)}/${encodeURIComponent(awayId)}/stats`, apiKey),
        ]);
        if (!h2hRaw) {
          h2hRaw = await fetchGoalJson(`/h2h/${encodeURIComponent(homeId)}/${encodeURIComponent(awayId)}`, apiKey);
        }
      }

      const [translatedFixture] = await translateFixturesToArabic([baseNormalized]);
      const events = normalizeMatchEvents(eventsRaw, rawFixtureObj, homeId, baseNormalized.homeTeam);
      const statistics = normalizeMatchStatistics(statsRaw);
      const lineups = normalizeMatchLineups(
        lineupsRaw,
        String(rawFixtureObj.homeTeamSystem || ''),
        String(rawFixtureObj.awayTeamSystem || '')
      );

      // Process H2H matches
      const h2hRecentRaw = extractArrayFromPayload(h2hRaw)
        .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
        .map((x, idx) => normalizeFixtureRecord(x, idx));
      const h2hRecent = await translateFixturesToArabic(h2hRecentRaw);

      // Compute or parse H2H stats (GoalAPI returns { data: { teams: { team1, team2 }, headToHead: { totalMatches, team1Wins, draws, team2Wins, team1Goals, team2Goals } } })
      const statsDataObj =
        h2hStatsRaw && typeof h2hStatsRaw === 'object'
          ? ((h2hStatsRaw as Record<string, unknown>).data ?? h2hStatsRaw)
          : null;
      let homeWins = 0;
      let awayWins = 0;
      let draws = 0;
      let homeGoals = 0;
      let awayGoals = 0;

      if (statsDataObj && typeof statsDataObj === 'object' && !Array.isArray(statsDataObj)) {
        const sRoot = statsDataObj as Record<string, unknown>;
        const h2hHead = (sRoot.headToHead && typeof sRoot.headToHead === 'object' ? sRoot.headToHead : sRoot) as Record<string, unknown>;
        const teamsObj = (sRoot.teams && typeof sRoot.teams === 'object' ? sRoot.teams : {}) as Record<string, unknown>;
        const team1Obj = (teamsObj.team1 && typeof teamsObj.team1 === 'object' ? teamsObj.team1 : {}) as Record<string, unknown>;
        const team1IsHome = !homeId || !team1Obj.id || String(team1Obj.id) === homeId;

        const t1Wins = Number(h2hHead.team1Wins ?? h2hHead.homeWins ?? 0) || 0;
        const t2Wins = Number(h2hHead.team2Wins ?? h2hHead.awayWins ?? 0) || 0;
        const t1Goals = Number(h2hHead.team1Goals ?? h2hHead.homeGoals ?? 0) || 0;
        const t2Goals = Number(h2hHead.team2Goals ?? h2hHead.awayGoals ?? 0) || 0;

        homeWins = team1IsHome ? t1Wins : t2Wins;
        awayWins = team1IsHome ? t2Wins : t1Wins;
        homeGoals = team1IsHome ? t1Goals : t2Goals;
        awayGoals = team1IsHome ? t2Goals : t1Goals;
        draws = Number(h2hHead.draws ?? 0) || 0;
      }

      if (homeWins === 0 && awayWins === 0 && draws === 0 && h2hRecent.length > 0) {
        const normName = (s: string) => s.toLowerCase().replace(/\butd\b/g, 'united').replace(/\bfc\b/g, '').trim();
        const targetHomeNorm = normName(baseNormalized.homeTeam);
        for (const m of h2hRecent) {
          if (typeof m.homeScore !== 'number' || typeof m.awayScore !== 'number') continue;
          const isTargetHome =
            (homeId && m.homeTeamId === homeId) ||
            (m.homeTeamEn && normName(m.homeTeamEn) === targetHomeNorm);
          const gHome = isTargetHome ? m.homeScore : m.awayScore;
          const gAway = isTargetHome ? m.awayScore : m.homeScore;
          homeGoals += gHome;
          awayGoals += gAway;
          if (gHome > gAway) homeWins += 1;
          else if (gAway > gHome) awayWins += 1;
          else draws += 1;
        }
      }

      const h2hTotal = homeWins + draws + awayWins || h2hRecent.length;

      // Batch-translate player, coach, venue & referee names in events and lineups
      const namesToTranslate: WikiLookupItem[] = [];
      for (const ev of events) {
        namesToTranslate.push({ term: ev.playerName, kind: 'player' });
        if (ev.assistOrOutName) namesToTranslate.push({ term: ev.assistOrOutName, kind: 'player' });
      }
      if (lineups) {
        for (const side of [lineups.home, lineups.away]) {
          if (side.coach) namesToTranslate.push({ term: side.coach, kind: 'player' });
          for (const p of [...side.starting, ...side.substitutes]) {
            namesToTranslate.push({ term: p.name, kind: 'player' });
          }
        }
      }
      if (translatedFixture.venue) namesToTranslate.push({ term: translatedFixture.venue, kind: 'venue' });
      if (translatedFixture.referee) namesToTranslate.push({ term: translatedFixture.referee, kind: 'player' });

      const translatedMap = await translateTermsMap(namesToTranslate, 150);
      const t = (val?: string) => (val ? translatedMap.get(val.trim()) || translateTermSync(val) : val);

      for (const ev of events) {
        ev.playerName = t(ev.playerName) || ev.playerName;
        if (ev.assistOrOutName) ev.assistOrOutName = t(ev.assistOrOutName);
      }
      if (lineups) {
        for (const side of [lineups.home, lineups.away]) {
          if (side.coach) side.coach = t(side.coach) || side.coach;
          for (const p of [...side.starting, ...side.substitutes]) {
            p.name = t(p.name) || p.name;
          }
        }
      }
      if (translatedFixture.venue) translatedFixture.venue = t(translatedFixture.venue);
      if (translatedFixture.referee) translatedFixture.referee = t(translatedFixture.referee);

      res.json({
        ok: true,
        matchCenter: {
          fixture: translatedFixture,
          events,
          statistics,
          lineups,
          h2h:
            h2hTotal > 0 || h2hRecent.length > 0
              ? {
                  totalMatches: h2hTotal,
                  homeWins,
                  draws,
                  awayWins,
                  homeGoals,
                  awayGoals,
                  recentMatches: h2hRecent,
                }
              : null,
        },
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        code: 'NETWORK_ERROR',
        message:
          err instanceof Error ? `تعذر جلب مركز المباراة: ${err.message}` : 'تعذر جلب مركز المباراة.',
      });
    }
  });

  // GoalAPI.com Proxy: Full League Center (Info + Standings + Top Scorers + Fixtures + Results)
  app.get('/api/goalapi/league/:leagueId', async (req, res) => {
    const apiKey = process.env.GOAL_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        ok: false,
        code: 'MISSING_API_KEY',
        message: 'مفتاح GOAL_API_KEY غير مُضاف.',
      });
      return;
    }

    const leagueId = encodeURIComponent(req.params.leagueId);

    try {
      const [leagueRaw, standingsRaw, scorersRaw, fixturesRaw, resultsRaw] = await Promise.all([
        fetchGoalJson(`/leagues/${leagueId}`, apiKey),
        fetchGoalJson(`/standings/${leagueId}`, apiKey),
        fetchGoalJson(`/leagues/${leagueId}/top-scorers?limit=30`, apiKey),
        fetchGoalJson(`/leagues/${leagueId}/fixtures?limit=100`, apiKey),
        fetchGoalJson(`/results/league/${leagueId}?limit=40`, apiKey),
      ]);

      const leagueData =
        leagueRaw && typeof leagueRaw === 'object'
          ? ((leagueRaw as Record<string, unknown>).data ?? leagueRaw)
          : {};
      const normLeague = normalizeLeagueRecord(
        (leagueData && typeof leagueData === 'object' ? leagueData : {}) as Record<string, unknown>,
        0
      );
      if (!normLeague.id || normLeague.id === 'league-0') {
        normLeague.id = req.params.leagueId;
      }

      const [translatedLeague] = await translateLeaguesToArabic([normLeague]);
      const standings = normalizeStandings(standingsRaw);
      const topScorers = normalizeTopScorers(scorersRaw);

      // Enrich topScorers with teamLogo & teamId from standings when absent
      const teamLookup = new Map<string, { id: string; logo: string }>();
      for (const row of standings) {
        if (row.teamName) {
          const clean = row.teamName.toLowerCase().replace(/\bfc\b/g, '').trim();
          teamLookup.set(row.teamName.toLowerCase(), { id: row.teamId, logo: row.teamLogo });
          teamLookup.set(clean, { id: row.teamId, logo: row.teamLogo });
        }
      }
      for (const sc of topScorers) {
        if (!sc.teamLogo && sc.teamName) {
          const clean = sc.teamName.toLowerCase().replace(/\bfc\b/g, '').trim();
          const found = teamLookup.get(sc.teamName.toLowerCase()) || teamLookup.get(clean);
          if (found) {
            if (!sc.teamLogo) sc.teamLogo = found.logo;
            if (!sc.teamId) sc.teamId = found.id;
          }
        }
      }

      const rawFixtures = extractArrayFromPayload(fixturesRaw)
        .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
        .map((x, idx) => normalizeFixtureRecord(x, idx));

      const rawResults = extractArrayFromPayload(resultsRaw)
        .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
        .map((x, idx) => normalizeFixtureRecord(x, idx));

      const [fixtures, results] = await Promise.all([
        translateFixturesToArabic(rawFixtures),
        translateFixturesToArabic(rawResults),
      ]);

      // Batch-translate team & player names in standings and top scorers using Wikipedia
      const termsToTranslate: WikiLookupItem[] = [];
      for (const row of standings) {
        termsToTranslate.push({ term: row.teamName, kind: 'team', countryHint: normLeague.country });
        if (row.groupName) termsToTranslate.push({ term: row.groupName, kind: 'other' });
      }
      for (const sc of topScorers) {
        termsToTranslate.push({ term: sc.playerName, kind: 'player' });
        if (sc.teamName) termsToTranslate.push({ term: sc.teamName, kind: 'team', countryHint: normLeague.country });
      }
      const termMap = await translateTermsMap(termsToTranslate, 150);
      const t = (val?: string) => (val ? termMap.get(val.trim()) || translateTermSync(val) : '');

      for (const row of standings) {
        row.teamName = t(row.teamName) || row.teamName;
        if (row.groupName) row.groupName = t(row.groupName) || row.groupName;
      }
      for (const sc of topScorers) {
        sc.playerName = t(sc.playerName) || sc.playerName;
        if (sc.teamName) sc.teamName = t(sc.teamName) || sc.teamName;
      }

      res.json({
        ok: true,
        leagueCenter: {
          league: translatedLeague,
          standings,
          topScorers,
          fixtures,
          results,
        },
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        code: 'NETWORK_ERROR',
        message:
          err instanceof Error ? `تعذر جلب مركز البطولة: ${err.message}` : 'تعذر جلب مركز البطولة.',
      });
    }
  });

  // GoalAPI.com Proxy: Team Profile & Stats (Info + Season Stats + Recent Results + Upcoming + Squad)
  app.get('/api/goalapi/team/:teamId', async (req, res) => {
    const apiKey = process.env.GOAL_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        ok: false,
        code: 'MISSING_API_KEY',
        message: 'مفتاح GOAL_API_KEY غير مُضاف.',
      });
      return;
    }

    const teamId = encodeURIComponent(req.params.teamId);

    try {
      const [teamRaw, statsRaw, resultsRaw, upcomingRaw] = await Promise.all([
        fetchGoalJson(`/teams/${teamId}?includePlayers=true`, apiKey),
        fetchGoalJson(`/teams/${teamId}/statistics`, apiKey),
        fetchGoalJson(`/teams/${teamId}/results?limit=15`, apiKey),
        fetchGoalJson(`/teams/${teamId}/upcoming?limit=10`, apiKey),
      ]);

      const teamObj = (
        teamRaw && typeof teamRaw === 'object'
          ? ((teamRaw as Record<string, unknown>).data ?? teamRaw)
          : {}
      ) as Record<string, unknown>;
      const coachObj = (
        teamObj.coach && typeof teamObj.coach === 'object' ? teamObj.coach : {}
      ) as Record<string, unknown>;
      const venueObj = (
        teamObj.venue && typeof teamObj.venue === 'object' ? teamObj.venue : {}
      ) as Record<string, unknown>;

      const firstCoach =
        Array.isArray(teamObj.coaches) && teamObj.coaches.length > 0
          ? (teamObj.coaches[0] as Record<string, unknown>)
          : null;
      const teamNameRaw = String(teamObj.name || teamObj.teamName || 'فريق كرة قدم');
      const teamCountryRaw = String(teamObj.countryName || teamObj.country || '');
      const teamVenueRaw = String(
        teamObj.stadiumName ||
          teamObj.venueName ||
          venueObj.name ||
          (typeof teamObj.venue === 'string' ? teamObj.venue : '') ||
          ''
      );
      const teamCoachRaw = String(
        firstCoach?.name ||
          teamObj.coachName ||
          coachObj.name ||
          (typeof teamObj.coach === 'string' ? teamObj.coach : '') ||
          ''
      );
      const teamLogo = String(teamObj.badge || teamObj.logo || teamObj.teamBadge || '');

      const statistics = normalizeTeamStatistics(statsRaw);
      const squad = normalizeSquadPlayers(teamObj.players ?? teamObj.squad);

      const rawResults = extractArrayFromPayload(resultsRaw)
        .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
        .map((x, idx) => normalizeFixtureRecord(x, idx));
      const rawUpcoming = extractArrayFromPayload(upcomingRaw)
        .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
        .map((x, idx) => normalizeFixtureRecord(x, idx));

      const [recentResults, upcomingFixtures] = await Promise.all([
        translateFixturesToArabic(rawResults),
        translateFixturesToArabic(rawUpcoming),
      ]);

      // Derive form from recent results if statistics didn't include form
      if (statistics && statistics.form.length === 0 && recentResults.length > 0) {
        const derivedForm: Array<'W' | 'D' | 'L'> = [];
        for (const r of recentResults.slice(0, 5)) {
          if (typeof r.homeScore !== 'number' || typeof r.awayScore !== 'number') continue;
          const isHome =
            r.homeTeamId === req.params.teamId ||
            r.homeTeamEn?.toLowerCase() === teamNameRaw.toLowerCase();
          const gf = isHome ? r.homeScore : r.awayScore;
          const ga = isHome ? r.awayScore : r.homeScore;
          derivedForm.push(gf > ga ? 'W' : gf < ga ? 'L' : 'D');
        }
        statistics.form = derivedForm;
      }

      const termsToTranslate: WikiLookupItem[] = [
        { term: teamNameRaw, kind: 'team', countryHint: teamCountryRaw },
        { term: teamCountryRaw, kind: 'country' },
        { term: teamVenueRaw, kind: 'venue' },
        { term: teamCoachRaw, kind: 'player' },
      ];
      for (const pl of squad) {
        termsToTranslate.push({ term: pl.name, kind: 'player' });
        if (pl.nationality) termsToTranslate.push({ term: pl.nationality, kind: 'country' });
      }
      const termMap = await translateTermsMap(termsToTranslate, 150);
      const t = (val: string) => (val ? termMap.get(val.trim()) || translateTermSync(val) : '');

      for (const pl of squad) {
        pl.name = t(pl.name) || pl.name;
        if (pl.nationality) pl.nationality = t(pl.nationality) || pl.nationality;
      }

      res.json({
        ok: true,
        teamProfile: {
          team: {
            id: String(teamObj.id || req.params.teamId),
            name: t(teamNameRaw) || teamNameRaw,
            logo: teamLogo,
            country: t(teamCountryRaw),
            venue: t(teamVenueRaw),
            coach: t(teamCoachRaw),
            founded: teamObj.founded ? String(teamObj.founded) : undefined,
          },
          statistics,
          recentResults,
          upcomingFixtures,
          squad,
        },
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        code: 'NETWORK_ERROR',
        message:
          err instanceof Error ? `تعذر جلب ملف الفريق: ${err.message}` : 'تعذر جلب ملف الفريق.',
      });
    }
  });

  // Safe image proxy for external club logos so Canvas 2D PNG export never gets CORS-tainted
  app.get('/api/image-proxy', async (req, res) => {
    const rawUrl = String(req.query.url || '');
    if (!rawUrl.startsWith('https://')) {
      res.status(400).send('Invalid URL');
      return;
    }
    try {
      const parsed = new URL(rawUrl);
      if (
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname.endsWith('.local')
      ) {
        res.status(403).send('Forbidden host');
        return;
      }
      const imgRes = await fetch(parsed.toString());
      if (!imgRes.ok) {
        res.status(imgRes.status).send('Upstream error');
        return;
      }
      const ct = imgRes.headers.get('content-type') || 'image/png';
      if (!ct.startsWith('image/')) {
        res.status(400).send('Not an image');
        return;
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buf);
    } catch {
      res.status(502).send('Image fetch failed');
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

createAppServer();
