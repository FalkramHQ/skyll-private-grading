import { FileCheck, Lock, Users } from 'lucide-react';
import { LegalPage, LegalSection } from '../components/marketing/LegalPage';

const SECTION_9 = [
  ['Secure Processing:', 'Scans are uploaded through authenticated, encrypted connections and stored privately for authorised assessment workflows.'],
  ['Role-limited Access:', 'Assessment data is scoped to the relevant school and user role, with review and processing actions recorded for auditability.'],
  ['No Targeting:', 'Skyll does not sell student data or use it for behavioural tracking or targeted advertising to children.'],
];

export default function DPDPCompliance() {
  return (
    <LegalPage
      eyebrow="Legal Assurances"
      title="DPDP Act Compliance Statement"
      intro="Skyll supports schools with access-controlled assessment processing, auditability, and privacy request handling. Schools should obtain their own legal advice for their specific compliance obligations."
    >
      <LegalSection title="Data Fiduciary vs. Data Processor" icon={FileCheck}>
        <p>
          Under the DPDP Act, the <strong>School acts as the Data Fiduciary</strong>. You own the data and determine the purpose of processing it. <strong>Skyllai operates strictly as a Data Processor</strong>. We act exclusively upon the school's authorized instructions, meaning we have no independent rights over the data flowing through our systems.
        </p>
      </LegalSection>

      <LegalSection title="Section 9 Compliance (Children's Data)" icon={Lock}>
        <p>We explicitly meet and exceed the DPDP Act's strict guidelines regarding the processing of data belonging to minors:</p>
        <ul className="list-disc space-y-3 pl-5 marker:text-ink">
          {SECTION_9.map(([term, body]) => (
            <li key={term}><strong>{term}</strong> {body}</li>
          ))}
        </ul>
      </LegalSection>

      <LegalSection title="Parental Consent Framework" icon={Users}>
        <p>
          As the Data Fiduciary, the school is responsible for acquiring verifiable parental consent for digital evaluation processes as required by the Act. Skyllai supports the school by providing the robust technical safeguards, encryption standards, and audit logs necessary to protect that consented data from end to end.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
