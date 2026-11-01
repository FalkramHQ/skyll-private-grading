import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

// Push registration for the intake app. Every entry point is guarded so that a
// missing native module, Expo Go, a simulator, a denied permission, or any
// device error resolves to a no-op — notifications must never block sign-in,
// scanning, or report viewing. The token it returns is reported to
// /api/intake/devices and stored on intake_installations.expo_push_token, which
// the OCI worker resolves when draining the push outbox (api/_lib/pushOutbox.js).

export const NOTIFICATION_CHANNEL_ID = 'default';
const NOTIFICATION_COLOR = '#059669';

function resolveProjectId() {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ||
    Constants.easConfig?.projectId ||
    undefined
  );
}

// Show a banner + sound when a notification arrives while the app is open.
export function configureForegroundNotifications() {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch {
    // Handler is cosmetic; a failure here must not break registration.
  }
}

// Returns an Expo push token string, or null when push is unavailable.
export async function registerForPushNotifications() {
  try {
    // Remote push tokens are only issued to real devices; Expo Go and the
    // simulator cannot receive them, so skip cleanly.
    if (!Constants.isDevice) return null;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
        name: 'Updates',
        importance: Notifications.AndroidImportance?.DEFAULT ?? 4,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: NOTIFICATION_COLOR,
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = Boolean(existing?.granted);
    if (!granted && existing?.canAskAgain !== false) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = Boolean(requested?.granted);
    }
    if (!granted) return null;

    const token = await Notifications.getExpoPushTokenAsync({ projectId: resolveProjectId() });
    const value = typeof token?.data === 'string' ? token.data.trim() : '';
    return value || null;
  } catch {
    return null;
  }
}

function extractData(response) {
  const data = response?.notification?.request?.content?.data;
  return data && typeof data === 'object' ? data : null;
}

// Subscribe to notification taps (warm start) and the tap that launched the app
// (cold start). Returns an unsubscribe function; never throws.
export function subscribeToNotificationTaps(onNavigate) {
  if (typeof onNavigate !== 'function') return () => {};
  try {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = extractData(response);
      if (data) onNavigate(data);
    });
    // Cold start: the opening tap is delivered separately from the listener.
    Notifications.getLastNotificationResponseAsync?.()
      .then((response) => {
        const data = extractData(response);
        if (data) onNavigate(data);
      })
      .catch(() => {});
    return () => {
      try { subscription?.remove?.(); } catch { /* already detached */ }
    };
  } catch {
    return () => {};
  }
}

// Map a push payload to where a signed-in user should land. Returns null when
// there is nothing to route, otherwise a descriptor: { screen, subject?, testId?,
// submissionId?, tab? }. Students always land in their report area; a tapped
// "report ready" carries subject + testId so the app can open that exact
// subject/exam instead of just the dashboard. Admins/scanners land on the test
// list or class insights, opening a specific test when testId is present.
export function routeForNotification(data, role) {
  if (!data || typeof data !== 'object') return null;
  const screen = role === 'student' ? 'student' : (data.screen === 'teacher' ? 'teacher' : 'home');
  const route = { screen };
  const text = (value) => {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
  };
  const subject = text(data.subject);
  const testId = text(data.testId);
  const submissionId = text(data.submissionId);
  const tab = text(data.tab);
  if (subject) route.subject = subject;
  if (testId) route.testId = testId;
  if (submissionId) route.submissionId = submissionId;
  if (tab) route.tab = tab;
  return route;
}
