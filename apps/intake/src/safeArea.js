// Single source of truth for safe-area handling and shared page spacing tokens.
//
// The intake app runs edge-to-edge on modern Android (Expo SDK 57 / RN 0.86), so
// system bars can overlap content. We adopt one consistent strategy:
//   * Every screen/bookended surface is wrapped in <SafeAreaView> from
//     react-native-safe-area-context (NOT react-native's built-in, which does not
//     respect Android edge-to-edge insets).
//   * Sticky footers, sheets, dialogs and preview controls read the bottom inset via
//     useSafeAreaInsets() / <InsetBottom> and add it to their own padding so their
//     background fills down to the edge of the display while content stays above
//     system navigation. When InsetBottom is used inside a SafeAreaView, pass
//     edges={['top','left','right']} so the bottom inset is not applied twice.
//   * Pages are drawn on a solid background (colors.canvas / white), never transparent.
//
// Hard-coded StatusBar.currentHeight and Platform.OS-conditional paddings elsewhere
// are replaced by these tokens + insets so gesture and three-button navigation, small
// phones, landscape and 1.3x font scale stay consistent.

import { View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

// Shared horizontal gutters / vertical spacing tokens.
// - gutter:      page left/right gutter (was hard-coded 20 across screens).
// - contentBottom: extra breathing room below scroll content, above the safe-area inset.
// - section:     vertical space between distinct blocks.
// - card:        padding inside cards / panels.
// - cardRadius:  shared rounding.
// - stickyBottomExtra: comfortable padding above the bottom inset inside fixed bars/sheets.
// - touchTarget: minimum touch/control size (44x44dp), used by small controls.
export const spacing = {
  gutter: 20,
  section: 14,
  card: 16,
  cardRadius: 10,
  contentBottom: 24,
  stickyBottomExtra: 12,
  touchTarget: 44,
};

export { SafeAreaProvider, SafeAreaView, useSafeAreaInsets };

// Renders its children inside a bottom-padded box whose padding equals the current
// bottom safe-area inset plus an optional comfort offset. Use for sticky footers,
// bottom sheets, dialogs and preview control bars so their background fills down to
// the edge of the display while content stays above system navigation.
export function InsetBottom({ style, extra = spacing.stickyBottomExtra, children, ...rest }) {
  const insets = useSafeAreaInsets();
  // The inset padding is applied last so it wins over any bottom padding in `style`.
  return <View {...rest} style={[style, { paddingBottom: insets.bottom + extra }]}>{children}</View>;
}
