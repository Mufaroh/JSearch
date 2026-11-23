// Outgoing email (Gmail or any SMTP server): job applications to employers, and job alerts to the person.
import nodemailer from 'nodemailer';

const env = process.env;

let transport;
function mailer() {
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 465),
    secure: Number(env.SMTP_PORT || 465) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transport;
}

const fromAddress = () => env.SMTP_FROM || env.SMTP_USER;

// Applies for a job: emails the employer the CV with a cover letter, sent in the person's name.
// coverLetterPdf (optional) is attached alongside the CV.
export async function sendApplicationEmail({ to, profile, job, coverLetter, pdfBuffer, pdfName, coverLetterPdf, subjectPrefix = '' }) {
  const attachments = [{ filename: pdfName, content: pdfBuffer }];
  if (coverLetterPdf) attachments.push({ filename: `Cover Letter - ${profile.name}.pdf`, content: coverLetterPdf });
  await mailer().sendMail({
    from: `"${profile.name}" <${fromAddress()}>`,
    replyTo: profile.email || undefined,
    to,
    subject: `${subjectPrefix}Application: ${job.job_title} – ${profile.name}`,
    text: coverLetter,
    attachments,
  });
}

// One email per person per run listing the jobs applied for and the jobs to apply for themselves.
export async function sendJobAlert({ profile, applied, manual }) {
  const line = (j) => `• ${j.job_title}${j.employer_name ? ` at ${j.employer_name}` : ''}${j.job_city ? ` (${j.job_city})` : ''}`;
  const parts = [`Hi ${profile.name.split(' ')[0]},`, ''];
  if (applied.length) {
    parts.push('I applied for these jobs for you by emailing your CV:', '');
    for (const { job, to } of applied) parts.push(line(job), `  Sent to: ${to}`, '');
  }
  if (manual.length) {
    parts.push('New jobs that may suit you. Apply for these yourself:', '');
    for (const { job, link } of manual) parts.push(line(job), `  Apply: ${link}`, '');
  }
  parts.push('Good luck!');

  const count = applied.length + manual.length;
  await mailer().sendMail({
    from: `"Job Alerts" <${fromAddress()}>`,
    to: profile.email,
    subject: applied.length
      ? `Applied for ${applied.length} job${applied.length > 1 ? 's' : ''} for you` +
        (manual.length ? ` + ${manual.length} to apply for` : '')
      : `${count} new job${count > 1 ? 's' : ''} for you`,
    text: parts.join('\n'),
  });
}
