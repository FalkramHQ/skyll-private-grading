// Shared dashboard components used by RoleDashboards.js and AdminDashboard.js.
// Extracted from RoleDashboards.js to avoid circular imports.

import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { formatMathText } from './formatMathText';
import { styles } from './dashboardStyles';

export function Header({ school, name, onLogout, backLabel, onBack, onRefresh, refreshing, onProfile }) {
  return <View style={styles.header}>
    <View style={styles.headerTop}>
      {onBack ? <Pressable accessibilityRole="button" accessibilityLabel={backLabel || 'Back'} onPress={onBack} hitSlop={6} style={({ pressed }) => [styles.backButton, pressed && styles.togglePressed]}><Text style={styles.backButtonText}>{`‹ ${backLabel || 'Back'}`}</Text></Pressable> : <View />}
      <View style={styles.headerActions}>
        {onProfile ? <Pressable accessibilityRole="button" onPress={onProfile} hitSlop={10}><Text style={styles.link}>Profile</Text></Pressable> : null}
        {onRefresh ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(refreshing) }} disabled={refreshing} onPress={onRefresh} hitSlop={10}><Text style={styles.link}>{refreshing ? 'Refreshing...' : 'Refresh'}</Text></Pressable> : null}
        <Pressable accessibilityRole="button" onPress={onLogout} hitSlop={10}><Text style={styles.link}>Log out</Text></Pressable>
      </View>
    </View>
    <Text style={styles.eyebrow}>{school || 'SKYLL'}</Text>
    <Text style={styles.title}>{name}</Text>
  </View>;
}

export function Score({ score, total }) {
  const safeScore = Number(score) || 0;
  const safeTotal = Number(total) || 0;
  const percentage = safeTotal ? Math.round((safeScore / safeTotal) * 100) : 0;
  return <View style={styles.score}><Text style={styles.scoreValue}>{percentage}%</Text><Text style={styles.scoreCaption}>{`${safeScore}/${safeTotal}`}</Text></View>;
}

export function MathBody({ children, style }) {
  return <Text style={style}>{formatMathText(children)}</Text>;
}

// Persistent status shown when a dashboard is rendering cached data because the
// network revalidation failed (offline-first). Never conveyed by colour alone —
// the copy says "offline" and Retry is a labelled button (WCAG-friendly).
export function OfflineBanner({ onRetry, label }) {
  return <View style={styles.offlineBanner} accessibilityRole="alert">
    <Text style={styles.offlineBannerText}>{label || "You're offline — showing the last saved version"}</Text>
    {onRetry ? <Pressable accessibilityRole="button" accessibilityLabel="Retry loading the latest data" onPress={onRetry} hitSlop={8} style={styles.offlineRetry}><Text style={styles.offlineRetryText}>Retry</Text></Pressable> : null}
  </View>;
}

export function AnswerSheetGallery({ answerSheet }) {
  const [index, setIndex] = useState(0);
  const page = answerSheet.pages[index];
  if (!page) return null;
  return <View style={[styles.card, styles.cardLoud]}><View style={styles.questionHeader}><View style={styles.subjectCopy}><Text style={styles.eyebrow}>Handwritten answer sheet</Text><Text style={styles.cardTitle}>{answerSheet.subject}</Text></View><Text style={styles.pageCounter}>{`${index + 1}/${answerSheet.pages.length}`}</Text></View><Image source={{ uri: page.uri, headers: page.headers }} resizeMode="contain" style={styles.answerSheetImage} accessibilityLabel={`Handwritten answer sheet for ${answerSheet.subject}, page ${index + 1} of ${answerSheet.pages.length}`} /><View style={styles.galleryActions}><Pressable accessibilityRole="button" accessibilityLabel="Previous page" accessibilityState={{ disabled: index === 0 }} disabled={index === 0} onPress={() => setIndex((value) => value - 1)} style={[styles.galleryButton, index === 0 && styles.disabled]}><Text style={styles.secondaryButtonText}>Previous</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Next page" accessibilityState={{ disabled: index >= answerSheet.pages.length - 1 }} disabled={index >= answerSheet.pages.length - 1} onPress={() => setIndex((value) => value + 1)} style={[styles.galleryButton, index >= answerSheet.pages.length - 1 && styles.disabled]}><Text style={styles.secondaryButtonText}>Next</Text></Pressable></View></View>;
}
