import { useEffect, useState } from 'react';
import { Select } from '../ui/Select';
import { crmFetch } from '../../lib/crm/api';

/** School switch for platform staff. Lists schools and whether CRM is on. */
export default function CrmSchoolPicker({ value, onChange, className }) {
  const [schools, setSchools] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    crmFetch('schools', { schoolId: '' })
      .then((data) => { if (!cancelled) setSchools(data.items || []); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;

  return (
    <Select
      aria-label="School"
      className={className}
      value={value || ''}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="" disabled>Choose a school…</option>
      {schools.map((school) => (
        <option key={school.id} value={school.id}>
          {school.name}{school.crmEnabled ? '' : ' (CRM off)'}
        </option>
      ))}
    </Select>
  );
}
