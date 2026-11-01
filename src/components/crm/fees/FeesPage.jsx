// Fees section (CRM-017/018, CRM M2 phase 1, D8). The selected tab lives in
// the URL (`?tab=plans`) so links and the back button land on it.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../ui/Button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/Tabs';
import { localDate } from '../../../../shared/crm/time.js';
import DuesTab from './DuesTab';
import FeePlansTab from './FeePlansTab';
import { RecordPaymentDialog } from './PaymentDialogs';
import PaymentsTab from './PaymentsTab';
import { SendReminderButton } from '../comms/FeeReminders';

const TABS = [
  { key: 'dues', label: 'Dues' },
  { key: 'payments', label: 'Payments' },
  { key: 'plans', label: 'Fee plans' },
];

export default function FeesPage({ me }) {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((item) => item.key === params.get('tab')) ? params.get('tab') : 'dues';
  const [today] = useState(() => localDate(Date.now(), me.school.timezone));
  const [paying, setPaying] = useState(null);
  const [duesKey, setDuesKey] = useState(0);
  const canWrite = me.capabilities.includes('crm.finance.write');
  const canRemind = me.capabilities.includes('crm.comms.send');
  // Dues rows: Record payment (finance write) and Send reminder (comms send, D7).
  const recordAction = canWrite || canRemind
    ? (invoice) => (
      <span className="inline-flex flex-wrap justify-end gap-2">
        {canRemind && <SendReminderButton me={me} studentId={invoice.student.id} studentName={invoice.student.name} />}
        {canWrite && <Button size="sm" variant="outline" onClick={() => setPaying(invoice.student.id)}>Record payment</Button>}
      </span>
    )
    : undefined;

  return (
    <Tabs value={tab} onValueChange={(value) => setParams(value === 'dues' ? {} : { tab: value }, { replace: true })} className="space-y-6">
      <TabsList className="overflow-x-auto rounded-t-xl">
        {TABS.map((item) => <TabsTrigger key={item.key} value={item.key}>{item.label}</TabsTrigger>)}
      </TabsList>
      <TabsContent value="dues"><DuesTab key={duesKey} me={me} renderAction={recordAction} /></TabsContent>
      <TabsContent value="payments"><PaymentsTab /></TabsContent>
      <TabsContent value="plans"><FeePlansTab me={me} today={today} /></TabsContent>
      <RecordPaymentDialog
        open={Boolean(paying)}
        onOpenChange={(open) => !open && setPaying(null)}
        studentId={paying}
        onSaved={() => { setPaying(null); setDuesKey((key) => key + 1); }}
      />
    </Tabs>
  );
}
