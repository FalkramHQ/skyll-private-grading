import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import NotebookLoader from './NotebookLoader';
import { trackIntakeEvent } from './analytics';
import { palette as colors, type, radius, shadow, pressedSink } from './theme';
import { spacing } from './safeArea';

const STUDENT_PASSWORD = /^[A-Za-z0-9]{6}$/;
const STAFF_PASSWORD = /^[A-Za-z0-9_-]{12,24}$/;

function Field({ label, children }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Input(props) {
  return (
    <TextInput
      {...props}
      placeholderTextColor={colors.muted}
      style={[styles.input, props.style]}
    />
  );
}

function PasswordForm({ policy, onSubmit, busy, message }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [localError, setLocalError] = useState('');

  async function handleSubmit() {
    setLocalError('');
    if (policy === 'student' && !STUDENT_PASSWORD.test(newPassword)) {
      setLocalError('Use exactly 6 letters or digits.');
      return;
    }
    if (policy === 'staff' && !STAFF_PASSWORD.test(newPassword)) {
      setLocalError('Use 12–24 letters, digits, hyphens, or underscores.');
      return;
    }
    if (newPassword !== confirmation) {
      setLocalError('New password and confirmation do not match.');
      return;
    }
    const ok = await onSubmit(currentPassword, newPassword);
    if (ok) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Account security</Text>
      <Text style={styles.body}>
        {policy === 'student'
          ? 'Use exactly 6 letters or digits. Changing your password signs you out.'
          : 'Use 12–24 letters, digits, hyphens, or underscores. Changing your password signs you out of every device.'}
      </Text>
      <Field label="Current password">
        <Input
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={currentPassword}
          onChangeText={setCurrentPassword}
          placeholder="Current password"
        />
      </Field>
      <Field label="New password">
        <Input
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={newPassword}
          onChangeText={setNewPassword}
          placeholder="New password"
        />
      </Field>
      <Field label="Confirm new password">
        <Input
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={confirmation}
          onChangeText={setConfirmation}
          placeholder="Confirm new password"
        />
      </Field>
      {(localError || message) ? <Text style={localError ? styles.errorText : styles.successText}>{localError || message}</Text> : null}
      <Pressable disabled={busy} style={({ pressed }) => [styles.primary, busy && styles.disabled, pressed && styles.pressed]} onPress={handleSubmit}>
        <Text style={styles.primaryText}>{busy ? 'Saving...' : 'Change password'}</Text>
      </Pressable>
    </View>
  );
}

function ProfileHeader({ title, subtitle, onBack, onLogout }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <Pressable accessibilityRole="button" onPress={onBack} hitSlop={6} style={styles.backButton}><Text style={styles.backButtonText}>‹ Back</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={onLogout} hitSlop={6} style={styles.headerLink}><Text style={styles.link}>Log out</Text></Pressable>
      </View>
      <Text style={styles.eyebrow}>ACCOUNT</Text>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.caption}>{subtitle}</Text> : null}
    </View>
  );
}

export function StudentProfileScreen({ api, accessToken, onBack, onLogout }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api('/api/auth/profile', {}, accessToken);
      setProfile(result.profile);
    } catch (loadError) {
      setError(loadError.message || 'Could not load your profile');
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [api, accessToken]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    trackIntakeEvent(api, accessToken, 'profile_viewed', { surface: 'intake_student' });
  }, [api, accessToken]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <NotebookLoader size={48} />
        <Text style={styles.caption}>Loading profile...</Text>
      </View>
    );
  }

  if (!profile) {
    return (
      <ScrollView style={styles.page} contentContainerStyle={styles.content}>
        <ProfileHeader title="Profile" onBack={onBack} onLogout={onLogout} />
        <View style={styles.card}>
          <Text style={styles.errorText}>{error || 'Profile unavailable'}</Text>
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressed]} onPress={load}><Text style={styles.primaryText}>Try again</Text></Pressable>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <ProfileHeader title={profile.name || 'My profile'} subtitle={profile.school} onBack={onBack} onLogout={onLogout} />
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Academic details</Text>
        <Text style={styles.metaRow}>Username · {profile.username || '—'}</Text>
        <Text style={styles.metaRow}>Class · {profile.class || '—'}</Text>
        <Text style={styles.metaRow}>Board · {profile.board || '—'}</Text>
        <Text style={styles.metaRow}>Batches · {(profile.batches || []).join(', ') || '—'}</Text>
        <Text style={styles.body}>Ask your school administrator if any of these details need correcting. Password resets are managed by your school.</Text>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </ScrollView>
  );
}

const blankBatch = { name: '', grade: '', board: '', stream: '', academicYear: '' };
const blankStudent = { name: '', username: '', standard: '', batchIds: [] };

export function SchoolProfileScreen({ api, accessToken, onBack, onLogout }) {
  const [profile, setProfile] = useState(null);
  const [roster, setRoster] = useState({ batches: [], students: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [batchDraft, setBatchDraft] = useState(null);
  const [studentDraft, setStudentDraft] = useState(null);
  const [credentials, setCredentials] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [profileResponse, rosterResponse] = await Promise.all([
        api('/api/auth/teacher-profile', {}, accessToken),
        api('/api/auth/teacher-roster', {}, accessToken),
      ]);
      setProfile(profileResponse.profile);
      setRoster({ batches: rosterResponse.batches || [], students: rosterResponse.students || [] });
    } catch (loadError) {
      setError(loadError.message || 'Could not load school profile');
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [api, accessToken]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    trackIntakeEvent(api, accessToken, 'school_profile_viewed', { surface: 'intake_admin' });
  }, [api, accessToken]);

  async function changePassword(currentPassword, newPassword) {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      }, accessToken);
      setMessage(result.message || 'Password changed. Please sign in again.');
      setTimeout(() => { onLogout(); }, 1200);
      return true;
    } catch (changeError) {
      setError(changeError.message || 'Could not change password');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function mutate(method, body) {
    setBusy(true);
    setError('');
    try {
      const result = await api('/api/auth/teacher-roster', {
        method,
        body: JSON.stringify(body),
      }, accessToken);
      setRoster({ batches: result.batches || [], students: result.students || [] });
      return result;
    } catch (mutationError) {
      setError(mutationError.message || 'Could not update the roster');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveBatch() {
    if (!batchDraft?.name?.trim()) return setError('Batch name is required');
    const result = await mutate(batchDraft.id ? 'PATCH' : 'POST', { resource: 'batch', ...batchDraft });
    if (result) setBatchDraft(null);
  }

  async function saveStudent() {
    if (!studentDraft?.name?.trim()) return setError('Student name is required');
    if (!studentDraft.batchIds?.length) return setError('Select at least one batch');
    const result = await mutate(studentDraft.id ? 'PATCH' : 'POST', { resource: 'student', ...studentDraft });
    if (result) {
      if (result.result?.password) setCredentials(result.result);
      setStudentDraft(null);
    }
  }

  function confirmArchive(resource, item) {
    Alert.alert(
      `Archive ${item.name}?`,
      'Historical assessment data will be retained.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Archive', style: 'destructive', onPress: () => mutate('DELETE', { resource, id: item.id }) },
      ],
    );
  }

  async function shareCredentials() {
    if (!credentials) return;
    const text = `Username: ${credentials.username}\nTemporary password: ${credentials.password}`;
    try {
      await Share.share({ message: text });
    } catch {
      Alert.alert('Credentials', text);
    }
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <NotebookLoader size={48} />
        <Text style={styles.caption}>Loading school profile...</Text>
      </View>
    );
  }

  if (!profile) {
    return (
      <ScrollView style={styles.page} contentContainerStyle={styles.content}>
        <ProfileHeader title="School profile" onBack={onBack} onLogout={onLogout} />
        <View style={styles.card}>
          <Text style={styles.errorText}>{error || 'Profile unavailable'}</Text>
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressed]} onPress={load}><Text style={styles.primaryText}>Try again</Text></Pressable>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <ProfileHeader title={profile.name || 'School profile'} subtitle={`${profile.school || ''} · ${profile.username || ''}`.trim()} onBack={onBack} onLogout={onLogout} />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <PasswordForm policy="staff" onSubmit={changePassword} busy={busy} message={message} />

      {credentials ? (
        <View style={[styles.card, styles.credentialsCard]}>
          <Text style={styles.cardTitle}>New student credentials</Text>
          <Text style={styles.body}>Username: <Text style={styles.strong}>{credentials.username}</Text></Text>
          <Text style={styles.body}>Temporary password: <Text style={styles.strong}>{credentials.password}</Text></Text>
          <Text style={styles.caption}>Copy these now. The temporary password is shown only once.</Text>
          <Pressable style={styles.secondary} onPress={shareCredentials}><Text style={styles.secondaryText}>Share credentials</Text></Pressable>
          <Pressable style={styles.textAction} onPress={() => setCredentials(null)}><Text style={styles.link}>Dismiss</Text></Pressable>
        </View>
      ) : null}

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>Batches</Text>
            <Text style={styles.body}>Create and maintain your school’s batches.</Text>
          </View>
          <Pressable style={styles.compact} onPress={() => setBatchDraft({ ...blankBatch })}>
            <Text style={styles.compactText}>Add</Text>
          </Pressable>
        </View>
        {batchDraft ? (
          <View style={styles.editor}>
            <Field label="Batch name"><Input value={batchDraft.name} onChangeText={(name) => setBatchDraft({ ...batchDraft, name })} /></Field>
            <Field label="Grade"><Input value={batchDraft.grade} onChangeText={(grade) => setBatchDraft({ ...batchDraft, grade })} /></Field>
            <Field label="Board"><Input value={batchDraft.board} onChangeText={(board) => setBatchDraft({ ...batchDraft, board })} /></Field>
            <Field label="Stream"><Input value={batchDraft.stream} onChangeText={(stream) => setBatchDraft({ ...batchDraft, stream })} /></Field>
            <Field label="Academic year"><Input value={batchDraft.academicYear} placeholder="2026–27" onChangeText={(academicYear) => setBatchDraft({ ...batchDraft, academicYear })} /></Field>
            <View style={styles.row}>
              <Pressable disabled={busy} style={({ pressed }) => [styles.primary, styles.flex, busy && styles.disabled, pressed && styles.pressed]} onPress={saveBatch}>
                <Text style={styles.primaryText}>{busy ? 'Saving...' : 'Save batch'}</Text>
              </Pressable>
              <Pressable style={[styles.secondary, styles.flex]} onPress={() => setBatchDraft(null)}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {roster.batches.map((batch) => (
          <View key={batch.id} style={styles.listRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.listTitle}>{batch.name}</Text>
              <Text style={styles.caption}>{[batch.grade, batch.board, batch.stream, batch.academicYear, `${batch.studentCount || 0} students`].filter(Boolean).join(' · ')}</Text>
            </View>
            <Pressable onPress={() => setBatchDraft({ ...batch })} hitSlop={8}><Text style={styles.link}>Edit</Text></Pressable>
            <Pressable onPress={() => confirmArchive('batch', batch)} hitSlop={8}><Text style={styles.danger}>Archive</Text></Pressable>
          </View>
        ))}
        {!roster.batches.length ? <Text style={styles.caption}>No active batches yet.</Text> : null}
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>Students</Text>
            <Text style={styles.body}>Add students to active batches and keep the roster up to date.</Text>
          </View>
          <Pressable style={styles.compact} onPress={() => setStudentDraft({ ...blankStudent })}>
            <Text style={styles.compactText}>Add</Text>
          </Pressable>
        </View>
        {studentDraft ? (
          <View style={styles.editor}>
            <Field label="Student name"><Input value={studentDraft.name} onChangeText={(name) => setStudentDraft({ ...studentDraft, name })} /></Field>
            <Field label="Username (optional)">
              <Input
                value={studentDraft.username}
                autoCapitalize="none"
                maxLength={6}
                placeholder="Generated if blank"
                onChangeText={(username) => setStudentDraft({ ...studentDraft, username: username.toLowerCase() })}
              />
            </Field>
            <Field label="Class / grade"><Input value={studentDraft.standard} onChangeText={(standard) => setStudentDraft({ ...studentDraft, standard })} /></Field>
            <Text style={styles.fieldLabel}>Active batches</Text>
            {roster.batches.map((batch) => {
              const selected = studentDraft.batchIds.includes(batch.id);
              return (
                <Pressable
                  key={batch.id}
                  style={[styles.checkRow, selected && styles.checkRowActive]}
                  onPress={() => setStudentDraft({
                    ...studentDraft,
                    batchIds: selected
                      ? studentDraft.batchIds.filter((id) => id !== batch.id)
                      : [...studentDraft.batchIds, batch.id],
                  })}
                >
                  <Text style={styles.checkMark}>{selected ? '✓' : ''}</Text>
                  <Text style={styles.listTitle}>{batch.name}{batch.grade ? ` · ${batch.grade}` : ''}</Text>
                </Pressable>
              );
            })}
            {!roster.batches.length ? <Text style={styles.caption}>Create a batch before adding a student.</Text> : null}
            <View style={styles.row}>
              <Pressable disabled={busy || !studentDraft.batchIds.length} style={[styles.primary, styles.flex, (busy || !studentDraft.batchIds.length) && styles.disabled]} onPress={saveStudent}>
                <Text style={styles.primaryText}>{busy ? 'Saving...' : 'Save student'}</Text>
              </Pressable>
              <Pressable style={[styles.secondary, styles.flex]} onPress={() => setStudentDraft(null)}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {roster.students.map((student) => (
          <View key={student.id} style={styles.listRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.listTitle}>{student.name}</Text>
              <Text style={styles.caption}>{[student.username, (student.batches || []).join(', ')].filter(Boolean).join(' · ') || '—'}</Text>
            </View>
            <Pressable onPress={() => setStudentDraft({ ...student, standard: student.standard || '' })} hitSlop={8}><Text style={styles.link}>Edit</Text></Pressable>
            <Pressable onPress={() => confirmArchive('student', student)} hitSlop={8}><Text style={styles.danger}>Archive</Text></Pressable>
          </View>
        ))}
        {!roster.students.length ? <Text style={styles.caption}>No active students yet.</Text> : null}
      </View>
    </ScrollView>
  );
}

// Quiet volume (settings): paper page, white cards with hairlines; only the
// primary button carries the ink border and hard shadow.
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  content: { padding: spacing.gutter, paddingBottom: spacing.contentBottom + 24 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: colors.paper },
  header: { marginBottom: 18 },
  headerTop: { minHeight: 44, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  backButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderWidth: 2, borderColor: colors.ink, borderRadius: radius.control, backgroundColor: colors.white },
  backButtonText: { ...type.bold, color: colors.ink, fontSize: 15 },
  headerLink: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  eyebrow: { ...type.semibold, color: colors.textSecondary, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  title: { ...type.display, color: colors.ink, fontSize: 30, lineHeight: 34, letterSpacing: -0.7, marginTop: 4 },
  caption: { ...type.regular, color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  link: { ...type.bold, color: colors.action, fontSize: 14 },
  danger: { ...type.bold, color: colors.danger, fontSize: 14, marginLeft: 14 },
  card: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.hairline, borderRadius: radius.card, padding: 16, marginBottom: 14 },
  credentialsCard: { borderColor: colors.caution, borderWidth: 2, backgroundColor: colors.cautionSoft },
  cardTitle: { ...type.display, color: colors.ink, fontSize: 19, lineHeight: 24, letterSpacing: -0.3 },
  body: { ...type.regular, color: colors.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 6 },
  strong: { ...type.bold, color: colors.ink },
  metaRow: { ...type.semibold, color: colors.ink, fontSize: 15, marginTop: 10 },
  field: { marginTop: 12 },
  fieldLabel: { ...type.semibold, color: colors.ink, fontSize: 14, marginBottom: 6, marginTop: 8 },
  input: { ...type.regular, minHeight: 48, borderWidth: 1, borderColor: colors.hairlineStrong, borderRadius: radius.button, paddingHorizontal: 12, paddingVertical: 11, color: colors.ink, fontSize: 16, backgroundColor: colors.white },
  primary: { minHeight: 48, justifyContent: 'center', backgroundColor: colors.action, borderWidth: 2, borderColor: colors.ink, borderRadius: radius.button, boxShadow: shadow.md, alignItems: 'center', paddingVertical: 12, marginTop: 14, marginRight: 3 },
  primaryText: { ...type.bold, color: colors.white, fontSize: 15 },
  secondary: { minHeight: 48, justifyContent: 'center', borderWidth: 1, borderColor: colors.hairlineStrong, borderRadius: radius.button, alignItems: 'center', paddingVertical: 11, marginTop: 10, backgroundColor: colors.white },
  secondaryText: { ...type.semibold, color: colors.ink, fontSize: 15 },
  pressed: pressedSink,
  disabled: { opacity: 0.5 },
  errorText: { ...type.semibold, color: colors.danger, fontSize: 14, marginTop: 10 },
  successText: { ...type.semibold, color: colors.success, fontSize: 14, marginTop: 10 },
  rowBetween: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  row: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  compact: { minHeight: 40, justifyContent: 'center', borderWidth: 1, borderColor: colors.hairlineStrong, borderRadius: radius.button, paddingHorizontal: 14, backgroundColor: colors.white },
  compactText: { ...type.bold, color: colors.action, fontSize: 14 },
  editor: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.hairline, paddingTop: 8 },
  listRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.hairline },
  listTitle: { ...type.bold, color: colors.ink, fontSize: 15 },
  checkRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.hairline, borderRadius: radius.button, padding: 10, marginTop: 8, backgroundColor: colors.white },
  checkRowActive: { borderColor: colors.ink, borderWidth: 2, padding: 9, backgroundColor: colors.actionTint },
  checkMark: { ...type.bold, width: 18, color: colors.action },
  textAction: { minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: 4 },
});
