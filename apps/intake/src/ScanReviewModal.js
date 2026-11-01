import { useEffect, useMemo, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { nextIssueIndex, summarizeScanReview, warningCategoryFor } from './scanReview';
import { palette, type, radius, shadow, pressedSink } from './theme';
import { SafeAreaView, InsetBottom, spacing } from './safeArea';

export function ScanReviewModal({ pendingScan, busy = false, onCancel, onAddPages, onConfirm, onRemovePage, onRetakePage }) {
  const [selectedIndex, setSelectedIndex] = useState(null);
  // FLKRM-110: pages with unresolved warnings need an explicit acknowledgement
  // before upload. The acknowledgement is keyed to the exact set of flagged
  // pages, so removing, retaking, or adding pages revokes a stale "use anyway"
  // rather than silently carrying it across to a different set of warnings.
  const [acknowledgedSignature, setAcknowledgedSignature] = useState('');
  const pages = useMemo(() => pendingScan?.pages || [], [pendingScan?.pages]);
  const summary = useMemo(() => summarizeScanReview(pages), [pages]);
  const issueSignature = summary.issueIndexes.join(',');

  useEffect(() => {
    if (!pendingScan) setSelectedIndex(null);
    else if (selectedIndex != null && selectedIndex >= pages.length) setSelectedIndex(pages.length ? pages.length - 1 : null);
  }, [pendingScan, pages.length, selectedIndex]);

  useEffect(() => {
    if (!pendingScan) setAcknowledgedSignature('');
  }, [pendingScan]);

  const selectedPage = selectedIndex == null ? null : pages[selectedIndex];
  const statusText = summary.warningCount
    ? `${summary.warningCount} of ${summary.pageCount} pages need attention`
    : `All ${summary.pageCount} pages ready for OCR`;
  const warningAcknowledged = !summary.warningCount || acknowledgedSignature === issueSignature;

  function removeSelected() {
    if (selectedIndex == null) return;
    onRemovePage(selectedIndex);
    if (pages.length <= 1) setSelectedIndex(null);
    else if (selectedIndex === pages.length - 1) setSelectedIndex(selectedIndex - 1);
  }

  const firstIssueIndex = summary.issueIndexes.length ? summary.issueIndexes[0] : null;
  const firstIssue = firstIssueIndex == null ? null : pages[firstIssueIndex];
  const firstIssueKind = firstIssue ? warningCategoryFor(firstIssue.qualityNote) : null;
  const saveBlocked = busy || !pages.length || !warningAcknowledged;

  return <Modal visible={Boolean(pendingScan)} animationType="slide" onRequestClose={onCancel}>
    <SafeAreaView style={styles.page} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel scan review" onPress={onCancel} style={({ pressed }) => [styles.headerButton, pressed && styles.pressedDim]}><Text style={styles.headerButtonText}>Cancel</Text></Pressable>
        <View style={styles.headerCopy}>
          <Text numberOfLines={1} style={styles.student}>{pendingScan?.student?.name}</Text>
          <Text style={styles.title}>{pendingScan?.replaceExisting ? 'Review replacement scan' : 'Review scan'}</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      {selectedPage ? <>
        <View style={styles.previewBody}>
          <View style={[styles.previewFrame, selectedPage.needsReview && styles.previewFrameWarning]}>
            <Image source={{ uri: selectedPage.uri }} resizeMode="contain" style={styles.previewImage} accessibilityLabel={`Scanned page ${selectedIndex + 1}, ${selectedPage.needsReview ? 'needs attention' : 'ready for OCR'}`} />
          </View>
          <View style={styles.previewHeading}>
            <View style={styles.flex}>
              <Text style={styles.previewTitle}>Page {selectedIndex + 1} of {pages.length}</Text>
              <Text style={selectedPage.needsReview ? styles.warningText : styles.readyText}>{selectedPage.qualityNote || 'Ready for OCR'}</Text>
            </View>
            <PagePill page={selectedPage} />
          </View>
        </View>
        <InsetBottom style={styles.previewActions}>
          <View style={styles.actionRow}>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: selectedIndex === 0 }} disabled={selectedIndex === 0} style={({ pressed }) => [styles.smallButton, selectedIndex === 0 && styles.disabled, pressed && styles.pressedDim]} onPress={() => setSelectedIndex(selectedIndex - 1)}><Text style={styles.buttonText}>Previous</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: selectedIndex >= pages.length - 1 }} disabled={selectedIndex >= pages.length - 1} style={({ pressed }) => [styles.smallButton, selectedIndex >= pages.length - 1 && styles.disabled, pressed && styles.pressedDim]} onPress={() => setSelectedIndex(selectedIndex + 1)}><Text style={styles.buttonText}>Next</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !summary.warningCount }} disabled={!summary.warningCount} style={({ pressed }) => [styles.smallButton, !summary.warningCount && styles.disabled, pressed && styles.pressedDim]} onPress={() => setSelectedIndex(nextIssueIndex(pages, selectedIndex))}><Text style={styles.buttonText}>Next issue</Text></Pressable>
          </View>
          <View style={styles.actionRow}>
            <Pressable accessibilityRole="button" style={({ pressed }) => [styles.inkButton, styles.rowButton, pressed && styles.pressedDim]} onPress={() => onRetakePage(selectedIndex)}><Text style={styles.inkButtonText}>Retake page</Text></Pressable>
            <Pressable accessibilityRole="button" style={({ pressed }) => [styles.secondaryButton, styles.rowButton, pressed && styles.pressedDim]} onPress={removeSelected}><Text style={styles.removeText}>Remove page</Text></Pressable>
          </View>
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryPressed]} onPress={() => setSelectedIndex(null)}><Text style={styles.primaryText}>Back to all pages</Text></Pressable>
        </InsetBottom>
      </> : <>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.pageCount}>{summary.pageCount} pages scanned</Text>
          <View accessibilityRole="text" style={[styles.status, summary.warningCount ? styles.warningStatus : styles.readyStatus]}>
            <Text style={summary.warningCount ? styles.warningStatusText : styles.readyStatusText}>{summary.warningCount ? '⚑ ' : '✓ '}{statusText}</Text>
          </View>

          {firstIssue ? <View style={styles.problemCard}>
            {summary.warningCount > 1 ? <Text style={styles.problemCount}>{`Problem 1 of ${summary.warningCount}`}</Text> : null}
            <Text style={styles.problemTitle}>{`Page ${firstIssueIndex + 1} ${PROBLEM_TITLE[firstIssueKind] || PROBLEM_TITLE.other}`}</Text>
            <Text style={styles.problemBody}>{firstIssue.qualityNote || 'Take a closer look before saving.'} Retaking takes a few seconds and gives the clearest marks.</Text>
            <View style={styles.actionRow}>
              <Pressable accessibilityRole="button" style={({ pressed }) => [styles.inkButton, styles.rowButton, pressed && styles.pressedDim]} onPress={() => onRetakePage(firstIssueIndex)}><Text style={styles.inkButtonText}>{`Retake page ${firstIssueIndex + 1}`}</Text></Pressable>
              <Pressable accessibilityRole="button" style={({ pressed }) => [styles.secondaryButton, styles.rowButton, pressed && styles.pressedDim]} onPress={() => setSelectedIndex(firstIssueIndex)}><Text style={styles.buttonText}>Look closer</Text></Pressable>
            </View>
          </View> : null}

          <View style={styles.grid}>
            {pages.map((page, index) => <Pressable key={page.uri || `page-${index}`} accessibilityRole="button" accessibilityLabel={`Page ${index + 1}, ${page.needsReview ? 'needs attention' : 'ready for OCR'}`} style={({ pressed }) => [styles.thumbnail, pressed && styles.pressedDim]} onPress={() => setSelectedIndex(index)}>
              <View style={[styles.thumbnailFrame, page.needsReview && styles.warningThumbnail]}>
                <Image source={{ uri: page.uri }} resizeMode="cover" style={styles.thumbnailImage} />
              </View>
              <View style={styles.thumbnailMeta}>
                <Text style={styles.thumbnailLabel}>Page {index + 1}</Text>
                <PagePill page={page} />
              </View>
            </Pressable>)}
          </View>

          {summary.categories.length ? <View style={styles.categoryList}>
            <Text style={styles.sectionLabel}>Warnings by type</Text>
            {summary.categories.map((category) => <Pressable key={category.key} accessibilityRole="button" accessibilityLabel={`${category.label}, ${category.pageIndexes.length} pages`} style={({ pressed }) => [styles.categoryRow, pressed && styles.pressedDim]} onPress={() => setSelectedIndex(category.pageIndexes[0])}>
              <Text style={styles.categoryText}>{category.label}</Text>
              <Text style={styles.categoryCount}>{category.pageIndexes.length} · View</Text>
            </Pressable>)}
          </View> : null}
        </ScrollView>
        <InsetBottom style={styles.footer}>
          {summary.warningCount ? <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: warningAcknowledged }}
            accessibilityLabel={`I have checked the ${summary.warningCount} page${summary.warningCount === 1 ? '' : 's'} that need attention and want to upload anyway`}
            style={[styles.acknowledgeRow, warningAcknowledged && styles.acknowledgeRowChecked]}
            onPress={() => setAcknowledgedSignature((current) => (current === issueSignature ? '' : issueSignature))}
          >
            <View style={[styles.checkbox, warningAcknowledged && styles.checkboxChecked]}>{warningAcknowledged ? <Text style={styles.checkboxMark}>✓</Text> : null}</View>
            <Text style={styles.acknowledgeText}>{`I have reviewed the ${summary.warningCount} page${summary.warningCount === 1 ? '' : 's'} that need attention`}</Text>
          </Pressable> : null}
          <View style={styles.footerRow}>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} style={({ pressed }) => [styles.secondaryButton, styles.addButton, busy && styles.disabled, pressed && styles.pressedDim]} onPress={onAddPages}><Text style={styles.buttonText}>Add pages</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={pendingScan?.replaceExisting ? `Replace with ${pages.length} pages` : `Use ${pages.length} pages`} disabled={saveBlocked} accessibilityState={{ disabled: saveBlocked }} style={({ pressed }) => [styles.primaryButton, styles.saveButton, saveBlocked && styles.primaryDisabled, pressed && !saveBlocked && styles.primaryPressed]} onPress={onConfirm}><Text style={saveBlocked ? styles.primaryTextDisabled : styles.primaryText}>{busy ? 'Saving...' : pendingScan?.replaceExisting ? `Replace with ${pages.length} page(s)` : `Use ${pages.length} page(s)`}</Text></Pressable>
          </View>
          {!busy && pages.length && !warningAcknowledged ? <Text style={styles.footerHint}>Retake the flagged pages, or tick the box above to save them as they are.</Text> : null}
        </InsetBottom>
      </>}
    </SafeAreaView>
  </Modal>;
}

// Short, word-first page state. Never colour alone.
const PILL_LABEL = { blurry: 'Blurry', resolution: 'Low res', incomplete: 'Unclear', small: 'Low detail', other: 'Check' };
const PROBLEM_TITLE = {
  blurry: 'may be blurry',
  resolution: 'is low resolution',
  incomplete: 'has very little readable text',
  small: 'captured very little detail',
  other: 'needs a look',
};

function PagePill({ page }) {
  if (!page?.needsReview) return <View style={[styles.pill, styles.pillReady]}><Text style={styles.pillText}>✓ Ready</Text></View>;
  return <View style={[styles.pill, styles.pillWarning]}><Text style={styles.pillText}>{`⚑ ${PILL_LABEL[warningCategoryFor(page.qualityNote)] || PILL_LABEL.other}`}</Text></View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper },
  header: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 2, borderColor: palette.ink, backgroundColor: palette.paper },
  headerButton: { minHeight: 44, minWidth: 84, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, backgroundColor: palette.white },
  headerButtonText: { ...type.semibold, color: palette.ink, fontSize: 15 },
  headerCopy: { flex: 1, alignItems: 'center' },
  headerSpacer: { width: 84 },
  student: { ...type.display, color: palette.ink, fontSize: 19, letterSpacing: -0.3 },
  title: { ...type.regular, color: palette.textSecondary, fontSize: 14, marginTop: 1 },
  content: { padding: spacing.card, paddingBottom: 28, gap: 14 },
  pageCount: { ...type.display, fontVariant: ['tabular-nums'], color: palette.ink, fontSize: 26, letterSpacing: -0.6 },
  status: { borderWidth: 2, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14 },
  readyStatus: { backgroundColor: palette.successSoft, borderColor: palette.success },
  warningStatus: { backgroundColor: palette.cautionSoft, borderColor: palette.caution },
  readyStatusText: { ...type.bold, color: palette.success, fontSize: 15 },
  warningStatusText: { ...type.bold, color: palette.caution, fontSize: 15 },
  problemCard: { backgroundColor: palette.white, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.card, padding: 14, gap: 8 },
  problemCount: { ...type.semibold, color: palette.textSecondary, fontSize: 13 },
  problemTitle: { ...type.display, color: palette.ink, fontSize: 18, lineHeight: 23, letterSpacing: -0.3 },
  problemBody: { ...type.regular, color: palette.textSecondary, fontSize: 15, lineHeight: 22 },
  categoryList: { gap: 6 },
  sectionLabel: { ...type.semibold, color: palette.textSecondary, fontSize: 13 },
  categoryRow: { minHeight: 44, backgroundColor: palette.white, borderWidth: 1, borderColor: palette.hairline, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: radius.button },
  categoryText: { ...type.semibold, color: palette.ink, fontSize: 14, flex: 1 },
  categoryCount: { ...type.bold, color: palette.action, fontSize: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 14 },
  thumbnail: { width: '48%' },
  thumbnailFrame: { backgroundColor: palette.white, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, overflow: 'hidden' },
  warningThumbnail: { borderWidth: 3, borderColor: palette.coral, boxShadow: shadow.lg },
  thumbnailImage: { width: '100%', aspectRatio: 0.72, backgroundColor: palette.sunken },
  thumbnailMeta: { paddingTop: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  thumbnailLabel: { ...type.bold, color: palette.ink, fontSize: 14 },
  pill: { borderWidth: 1.5, borderColor: palette.ink, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 1 },
  pillReady: { backgroundColor: palette.lime },
  pillWarning: { backgroundColor: palette.coral },
  pillText: { ...type.bold, color: palette.ink, fontSize: 13 },
  footer: { paddingHorizontal: spacing.card, paddingTop: 12, backgroundColor: palette.white, borderTopWidth: 2, borderColor: palette.ink, gap: 10 },
  footerRow: { flexDirection: 'row', gap: 10 },
  footerHint: { ...type.regular, color: palette.textSecondary, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  acknowledgeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 2, borderColor: palette.caution, borderRadius: radius.control, backgroundColor: palette.cautionSoft },
  acknowledgeRowChecked: { borderColor: palette.ink },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: palette.ink, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.white },
  checkboxChecked: { backgroundColor: palette.ink },
  checkboxMark: { ...type.bold, color: palette.lime, fontSize: 15, lineHeight: 18 },
  acknowledgeText: { ...type.semibold, flex: 1, color: palette.caution, fontSize: 14, lineHeight: 19 },
  primaryButton: { minHeight: 54, backgroundColor: palette.action, borderWidth: 2, borderColor: palette.ink, borderRadius: 14, boxShadow: shadow.lg, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', marginTop: 10, marginRight: 4 },
  primaryPressed: pressedSink,
  primaryDisabled: { backgroundColor: palette.sunken, borderColor: palette.hairline, boxShadow: [] },
  primaryText: { ...type.bold, color: palette.white, fontSize: 16 },
  primaryTextDisabled: { ...type.bold, color: palette.muted, fontSize: 16 },
  saveButton: { flex: 1, marginTop: 0 },
  addButton: { width: 120, minHeight: 54, borderRadius: 14 },
  secondaryButton: { minHeight: 48, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, backgroundColor: palette.white, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  inkButton: { minHeight: 48, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, backgroundColor: palette.ink, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  inkButtonText: { ...type.bold, color: palette.white, fontSize: 15 },
  rowButton: { flex: 1 },
  buttonText: { ...type.semibold, color: palette.ink, fontSize: 15 },
  removeText: { ...type.bold, color: palette.danger, fontSize: 15 },
  disabled: { opacity: 0.45 },
  pressedDim: { opacity: 0.7 },
  previewBody: { flex: 1, padding: spacing.card },
  previewFrame: { flex: 1, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, overflow: 'hidden', backgroundColor: palette.sunken },
  previewFrameWarning: { borderWidth: 3, borderColor: palette.coral },
  previewImage: { flex: 1, width: '100%' },
  previewHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 12 },
  previewTitle: { ...type.display, color: palette.ink, fontSize: 19, letterSpacing: -0.3 },
  warningText: { ...type.semibold, color: palette.caution, fontSize: 14, lineHeight: 19, marginTop: 4 },
  readyText: { ...type.semibold, color: palette.success, fontSize: 14, marginTop: 4 },
  flex: { flex: 1 },
  previewActions: { paddingHorizontal: spacing.card, paddingTop: 4, backgroundColor: palette.white, borderTopWidth: 2, borderColor: palette.ink },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  smallButton: { flex: 1, minHeight: 44, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, backgroundColor: palette.white, paddingVertical: 9, alignItems: 'center', justifyContent: 'center' },
});
