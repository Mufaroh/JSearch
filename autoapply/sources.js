// Job sources. Each one searches South Africa for a job title and returns jobs in JSearch's format
// (job_id, job_title, employer_name, job_description, job_apply_link, job_city, ...), so the rest of
// auto-apply works the same whichever source a job came from.
//
// A source is used only when its keys are set:
//   JSearch  RAPIDAPI_KEY
//   Adzuna   ADZUNA_APP_ID + ADZUNA_APP_KEY   (developer.adzuna.com)
//   Jooble   JOOBLE_API_KEY                   (jooble.org/api/about)
// One failing source doesn't stop the others.

const env = process.env;
const MAX_DAYS_OLD = 3;

// Retries connection failures (not error responses): they're usually brief network blips.
async function fetchWithRetry(name, url, options = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw Object.assign(new Error(`${name} failed (${res.status}): ${(await res.text()).slice(0, 200)}`), { final: true });
      return await res.json();
    } catch (e) {
      if (e.final) throw e;
      const why = e.cause?.code || e.name || e.message;
      if (attempt >= 3) throw new Error(`Couldn't reach ${name} after 3 tries (${why})`);
      console.log(`  ${name} unreachable (${why}), retrying…`);
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function searchJSearch(role) {
  const url = new URL('https://jsearch.p.rapidapi.com/search-v2'); // JSearch removed /search in Nov 2026
  url.searchParams.set('query', `${role} in South Africa`);
  url.searchParams.set('country', 'za');
  url.searchParams.set('date_posted', '3days');
  url.searchParams.set('num_pages', '1');
  const { data } = await fetchWithRetry('JSearch', url, {
    headers: { 'x-rapidapi-key': env.RAPIDAPI_KEY, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' },
  });
  return Array.isArray(data) ? data : data?.jobs || []; // /search-v2 returns { data: { jobs, cursor } }
}

// Adzuna gives a ~500-character snippet of the description, so skill matching and finding an
// application email work less well than with JSearch's full descriptions.
async function searchAdzuna(role) {
  const url = new URL('https://api.adzuna.com/v1/api/jobs/za/search/1');
  url.searchParams.set('app_id', env.ADZUNA_APP_ID);
  url.searchParams.set('app_key', env.ADZUNA_APP_KEY);
  // Title-only: a plain keyword search also returns e.g. avionics engineers for "Java Developer".
  url.searchParams.set('title_only', role);
  url.searchParams.set('max_days_old', String(MAX_DAYS_OLD));
  url.searchParams.set('results_per_page', '20');
  url.searchParams.set('sort_by', 'date');
  const body = await fetchWithRetry('Adzuna', url, { headers: { Accept: 'application/json' } });
  return (body.results || []).map((j) => {
    const area = j.location?.area || []; // e.g. ["South Africa", "Gauteng", "Johannesburg"]
    return {
      job_id: `adzuna:${j.id}`,
      job_publisher: 'Adzuna',
      job_title: stripHtml(j.title),
      employer_name: stripHtml(j.company?.display_name),
      job_description: stripHtml(j.description),
      job_apply_link: j.redirect_url,
      job_city: area.length > 2 ? area.at(-1) : '',
      job_state: area[1] || '',
      job_employment_type: j.contract_type === 'contract' ? 'contract' : j.contract_time || '',
      job_posted_at_datetime_utc: j.created,
    };
  });
}

async function searchJooble(role) {
  const host = env.JOOBLE_HOST || 'jooble.org';
  const body = await fetchWithRetry('Jooble', `https://${host}/api/${encodeURIComponent(env.JOOBLE_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords: role, location: 'South Africa', page: '1' }),
  });
  const cutoff = Date.now() - MAX_DAYS_OLD * 86400_000;
  return (body.jobs || [])
    .filter((j) => !j.updated || !(Date.parse(j.updated) < cutoff)) // Jooble has no reliable date filter
    .map((j) => ({
      job_id: `jooble:${j.id}`,
      job_publisher: 'Jooble',
      job_title: stripHtml(j.title),
      employer_name: stripHtml(j.company),
      job_description: stripHtml(j.snippet),
      job_apply_link: j.link,
      job_city: stripHtml(j.location),
      job_employment_type: j.type || '',
      job_posted_at_datetime_utc: j.updated,
    }));
}

const SOURCES = [
  { name: 'JSearch', enabled: () => Boolean(env.RAPIDAPI_KEY), search: searchJSearch },
  { name: 'Adzuna', enabled: () => Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY), search: searchAdzuna },
  { name: 'Jooble', enabled: () => Boolean(env.JOOBLE_API_KEY), search: searchJooble },
];

export const enabledSources = () => SOURCES.filter((s) => s.enabled()).map((s) => s.name);

// The same job often appears on several sources under different ids; this identifies it by title
// and employer instead.
export function jobFingerprint(job) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `fp:${norm(job.job_title)}|${norm(job.employer_name)}`;
}

// Searches every enabled source in parallel. Returns the jobs (duplicates removed, JSearch's copy
// kept first since it has the fullest details) and a per-source summary for the log.
// Throws only when every source failed.
export async function searchAllSources(role) {
  const sources = SOURCES.filter((s) => s.enabled());
  const results = await Promise.allSettled(sources.map((s) => s.search(role)));
  const jobs = [];
  const fingerprints = new Set();
  const summary = [];
  const errors = [];
  results.forEach((r, i) => {
    const { name } = sources[i];
    if (r.status === 'rejected') {
      summary.push(`${name} failed`);
      errors.push(r.reason.message);
      return;
    }
    let added = 0;
    for (const job of r.value) {
      const fp = jobFingerprint(job);
      if (fingerprints.has(fp)) continue;
      fingerprints.add(fp);
      jobs.push(job);
      added++;
    }
    summary.push(`${name} ${r.value.length}${added < r.value.length ? ` (${r.value.length - added} duplicates)` : ''}`);
  });
  if (errors.length === sources.length) throw new Error(errors.join('; '));
  return { jobs, summary: summary.join(', '), errors };
}
