// React 19 requires this flag for act()-based testing; jest-expo does not set it.
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

let mockInsets = { top: 12, right: 0, bottom: 34, left: 0 };
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const SafeAreaProvider = ({ children }) => React.createElement(React.Fragment, null, children);
  const SafeAreaView = ({ children, ...props }) => React.createElement(View, props, children);
  const useSafeAreaInsets = () => mockInsets;
  return { SafeAreaProvider, SafeAreaView, useSafeAreaInsets };
});

// Import AFTER the mock is registered so safeArea.js picks up the mocked module.
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets, spacing, InsetBottom } from '../src/safeArea';

async function renderInsetBottom(props) {
  await render(<InsetBottom {...props}><Text>footer</Text></InsetBottom>);
  // InsetBottom renders <View style={[style, { paddingBottom: inset+extra }]}><Text>footer</Text></View>.
  const viewStyle = screen.getByText('footer').parent.props.style;
  return viewStyle[viewStyle.length - 1].paddingBottom;
}

describe('safeArea', () => {
  afterEach(() => {
    mockInsets = { top: 12, right: 0, bottom: 34, left: 0 };
  });

  test('exposes the safe-area-context API and shared spacing tokens', () => {
    expect(typeof SafeAreaProvider).toBe('function');
    expect(typeof SafeAreaView).toBe('function');
    expect(typeof useSafeAreaInsets).toBe('function');
    expect(typeof InsetBottom).toBe('function');
    // Tokenized gutters / sections / cards / sticky-footers live in one place.
    expect(spacing).toMatchObject({
      gutter: 20,
      section: 14,
      card: 16,
      contentBottom: 24,
      stickyBottomExtra: 12,
      touchTarget: 44,
    });
  });

  test('InsetBottom pads children by the bottom inset plus a custom comfort offset', async () => {
    expect(await renderInsetBottom({ extra: 8 })).toBe(34 + 8);
  });

  test('InsetBottom uses the default sticky-bottom offset when extra is omitted', async () => {
    mockInsets = { top: 0, right: 0, bottom: 40, left: 0 };
    expect(await renderInsetBottom({})).toBe(40 + spacing.stickyBottomExtra);
  });

  test('InsetBottom merges a base style before the inset padding wins', async () => {
    await render(<InsetBottom style={{ backgroundColor: '#FFF' }}><Text>footer</Text></InsetBottom>);
    const viewStyle = screen.getByText('footer').parent.props.style;
    // Base style survives, and the inset-derived padding is the final (winning) entry.
    expect(viewStyle[0].backgroundColor).toBe('#FFF');
    expect(viewStyle[viewStyle.length - 1].paddingBottom).toBe(34 + spacing.stickyBottomExtra);
  });
});
