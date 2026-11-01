import { BookOpen, MapPin, ShieldAlert } from 'lucide-react';
import { LegalPage, LegalSection } from '../components/marketing/LegalPage';

export default function TermsOfService() {
  return (
    <LegalPage
      eyebrow="Legal Contract"
      title="Terms of Service"
      intro="This document outlines the operational and legal boundaries between Skyllai and your institution, protecting both your proprietary data and our intellectual property."
    >
      <LegalSection title='The "No-Training" Clause' icon={ShieldAlert}>
        <blockquote className="rounded-r-xl border-l-4 border-ink bg-card px-5 py-4 font-display text-[18px] font-semibold leading-snug tracking-[-0.01em] text-ink">
          "Skyllai strictly guarantees that no student answers, handwriting styles, school question papers, or answer keys will be used to train, fine-tune, or improve public AI models or third-party LLMs."
        </blockquote>
        <p>
          Our AI models are closed systems. Any data processed during the grading cycle is solely used to evaluate your specific exams and is never ingested back into global datasets.
        </p>
      </LegalSection>

      <LegalSection title="Intellectual Property Protection" icon={BookOpen}>
        <p>
          A foundational pillar of our service is that the school retains 100% absolute ownership of their exams, scoring rubrics, and answer keys. Skyllai holds no rights to your academic content. We are merely providing the computation tool to grade and analyze them efficiently.
        </p>
      </LegalSection>

      <LegalSection title="School-Controlled Capture" icon={MapPin}>
        <p>
          Schools control their assessment capture and roster workflows. Uploaded assessment files are stored and processed through Skyll's authenticated cloud services so authorised users can access review, reports, and audit history. Details of data handling are described in our Privacy Notice.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
