import { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import SchoolLogin from './SchoolLogin';
import { apiGet } from '../lib/apiClient';

export default function DynamicSchoolLogin() {
  const { schoolSlug } = useParams();
  const [school, setSchool] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadSchool() {
      try {
        const data = await apiGet(`/api/auth/schools/${schoolSlug}`);
        setSchool(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    loadSchool();
  }, [schoolSlug]);

  if (loading) {
    return <div role="status" className="notebook-grid flex min-h-screen items-center justify-center text-[15px] font-semibold text-foreground-secondary">Loading...</div>;
  }

  if (error || !school) {
    return <Navigate to="/" replace />;
  }

  return <SchoolLogin school={school.display_name} subtitle="Student assessment reports" />;
}
