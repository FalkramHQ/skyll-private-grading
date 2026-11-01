import { Component } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { palette } from './theme';

// Production-safe error text: no stack traces, no internal details.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, _errorInfo) {
    // Fire-and-forget — does not crash if analytics is unavailable. This
    // boundary sits above <App/>, so it has no api client or token in scope;
    // build one and read the stored session directly. trackIntakeEvent's
    // signature is (api, accessToken, eventType, eventData) and it bails unless
    // api + token + eventType are all present, so all three must be supplied.
    try {
      const { trackIntakeEvent } = require('./analytics');
      const { createApiClient } = require('./apiClient');
      const { resolveApiOrigin } = require('./runtimeConfig');
      const { readStoredToken } = require('./authStore');
      const api = createApiClient(resolveApiOrigin());
      readStoredToken()
        .then((token) => trackIntakeEvent(api, token, 'app_crash', { error: String(error?.message || 'unknown') }))
        .catch(() => {});
    } catch {
      // Silently ignore — the user already has an error on screen.
    }
  }

  handleReset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            The app hit an unexpected error. Try restarting, or go back to retry.
          </Text>
          <Pressable style={styles.button} onPress={this.handleReset}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: palette.canvas,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  content: {
    alignItems: 'center',
    gap: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: palette.ink,
  },
  body: {
    fontSize: 15,
    color: palette.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  button: {
    // Kept on the system font: this screen must render even if nothing else does.
    minHeight: 48,
    justifyContent: 'center',
    backgroundColor: palette.action,
    borderWidth: 2,
    borderColor: palette.ink,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 8,
  },
  buttonText: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '600',
  },
});
