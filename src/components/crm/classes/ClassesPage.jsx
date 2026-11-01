// Classes section (CRM-013…016, FLKRM-327, D12). The selected tab lives in
// the URL (`?tab=courses`) so links and the back button land on it.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/Tabs';
import { useClassesOptions } from '../../../lib/crm/classes';
import BatchesTab from './BatchesTab';
import CoursesTab from './CoursesTab';
import HolidaysCard from './HolidaysCard';
import InstructorsTab from './InstructorsTab';
import RoomsTab from './RoomsTab';
import SessionDialog from './SessionDialog';
import TimetableTab from './TimetableTab';

const TABS = [
  { key: 'batches', label: 'Batches' },
  { key: 'timetable', label: 'Timetable' },
  { key: 'courses', label: 'Courses' },
  { key: 'instructors', label: 'Instructors' },
  { key: 'rooms', label: 'Rooms & holidays' },
];

export default function ClassesPage({ me }) {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((item) => item.key === params.get('tab')) ? params.get('tab') : 'batches';
  const { status, options, error, reload } = useClassesOptions();
  const [openSession, setOpenSession] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <Tabs value={tab} onValueChange={(value) => setParams(value === 'batches' ? {} : { tab: value }, { replace: true })} className="space-y-6">
      <TabsList className="overflow-x-auto rounded-t-xl">
        {TABS.map((item) => <TabsTrigger key={item.key} value={item.key}>{item.label}</TabsTrigger>)}
      </TabsList>
      {status === 'error' && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
      <TabsContent value="batches"><BatchesTab me={me} options={options} onOptionsChanged={reload} /></TabsContent>
      <TabsContent value="timetable"><TimetableTab me={me} options={options} onOpenSession={setOpenSession} refreshKey={refreshKey} /></TabsContent>
      <TabsContent value="courses"><CoursesTab me={me} options={options} onOptionsChanged={reload} /></TabsContent>
      <TabsContent value="instructors"><InstructorsTab me={me} /></TabsContent>
      <TabsContent value="rooms" className="space-y-6">
        <RoomsTab me={me} onOptionsChanged={reload} />
        <HolidaysCard me={me} onChanged={() => setRefreshKey((key) => key + 1)} />
      </TabsContent>
      <SessionDialog session={openSession} me={me} options={options} onOpenChange={(open) => !open && setOpenSession(null)} onChanged={() => setRefreshKey((key) => key + 1)} />
    </Tabs>
  );
}
