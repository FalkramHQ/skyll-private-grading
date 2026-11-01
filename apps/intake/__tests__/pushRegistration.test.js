import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import {
  configureForegroundNotifications,
  registerForPushNotifications,
  routeForNotification,
  subscribeToNotificationTaps,
} from '../src/pushRegistration';

// expo-constants is supplied by the Expo toolchain at runtime but is not a
// declared dependency, so jest cannot resolve it — mock it virtually.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { isDevice: true, expoConfig: { extra: { eas: { projectId: 'proj-1' } } } },
}), { virtual: true });

// expo-notifications is a native module; stub it so registration logic can be
// exercised without a device.
jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 4 },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
  Constants.isDevice = true;
  Notifications.getPermissionsAsync.mockResolvedValue({ granted: true });
  Notifications.requestPermissionsAsync.mockResolvedValue({ granted: true });
  Notifications.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[abc]' });
  Notifications.addNotificationResponseReceivedListener.mockReturnValue({ remove: jest.fn() });
  Notifications.getLastNotificationResponseAsync.mockResolvedValue(null);
});

describe('configureForegroundNotifications', () => {
  it('installs a foreground handler', () => {
    configureForegroundNotifications();
    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
  });

  it('never throws when the native module rejects the handler', () => {
    Notifications.setNotificationHandler.mockImplementation(() => { throw new Error('boom'); });
    expect(() => configureForegroundNotifications()).not.toThrow();
  });
});

describe('registerForPushNotifications', () => {
  it('returns null on a non-device (Expo Go / simulator) without asking for a token', async () => {
    Constants.isDevice = false;
    await expect(registerForPushNotifications()).resolves.toBeNull();
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('returns the Expo push token and scopes it to the EAS project', async () => {
    await expect(registerForPushNotifications()).resolves.toBe('ExponentPushToken[abc]');
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' });
  });

  it('returns null when permission is denied and cannot be requested again', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    await expect(registerForPushNotifications()).resolves.toBeNull();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('requests permission when not yet granted, then returns the token', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    await expect(registerForPushNotifications()).resolves.toBe('ExponentPushToken[abc]');
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('returns null when the user denies the permission prompt', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    Notifications.requestPermissionsAsync.mockResolvedValue({ granted: false });
    await expect(registerForPushNotifications()).resolves.toBeNull();
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('returns null when the token payload is empty', async () => {
    Notifications.getExpoPushTokenAsync.mockResolvedValue({ data: '   ' });
    await expect(registerForPushNotifications()).resolves.toBeNull();
  });

  it('swallows native errors and resolves to null', async () => {
    Notifications.getExpoPushTokenAsync.mockRejectedValue(new Error('native failure'));
    await expect(registerForPushNotifications()).resolves.toBeNull();
  });
});

describe('routeForNotification', () => {
  it('sends students to their report area regardless of payload screen', () => {
    expect(routeForNotification({ screen: 'home' }, 'student')).toEqual({ screen: 'student' });
    expect(routeForNotification({ screen: 'student', tab: 'recheck' }, 'student')).toEqual({ screen: 'student', tab: 'recheck' });
  });

  it('carries subject + testId so a report-ready tap can open the exact subject', () => {
    expect(routeForNotification({ screen: 'student', subject: ' Chemistry ', testId: 'test_1', submissionId: 'sub_9' }, 'student'))
      .toEqual({ screen: 'student', subject: 'Chemistry', testId: 'test_1', submissionId: 'sub_9' });
  });

  it('coerces a numeric testId to a string and drops blank hints', () => {
    expect(routeForNotification({ screen: 'home', testId: 42, subject: '   ' }, 'admin'))
      .toEqual({ screen: 'home', testId: '42' });
  });

  it('sends admins to the test list for processing-complete events', () => {
    expect(routeForNotification({ screen: 'home', testId: 'test_7' }, 'admin')).toEqual({ screen: 'home', testId: 'test_7' });
  });

  it('sends admins to class insights when the payload asks for it', () => {
    expect(routeForNotification({ screen: 'teacher' }, 'admin')).toEqual({ screen: 'teacher' });
  });

  it('returns null for a missing or invalid payload', () => {
    expect(routeForNotification(null, 'admin')).toBeNull();
    expect(routeForNotification('nope', 'student')).toBeNull();
  });
});

describe('subscribeToNotificationTaps', () => {
  const responseWith = (data) => ({ notification: { request: { content: { data } } } });

  it('returns a no-op unsubscribe when the handler is not a function', () => {
    const unsubscribe = subscribeToNotificationTaps(null);
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
    expect(Notifications.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
  });

  it('routes a warm-start tap to the navigate handler', () => {
    let captured;
    Notifications.addNotificationResponseReceivedListener.mockImplementation((cb) => { captured = cb; return { remove: jest.fn() }; });
    const onNavigate = jest.fn();
    subscribeToNotificationTaps(onNavigate);
    captured(responseWith({ screen: 'teacher' }));
    expect(onNavigate).toHaveBeenCalledWith({ screen: 'teacher' });
  });

  it('ignores a tap whose payload is missing', () => {
    let captured;
    Notifications.addNotificationResponseReceivedListener.mockImplementation((cb) => { captured = cb; return { remove: jest.fn() }; });
    const onNavigate = jest.fn();
    subscribeToNotificationTaps(onNavigate);
    captured({ notification: { request: { content: {} } } });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('routes the cold-start tap delivered via getLastNotificationResponseAsync', async () => {
    Notifications.getLastNotificationResponseAsync.mockResolvedValue(responseWith({ screen: 'home' }));
    const onNavigate = jest.fn();
    subscribeToNotificationTaps(onNavigate);
    await flush();
    expect(onNavigate).toHaveBeenCalledWith({ screen: 'home' });
  });

  it('detaches the listener on unsubscribe', () => {
    const remove = jest.fn();
    Notifications.addNotificationResponseReceivedListener.mockReturnValue({ remove });
    const unsubscribe = subscribeToNotificationTaps(jest.fn());
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('returns a safe unsubscribe when the native listener throws', () => {
    Notifications.addNotificationResponseReceivedListener.mockImplementation(() => { throw new Error('boom'); });
    const unsubscribe = subscribeToNotificationTaps(jest.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});
