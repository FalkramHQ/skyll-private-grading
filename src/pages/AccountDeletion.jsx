import { CircleCheck, Mail, ShieldCheck } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { LegalPage } from '../components/marketing/LegalPage';

const NOTES = [
  { icon: CircleCheck, text: 'You can request deletion of an account, answer sheets, reports, or another specific data category. Specify what should be removed.' },
  { icon: CircleCheck, text: 'School administrators can also manage school-owned assessment data through their designated Skyll contact.' },
  { icon: ShieldCheck, text: 'We may retain a minimal record where needed for security, fraud prevention, legal obligations, or audit purposes. We will explain any retained category when responding.' },
];

export default function AccountDeletion() {
  const subject = encodeURIComponent('Account or data deletion request');
  const body = encodeURIComponent('School name:\nStudent or username:\nRequest (account deletion, answer-sheet deletion, or correction):\nRelationship/authority to request:\n');
  return (
    <LegalPage
      eyebrow="Privacy requests"
      title="Request account or data deletion"
      intro="Skyll accounts are usually created and managed by a school. This page gives students, parents/guardians, and school administrators a direct route to ask for deletion or correction."
    >
      <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <div className="flex gap-4">
          <Mail className="mt-1 h-5 w-5 shrink-0 text-ink" aria-hidden="true" />
          <div>
            <h2 className="text-[22px] leading-tight text-ink">Send a verified request</h2>
            <p className="mt-3 text-base leading-[1.7] text-foreground-secondary">Email us with the school name, student name or username, the requested action, and your authority to make the request. We may contact the school to verify the request before changing or deleting records.</p>
            <Button asChild className="mt-6 h-11 px-5 text-[15px]">
              <a href={`mailto:contact@skyllai.com?subject=${subject}&body=${body}`}>Email deletion request</a>
            </Button>
          </div>
        </div>
      </section>
      <ul className="space-y-5">
        {NOTES.map(({ icon: Icon, text }) => (
          <li key={text} className="flex gap-3 text-base leading-[1.7] text-foreground-secondary">
            <Icon className="mt-1 h-5 w-5 shrink-0 text-ink" aria-hidden="true" />
            <p>{text}</p>
          </li>
        ))}
      </ul>
    </LegalPage>
  );
}
