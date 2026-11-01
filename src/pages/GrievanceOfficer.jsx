import { Clock, Mail, MapPin, ShieldAlert } from 'lucide-react';
import { LegalPage, legalLink } from '../components/marketing/LegalPage';

function ContactRow({ icon: Icon, title, children }) {
  return (
    <div className="flex items-start gap-4 border-t border-border py-5 first:border-t-0 first:pt-0 last:pb-0">
      <Icon className="mt-1 h-5 w-5 shrink-0 text-ink" aria-hidden="true" />
      <div className="min-w-0 text-base leading-[1.7] text-foreground-secondary">
        <h3 className="text-[18px] text-ink">{title}</h3>
        {children}
      </div>
    </div>
  );
}

export default function GrievanceOfficer() {
  return (
    <LegalPage
      eyebrow="Section 13 Compliance"
      title="Grievance Officer"
      intro="In compliance with Section 13 of the Digital Personal Data Protection (DPDP) Act, 2023, Skyllai has appointed a dedicated Grievance Redressal Officer to address any concerns regarding data handling."
    >
      <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <div className="mb-6 flex items-center gap-4 border-b border-border pb-6">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-sunken text-ink" aria-hidden="true">
            <ShieldAlert className="h-6 w-6" />
          </span>
          <div>
            <p className="text-[13px] font-bold uppercase tracking-[0.12em] text-foreground-secondary">Designated Officer</p>
            <h2 className="text-[22px] leading-tight text-ink">Grievance Redressal Officer</h2>
            <p className="text-[15px] font-medium text-foreground-secondary">Skyllai AI</p>
          </div>
        </div>

        <ContactRow icon={Mail} title="Official Email Address">
          <a href="mailto:contact@skyllai.com" className={legalLink}>contact@skyllai.com</a>
          <p className="mt-1 text-sm text-muted-foreground">Please include "DPDP Grievance" in the subject line for faster routing.</p>
        </ContactRow>

        <ContactRow icon={MapPin} title="Physical Office Address">
          <p>Skyllai AI Headquarters</p>
          <p>Mumbai, India</p>
        </ContactRow>

        <ContactRow icon={Clock} title="Service Level Agreement (SLA)">
          <p>Every grievance will be formally acknowledged within 48 hours of receipt. A formal resolution will be provided within 7 to 30 days, adhering to established Indian legal standards.</p>
        </ContactRow>
      </section>
    </LegalPage>
  );
}
