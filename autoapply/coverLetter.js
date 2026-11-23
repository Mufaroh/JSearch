// Cover letters: a template per person, filled in from each job post and turned into a PDF.
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const DEFAULT_COVER_LETTER = `Dear Hiring Manager,

I am writing to apply for the {title} position at {company}. Please find my CV attached.

I believe my qualifications and experience make me a strong fit for this role, and I would welcome the opportunity to discuss how I can contribute to your team. I have experience with {matchedSkills}, which the role mentions.

Thank you for your time and consideration. I look forward to hearing from you.

Kind regards,
{name}
{phone}
{email}`;

// The email body; the cover letter itself goes in as a PDF attachment.
export const EMAIL_NOTE = `Dear Hiring Manager,

Please find attached my CV and cover letter for the {title} position at {company}.

Kind regards,
{name}
{phone}
{email}`;

// A CV's cover letter, looked up in CoverLetters/ by the CV's file name:
//   1. <CV name>.txt  a template, filled in from each job post and made into a PDF per application
//   2. <CV name>.pdf  a finished letter, attached unchanged to every application
//   3. otherwise "coverLetter" in CVs/people.json, or the default template
export function loadCoverLetter(dir, file, settings) {
  const base = file.replace(/\.pdf$/i, '');
  const txt = path.join(dir, `${base}.txt`);
  const pdf = path.join(dir, `${base}.pdf`);
  if (fs.existsSync(txt)) {
    return { source: `CoverLetters/${base}.txt, filled in per job`, template: fs.readFileSync(txt, 'utf8').replace(/\r\n/g, '\n') };
  }
  if (fs.existsSync(pdf)) return { source: `CoverLetters/${base}.pdf, same for every job`, pdf: fs.readFileSync(pdf) };
  if (settings.coverLetter) return { source: 'people.json "coverLetter", filled in per job', template: settings.coverLetter };
  return { source: 'default template, filled in per job', template: DEFAULT_COVER_LETTER };
}

const EMPLOYMENT_TYPES = {
  fulltime: 'full-time', parttime: 'part-time', contractor: 'contract', contract: 'contract',
  intern: 'internship', internship: 'internship', temporary: 'temporary',
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Skills from the person's own "skills" list that the job post mentions, in the person's order
// (most important first). "Spring Boot|Springboot" matches either spelling and is written as "Spring Boot".
// Only the person's skills are ever used, so the letter never claims anything that isn't on their CV.
export function matchSkills(job, skills, max = 4) {
  const highlights = Object.values(job.job_highlights || {}).flat();
  const text = [job.job_title, job.job_description, ...highlights].join(' ').toLowerCase();
  return (Array.isArray(skills) ? skills : [])
    .map((entry) => String(entry).split('|').map((s) => s.trim()).filter(Boolean))
    .filter((aliases) => aliases.length && aliases.some((a) => new RegExp(`(^|[^a-z0-9])${escapeRegex(a.toLowerCase())}(?![a-z0-9])`).test(text)))
    .map((aliases) => aliases[0])
    .slice(0, max);
}

// "a, b and c"; with a comma before the last "and" when a skill has "and" in its own name
// ("infection prevention and control, and wound care").
function joinList(items) {
  if (items.length < 2) return items.join('');
  const lastJoin = items.some((s) => / and /i.test(s)) ? ', and ' : ' and ';
  return `${items.slice(0, -1).join(', ')}${lastJoin}${items.at(-1)}`;
}

// Everything a template can use. Fields the job post doesn't provide are empty strings.
export function jobFields(job, profile, skills) {
  const type = String(job.job_employment_type || job.job_employment_types?.[0] || '').toLowerCase().replace(/[^a-z]/g, '');
  return {
    title: job.job_title || '',
    company: job.employer_name || 'your company',
    location: [...new Set([job.job_city, job.job_state].filter(Boolean))].join(', ') || (job.job_is_remote ? 'remote' : ''),
    employmentType: EMPLOYMENT_TYPES[type] || '',
    matchedSkills: joinList(matchSkills(job, skills)),
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' }),
    name: profile.name,
    phone: profile.phone ? `+${profile.phone}` : '',
    email: profile.email,
  };
}

// Fills in {field}s. A sentence that uses an empty field is left out entirely, so a sentence like
// "I see the role involves {matchedSkills}." simply disappears when nothing matches, leaving no gap.
export function fill(template, values) {
  const isEmpty = (s) => [...s.matchAll(/\{(\w+)\}/g)].some(([, k]) => k in values && !values[k]);
  const sub = (s) => s.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
  return template
    .split('\n')
    .map((line) => {
      if (!isEmpty(line)) return sub(line);
      const kept = line.split(/(?<=[.!?])\s+/).filter((sentence) => !isEmpty(sentence));
      return kept.length ? sub(kept.join(' ')) : null;
    })
    .filter((line) => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const A4 = [595.28, 841.89];
const MARGIN = 64;

// The built-in PDF fonts only cover Western European characters; anything else becomes "?".
function encodable(font, text) {
  return [...text].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
}

function wrap(text, font, size, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// One-page (or longer, if needed) A4 letter: name and contact details, date, then the letter.
export async function renderLetterPdf({ profile, date, body }) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Cover Letter - ${profile.name}`);
  doc.setAuthor(profile.name);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const textWidth = A4[0] - 2 * MARGIN;
  let page = doc.addPage(A4);
  let y = A4[1] - MARGIN;

  const write = (text, { font = regular, size = 11, color = rgb(0.13, 0.13, 0.13) } = {}) => {
    const lineHeight = size * 1.45;
    for (const line of wrap(encodable(font, text), font, size, textWidth)) {
      if (y - lineHeight < MARGIN) {
        page = doc.addPage(A4);
        y = A4[1] - MARGIN;
      }
      y -= lineHeight;
      page.drawText(line, { x: MARGIN, y, size, font, color });
    }
  };

  write(profile.name, { font: bold, size: 18 });
  write([profile.phone && `+${profile.phone}`, profile.email].filter(Boolean).join('   |   '), { size: 10, color: rgb(0.4, 0.4, 0.4) });
  y -= 10;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y }, thickness: 0.75, color: rgb(0.75, 0.75, 0.75) });
  y -= 16;
  write(date);
  y -= 10;
  for (const line of body.split('\n')) {
    if (line.trim()) write(line);
    else y -= 9;
  }
  return Buffer.from(await doc.save());
}
