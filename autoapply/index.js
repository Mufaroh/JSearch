// Auto-apply run (free services only): for every CV in CVs/, search JSearch for matching jobs.
// When a listing asks for applications by email, email the employer the CV with a cover letter.
// Then email the person one alert listing what was applied for and what they should apply for themselves.
//
//   npm run autoapply                 real run
//   npm run autoapply -- --dry-run    search and filter, but send nothing and don't remember jobs
//   npm run autoapply -- --preview    dry run that also writes sample cover letters to data/previews/
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendApplicationEmail, sendJobAlert } from './senders.js';
import { EMAIL_NOTE, fill, jobFields, loadCoverLetter, renderLetterPdf } from './coverLetter.js';
import { enabledSources, jobFingerprint, searchAllSources } from './sources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CV_DIR = path.join(ROOT, 'CVs');
const COVER_LETTER_DIR = path.join(ROOT, 'CoverLetters');
const PEOPLE_FILE = path.join(CV_DIR, 'people.json');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');

const PREVIEW = process.argv.includes('--preview');
// --demo-to=you@example.com: for every CV (even disabled ones), send the application for one real job
// to this address instead of the employer. Nothing is remembered and no job alerts are sent.
const DEMO_TO = (process.argv.find((a) => a.startsWith('--demo-to=')) || '').slice('--demo-to='.length);
const DRY_RUN = PREVIEW || Boolean(DEMO_TO) || process.argv.includes('--dry-run');
const PREVIEW_DIR = path.join(ROOT, 'data', 'previews');
const PREVIEWS_PER_CV = 3;
const MAX_APPLICATIONS = Number(process.env.MAX_EMAILS_PER_CV_PER_RUN || 5);
const MAX_ALERTS = Number(process.env.MAX_ALERTS_PER_CV_PER_RUN || 10);
const FORGET_AFTER_DAYS = 30;

const env = process.env;
const emailEnabled = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

// CVs/people.json: per-CV settings keyed by PDF file name.
function loadPeople() {
  if (!fs.existsSync(PEOPLE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`CVs/people.json is not valid JSON: ${e.message}`);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { runCount: 0, seen: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const lowerList = (v) => (Array.isArray(v) ? v : []).map((w) => String(w).toLowerCase()).filter(Boolean);

// Finds the address a listing asks applications to be sent to: a mailto: apply link, or an email
// address in the description. Skips addresses that are clearly not for applications.
const NOT_FOR_APPLICATIONS = /no-?reply|privacy|popia|unsubscribe|support|complaint|fraud|webmaster|example\./i;
function findApplicationEmail(job) {
  const links = [job.job_apply_link, ...(job.apply_options || []).map((o) => o.apply_link)].filter(Boolean);
  const mailto = links.find((l) => l.toLowerCase().startsWith('mailto:'));
  const candidates = [];
  if (mailto) candidates.push(decodeURIComponent(mailto.slice(7).split('?')[0]));
  candidates.push(...((job.job_description || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []));
  return candidates.map((e) => e.replace(/\.$/, '')).find((e) => !NOT_FOR_APPLICATIONS.test(e)) || '';
}

const safeFileName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

async function processCv(file, state, settings) {
  const pdfBuffer = fs.readFileSync(path.join(CV_DIR, file));
  const letter = loadCoverLetter(COVER_LETTER_DIR, file, settings);
  const profile = {
    name: settings.name,
    email: settings.email,
    phone: settings.phone ? String(settings.phone) : '',
    roles: Array.isArray(settings.roles) ? settings.roles.filter(Boolean) : [],
  };
  const missing = ['name', 'email'].filter((k) => !profile[k]);
  if (!profile.roles.length) missing.push('roles');
  if (missing.length) throw new Error(`"${file}" needs ${missing.join(', ')} in CVs/people.json`);
  console.log(`  ${profile.name} | ${profile.email} | roles: ${profile.roles.join(', ')}`);
  console.log(`  Cover letter: ${letter.source}`);

  // The cover letter PDF for one job: the person's template filled in from the post, or their own PDF.
  const coverLetterFor = async (fields) =>
    letter.pdf ?? renderLetterPdf({ profile, date: fields.date, body: fill(letter.template, fields) });

  // One request per source per CV per run (free plan quotas), rotating through the roles.
  const role = profile.roles[state.runCount % profile.roles.length];
  const { jobs, summary, errors } = await searchAllSources(role);
  for (const message of errors) console.warn(`  ⚠ ${message} (carrying on with the other sources)`);
  const seen = (state.seen[file] ??= {});
  // A job is remembered by its id and by title + employer, so the same job found later on
  // another source isn't sent again.
  const isSeen = (job) => Boolean(seen[job.job_id] || seen[jobFingerprint(job)]);
  const markSeen = (job, action) => {
    seen[job.job_id] = seen[jobFingerprint(job)] = { at: Date.now(), action };
  };
  const exclude = lowerList(settings.exclude);
  const keywords = lowerList(settings.keywords);

  // Title filters stand in for a real fit check: the title must contain one of the person's
  // "keywords" (if any are set) and none of the "exclude" words.
  const fresh = jobs.filter((j) => {
    if (isSeen(j)) return false;
    const title = (j.job_title || '').toLowerCase();
    const bad = exclude.find((w) => title.includes(w));
    const why = bad ? `title contains "${bad}"` : keywords.length && !keywords.some((w) => title.includes(w)) ? 'title has none of the keywords' : '';
    if (!why) return true;
    console.log(`    ✗ ${j.job_title} @ ${j.employer_name} — ${why}`);
    if (!DRY_RUN) markSeen(j, 'filtered');
    return false;
  });
  console.log(`  Search "${role}" in South Africa: ${jobs.length} jobs (${summary}), ${fresh.length} new and suitable`);
  if (!fresh.length) return;

  if (DEMO_TO) {
    const job = fresh[0];
    const fields = jobFields(job, profile, settings.skills);
    const employerAddress = findApplicationEmail(job);
    await sendApplicationEmail({
      to: DEMO_TO, profile, job, pdfBuffer, pdfName: file, subjectPrefix: '[DEMO] ',
      coverLetter: fill(EMAIL_NOTE, fields),
      coverLetterPdf: await coverLetterFor(fields),
    });
    console.log(`    ✉ Demo application for "${job.job_title} @ ${job.employer_name}" sent to ${DEMO_TO}`);
    console.log(`       matched skills: ${fields.matchedSkills || '(none, so that sentence is left out)'}`);
    console.log(`       a real run would ${employerAddress ? `send it to ${employerAddress}` : 'not send it: the listing gives no application email'}`);
    return;
  }

  if (PREVIEW) {
    const dir = path.join(PREVIEW_DIR, safeFileName(file.replace(/\.pdf$/i, '')));
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, job] of fresh.slice(0, PREVIEWS_PER_CV).entries()) {
      const fields = jobFields(job, profile, settings.skills);
      const out = path.join(dir, `${i + 1} - ${safeFileName(`${job.employer_name} - ${job.job_title}`)}.pdf`);
      fs.writeFileSync(out, await coverLetterFor(fields));
      console.log(`    📝 ${path.relative(ROOT, out)}`);
      console.log(`       matched skills: ${fields.matchedSkills || '(none, so that sentence is left out)'}`);
    }
    return;
  }

  const applied = [];
  const manual = [];
  for (const job of fresh) {
    const label = `${job.job_title} @ ${job.employer_name}`;
    const to = findApplicationEmail(job);
    if (to && emailEnabled && applied.length < MAX_APPLICATIONS) {
      console.log(`    ✉ ${label} — applying by email to ${to}`);
      if (DRY_RUN) {
        applied.push({ job, to });
        continue;
      }
      try {
        const fields = jobFields(job, profile, settings.skills);
        await sendApplicationEmail({
          to, profile, job, pdfBuffer, pdfName: file,
          coverLetter: fill(EMAIL_NOTE, fields),
          coverLetterPdf: await coverLetterFor(fields),
        });
        applied.push({ job, to });
        markSeen(job, 'applied');
        continue;
      } catch (e) {
        console.error(`    Email to ${to} failed (${e.message}); listing it to apply manually instead.`);
      }
    }
    if (manual.length >= MAX_ALERTS) {
      console.log(`    … ${label} — over ${MAX_ALERTS} alerts this run, kept for the next run`);
      continue; // left unseen, so it's sent on a later run
    }
    const link = job.job_apply_link || job.job_google_link;
    console.log(`    → ${label} — apply manually: ${link}`);
    manual.push({ job, link });
  }

  if (DRY_RUN || !emailEnabled || (!applied.length && !manual.length)) return;
  try {
    await sendJobAlert({ profile, applied, manual });
    for (const { job } of manual) markSeen(job, 'alerted');
    console.log(`  Alert emailed to ${profile.email}`);
  } catch (e) {
    console.error(`  Alert email failed: ${e.message}`); // manual jobs stay unseen and are retried next run
  }
}

async function main() {
  const sources = enabledSources();
  if (!sources.length) throw new Error('No job source configured: set RAPIDAPI_KEY (JSearch), ADZUNA_APP_ID + ADZUNA_APP_KEY, or JOOBLE_API_KEY');
  console.log(`Job sources: ${sources.join(', ')}`);
  if (!emailEnabled) console.warn('⚠ Email not configured (SMTP_HOST / SMTP_USER / SMTP_PASS); nothing will be sent.');
  if (DEMO_TO) {
    if (!emailEnabled) throw new Error('Demo needs email set up: fill in SMTP_HOST, SMTP_USER and SMTP_PASS in .env');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(DEMO_TO)) throw new Error(`--demo-to needs an email address, got "${DEMO_TO}"`);
    console.log(`DEMO: one application per CV goes to ${DEMO_TO}, not to employers. Nothing is remembered.\n`);
  } else if (PREVIEW) console.log(`PREVIEW: nothing will be sent; sample cover letters go to ${path.relative(ROOT, PREVIEW_DIR)}/\n`);
  else if (DRY_RUN) console.log('DRY RUN: nothing will be sent.\n');

  const files = fs.existsSync(CV_DIR) ? fs.readdirSync(CV_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')) : [];
  if (!files.length) {
    console.log(`No PDF CVs found in ${CV_DIR}`);
    return;
  }

  const people = loadPeople();
  for (const name of Object.keys(people)) {
    if (!files.includes(name)) console.warn(`⚠ CVs/people.json has "${name}" but there's no PDF with that name in CVs/`);
  }
  const cvBases = new Set(files.map((f) => f.replace(/\.pdf$/i, '')));
  for (const letter of fs.existsSync(COVER_LETTER_DIR) ? fs.readdirSync(COVER_LETTER_DIR) : []) {
    if (!/\.(pdf|txt)$/i.test(letter) || cvBases.has(letter.replace(/\.(pdf|txt)$/i, ''))) continue;
    console.warn(`⚠ CoverLetters/${letter} doesn't match any CV; name it exactly like the CV it belongs to (e.g. "${files[0]}")`);
  }
  const state = loadState();
  state.seen ??= {};
  state.runCount ??= 0;
  const cutoff = Date.now() - FORGET_AFTER_DAYS * 86400_000;
  for (const jobs of Object.values(state.seen)) {
    for (const [id, s] of Object.entries(jobs)) if (s.at < cutoff) delete jobs[id];
  }

  let failed = 0;
  for (const file of files) {
    console.log(`\n📄 ${file}`);
    if (people[file]?.enabled === false && !DEMO_TO) {
      console.log('  ⏸ Disabled in CVs/people.json ("enabled": false), skipping');
      continue;
    }
    try {
      await processCv(file, state, people[file] || {});
    } catch (e) {
      failed++;
      console.error(`  ✗ ${e.message}`);
    }
    if (!DRY_RUN) saveState(state); // save after each CV so a crash later doesn't cause duplicates
  }
  state.runCount++;
  if (!DRY_RUN) saveState(state);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
