import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/Tabs';
import AuditLog from '../../components/crm/AuditLog';
import FeeSettings from '../../components/crm/FeeSettings';
import InquirySettings from '../../components/crm/InquirySettings';
import PipelineSettings from '../../components/crm/PipelineSettings';
import TagSettings from '../../components/crm/TagSettings';
import TeamAccess from '../../components/crm/TeamAccess';
import WhatsAppSettings from '../../components/crm/comms/WhatsAppSettings';

// Each tab is shown only with its own capability; the server re-checks.
const TABS = [
  { key: 'pipeline', label: 'Pipeline', capability: 'crm.settings.manage' },
  { key: 'tags', label: 'Tags', capability: 'crm.settings.manage' },
  { key: 'inquiry', label: 'Inquiry form', capability: 'crm.settings.manage' },
  { key: 'fees', label: 'Fees', capability: 'crm.settings.manage' },
  { key: 'whatsapp', label: 'WhatsApp', capability: 'crm.settings.manage' },
  { key: 'team', label: 'Team access', capability: 'crm.permissions.manage' },
  { key: 'audit', label: 'Audit log', capability: 'crm.audit.read' },
];

export default function CrmSettings({ me }) {
  const tabs = TABS.filter((tab) => me.capabilities.includes(tab.capability));
  if (!tabs.length) return <p className="text-sm text-muted-foreground">Nothing to configure here yet.</p>;
  // `?tab=whatsapp` opens a tab directly (the WhatsApp health banner links here).
  const requested = new URLSearchParams(window.location.search).get('tab');
  const initial = tabs.some((tab) => tab.key === requested) ? requested : tabs[0].key;

  return (
    <Tabs defaultValue={initial} className="space-y-6">
      <TabsList className="overflow-x-auto rounded-t-xl">
        {tabs.map((tab) => <TabsTrigger key={tab.key} value={tab.key}>{tab.label}</TabsTrigger>)}
      </TabsList>
      <TabsContent value="pipeline"><PipelineSettings /></TabsContent>
      <TabsContent value="tags"><TagSettings /></TabsContent>
      <TabsContent value="inquiry"><InquirySettings /></TabsContent>
      <TabsContent value="fees"><FeeSettings timezone={me.school?.timezone} /></TabsContent>
      <TabsContent value="whatsapp"><WhatsAppSettings /></TabsContent>
      <TabsContent value="team"><TeamAccess myCapabilities={me.capabilities} /></TabsContent>
      <TabsContent value="audit"><AuditLog /></TabsContent>
    </Tabs>
  );
}
