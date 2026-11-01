import { useEffect, useState } from 'react';
import { ChevronDown, Send } from 'lucide-react';
import Header from '../components/Header';
import Footer from '../components/Footer';
import { Button } from '../components/ui/Button';
import { Eyebrow, Highlight, display, loudPrimary } from '../components/marketing/Notebook';
import { cn } from '../lib/utils';
import { trackSiteEvent } from '../lib/siteTracking';

// Same production figures as the landing page proof strip (Landing.jsx PROOF).
const PROOF = [
  ['6', 'Institutes live'],
  ['1,100+', 'Answer sheets marked'],
  ['25,000+', 'Answers marked'],
];

const fieldClass = 'h-12 w-full rounded-[10px] border-[1.5px] border-ink bg-card px-3.5 text-[15px] text-ink placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const labelClass = 'mb-2 block text-[14px] font-semibold text-ink';

function Field({ id, label, className, children }) {
  return (
    <div className={className}>
      <label htmlFor={id} className={labelClass}>{label}</label>
      {children}
    </div>
  );
}

export default function Partner() {
  const [formData, setFormData] = useState({
    schoolName: '',
    contactName: '',
    role: '',
    email: '',
    phone: '',
    stateCode: '',
    stateName: '',
    cityName: '',
    message: ''
  });

  const [availableCities, setAvailableCities] = useState([]);
  const [locationData, setLocationData] = useState(null);

  useEffect(() => {
    let active = true;
    import('../data/indiaLocations.json').then((module) => {
      if (active) setLocationData(module.default || module);
    });
    return () => { active = false; };
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    
    // Construct email body
    const subject = `Trial Request: ${formData.schoolName}`;
    const body = `
New Trial Request Details:

School/Institution: ${formData.schoolName}
Contact Person: ${formData.contactName} (${formData.role})
Email: ${formData.email}
Phone: ${formData.phone}
Location: ${formData.cityName}, ${formData.stateName}

Additional Information:
${formData.message}
    `;

    trackSiteEvent('trial_request');

    // Trigger mailto link to send to office@skyllai.com
    window.location.href = `mailto:office@skyllai.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleStateChange = (e) => {
    const selectedStateCode = e.target.value;
    const selectedStateObj = locationData?.states.find((state) => state.isoCode === selectedStateCode);
    
    setFormData({ 
      ...formData, 
      stateCode: selectedStateCode,
      stateName: selectedStateObj ? selectedStateObj.name : '',
      cityName: '' 
    });

    setAvailableCities((locationData?.cities?.[selectedStateCode] || []).map((name) => ({ name })));
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-ink">
      <Header />

      <main className="notebook-grid flex-1">
        <div className="layout-container grid gap-12 py-12 sm:py-16 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16 lg:py-20">
          <section className="lg:sticky lg:top-28 lg:self-start">
            <Eyebrow>For coaching institutes, language institutes and schools</Eyebrow>
            <h1 className={cn(display, 'mt-5 text-[44px] text-ink sm:text-[64px]')}>
              Start your <Highlight>free trial</Highlight>
            </h1>
            <p className="mt-6 max-w-md text-[17px] leading-relaxed text-foreground-secondary sm:text-lg">
              Tell us about your institute. We reply within one working day and set you up with the Skyll app. Your first 30 answer sheets are marked free, with reports within 24 hours.
            </p>
            <dl className="mt-10 grid max-w-md grid-cols-3 gap-4 border-t-2 border-ink pt-6">
              {PROOF.map(([n, label]) => (
                <div key={label} className="flex flex-col">
                  <dt className="order-2 mt-1.5 text-[13px] leading-snug text-foreground-secondary">{label}</dt>
                  <dd className="order-1 font-display text-[26px] font-extrabold leading-none tracking-[-0.04em] text-ink tabular-nums sm:text-[36px]">{n}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-label="Trial request form" className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-hard-lg sm:p-10">
            <form onSubmit={handleSubmit} className="grid gap-5 sm:grid-cols-2 sm:gap-6">
              <Field id="partner-school" label="School / Institution Name *" className="sm:col-span-2">
                <input
                  id="partner-school"
                  type="text"
                  name="schoolName"
                  required
                  value={formData.schoolName}
                  onChange={handleChange}
                  placeholder="e.g. Delhi Public School"
                  className={fieldClass}
                />
              </Field>

              <Field id="partner-contact" label="Your Name *">
                <input
                  id="partner-contact"
                  type="text"
                  name="contactName"
                  required
                  value={formData.contactName}
                  onChange={handleChange}
                  placeholder="Jane Doe"
                  autoComplete="name"
                  className={fieldClass}
                />
              </Field>

              <Field id="partner-role" label="Your Role *">
                <input
                  id="partner-role"
                  type="text"
                  name="role"
                  required
                  value={formData.role}
                  onChange={handleChange}
                  placeholder="e.g. Principal, IT Director"
                  autoComplete="organization-title"
                  className={fieldClass}
                />
              </Field>

              <Field id="partner-email" label="Email *">
                <input
                  id="partner-email"
                  type="email"
                  name="email"
                  required
                  value={formData.email}
                  onChange={handleChange}
                  placeholder="principal@school.edu"
                  autoComplete="email"
                  className={fieldClass}
                />
              </Field>

              <Field id="partner-phone" label="Phone Number *">
                <input
                  id="partner-phone"
                  type="tel"
                  name="phone"
                  required
                  value={formData.phone}
                  onChange={handleChange}
                  placeholder="+91 98765 43210"
                  autoComplete="tel"
                  className={fieldClass}
                />
              </Field>

              <fieldset className="sm:col-span-2">
                <legend className={labelClass}>Location *</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="relative">
                    <select
                      aria-label="State"
                      name="stateCode"
                      required
                      value={formData.stateCode}
                      onChange={handleStateChange}
                      disabled={!locationData}
                      className={cn(fieldClass, 'appearance-none pr-10 disabled:cursor-wait disabled:opacity-50')}
                    >
                      <option value="" disabled>Select State</option>
                      {!locationData && <option value="" disabled>Loading states...</option>}
                      {(locationData?.states || []).map(state => (
                        <option key={state.isoCode} value={state.isoCode}>{state.name}</option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink" />
                  </div>

                  <div className="relative">
                    <select
                      aria-label="City"
                      name="cityName"
                      required
                      value={formData.cityName}
                      onChange={handleChange}
                      disabled={!formData.stateCode || !locationData}
                      className={cn(fieldClass, 'appearance-none pr-10 disabled:cursor-not-allowed disabled:border-hairline-strong disabled:bg-sunken')}
                    >
                      <option value="" disabled>{formData.stateCode ? 'Select City' : 'Select State first'}</option>
                      {availableCities.map(city => (
                        <option key={city.name} value={city.name}>{city.name}</option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink" />
                  </div>
                </div>
              </fieldset>

              <Field id="partner-message" label="Anything else we should know? (Optional)" className="sm:col-span-2">
                <textarea
                  id="partner-message"
                  name="message"
                  rows="3"
                  value={formData.message}
                  onChange={handleChange}
                  placeholder="Specific challenges, preferred trial dates, etc."
                  className={cn(fieldClass, 'h-auto resize-none py-3')}
                ></textarea>
              </Field>

              <div className="pt-2 sm:col-span-2">
                <Button type="submit" className={cn(loudPrimary, 'w-full sm:w-auto')}>
                  <Send className="h-5 w-5" aria-hidden="true" />
                  Submit Request
                </Button>
              </div>
            </form>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
