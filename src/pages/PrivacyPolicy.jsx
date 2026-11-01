import { Database, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { LegalPage, LegalSection, legalLink } from '../components/marketing/LegalPage';

const updatedOn = '1 November 2026';

const PRINCIPLES = [
  { icon: Database, title: 'Assessment-first', body: 'Data is used to operate assessment, review, and reporting workflows.' },
  { icon: LockKeyhole, title: 'Access-controlled', body: 'School-scoped access and private storage protect uploaded work.' },
  { icon: ShieldCheck, title: 'No advertising', body: 'Skyll does not sell student data or use it for targeted advertising.' },
];

const listClass = 'list-disc space-y-2 pl-5 marker:text-ink';

export default function PrivacyPolicy() {
  return (
    <LegalPage
      eyebrow="Legal & trust"
      title="Privacy Notice"
      intro="How Skyll AI handles assessment data for schools, administrators, students, and parents."
      updated={updatedOn}
    >
      <ul className="grid gap-3 sm:grid-cols-3">
        {PRINCIPLES.map(({ icon: Icon, title, body }) => (
          <li key={title} className="rounded-2xl border border-border bg-card p-5">
            <Icon className="h-5 w-5 text-ink" aria-hidden="true" />
            <p className="mt-3 font-display text-[17px] font-bold tracking-[-0.01em] text-ink">{title}</p>
            <p className="mt-1 text-sm leading-relaxed text-foreground-secondary">{body}</p>
          </li>
        ))}
      </ul>

      <LegalSection title="Who this notice covers"><p>This notice applies to Skyll’s website, mobile app, assessment scanning, review, grading, reporting, and support services. For school-managed accounts, the school normally decides why assessment data is collected and used. Skyll processes that data to provide the agreed service.</p></LegalSection>
      <LegalSection title="Data we process"><p>Depending on the role and features used, Skyll may process:</p><ul className={listClass}><li>Names, school, batch or class, username, and role.</li><li>Scanned answer sheets, question papers, answer keys, and other uploaded documents.</li><li>Answers, OCR text, question mappings, marks, feedback, learning insights, reports, and review history.</li><li>Recheck requests and the explanation supplied with them.</li><li>Limited technical and security information such as device/session identifiers, app version, and authentication activity.</li></ul></LegalSection>
      <LegalSection title="Why we use it"><ul className={listClass}><li>Authenticate authorised users and show school-scoped dashboards.</li><li>Capture, store, OCR, map, grade, review, regrade, and report on assessments.</li><li>Maintain audit history, resolve rechecks, prevent misuse, and provide support.</li><li>Operate, secure, debug, and improve the reliability of the service.</li></ul></LegalSection>
      <LegalSection title="Storage and AI processing"><p>Uploads and evidence are stored in private, access-controlled object storage. Assessment metadata, review records, and reports are stored in our application database. We use selected infrastructure, OCR, and AI service providers to process content on Skyll’s behalf for the assessment workflow. We do not sell student data, use it for targeted advertising, or knowingly submit identifiable student work to train public AI models.</p><p>We restrict access by school and role, use encrypted HTTPS connections for data in transit, and do not expose permanent public links to private answer-sheet files.</p></LegalSection>
      <LegalSection title="Website analytics and advertising"><p>On Skyll’s public website pages (the home page, demo, partner, AI Labs and legal pages) we use Google Analytics and the Meta Pixel to understand how visitors find and use the site and to measure our advertising. These tools set cookies and may receive your IP address, browser and device details, the page address (Google Analytics receives it with only campaign tags such as utm_source; the Meta Pixel receives the full address), the referring page and actions such as opening the demo or clicking our WhatsApp or email links. They are not used on sign-in pages or inside the Skyll app (dashboards, review, CRM and admin), or on school, parent-report, fee or account-deletion pages, and they never receive student, assessment or school data.</p><p>Google and Meta process this data under their own privacy policies. You can block these cookies in your browser settings, use Google’s opt-out add-on (<a className={legalLink} href="https://tools.google.com/dlpage/gaoptout" target="_blank" rel="noopener noreferrer">tools.google.com/dlpage/gaoptout</a>), or adjust ad settings in your Meta account. For questions, write to <a className={legalLink} href="mailto:contact@skyllai.com">contact@skyllai.com</a>.</p></LegalSection>
      <LegalSection title="Retention and deletion"><p>Assessment records are retained according to the school’s agreement and retention policy so reports, review decisions, and audit history remain available. They are not automatically deleted immediately after marking.</p><p>A school administrator, parent/guardian, or eligible student may request deletion or correction through the school or through our <a className={legalLink} href="/account-deletion">account and data deletion page</a>. We verify authority before acting and may retain the minimum necessary record where required for security, legal, or audit purposes.</p></LegalSection>
      <LegalSection title="Children and school-managed accounts"><p>Skyll is used through educational institutions. Schools are responsible for obtaining any permissions or consents required for their students. We do not use children’s data for advertising or behavioural profiling.</p></LegalSection>
      <LegalSection title="Your choices and contact"><p>For access, correction, deletion, or a privacy concern, contact <a className={legalLink} href="mailto:contact@skyllai.com">contact@skyllai.com</a> with the subject “Privacy request”. Please include the school name and the affected account or student name so we can locate the request safely.</p><p>We may update this notice as the service evolves. Material changes will be posted on this page with a revised date.</p></LegalSection>

      <div className="flex gap-3 rounded-2xl border border-info/20 bg-info-soft p-5 text-[15px] leading-relaxed text-ink sm:p-6">
        <Mail className="mt-0.5 h-5 w-5 shrink-0 text-info" aria-hidden="true" />
        <p>For a privacy or account-data request, email <a className={legalLink} href="mailto:contact@skyllai.com?subject=Privacy%20request">contact@skyllai.com</a>.</p>
      </div>
    </LegalPage>
  );
}
