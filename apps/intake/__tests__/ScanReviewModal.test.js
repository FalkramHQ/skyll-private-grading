import { useState } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ScanReviewModal } from '../src/ScanReviewModal';
import { removeScanPage } from '../src/scanReview';

// ScanReviewModal uses react-native-safe-area-context (SafeAreaView, InsetBottom,
// useSafeAreaInsets); stub the module so insets are zero outside a native device.
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const SafeAreaProvider = ({ children }) => React.createElement(React.Fragment, null, children);
  const SafeAreaView = ({ children, ...props }) => React.createElement(View, props, children);
  const useSafeAreaInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
  return { SafeAreaProvider, SafeAreaView, useSafeAreaInsets };
});

const pages = [
  { uri: 'clean.jpg', needsReview: false, qualityNote: '' },
  { uri: 'low.jpg', needsReview: true, qualityNote: 'Low resolution. Retake this page if handwriting is not crisp.' },
  { uri: 'other.jpg', needsReview: true, qualityNote: 'Could not verify image dimensions. Inspect this page before upload.' },
];

// A button's disabled state is asserted through accessibilityState, matching
// the convention used elsewhere in the intake component tests. Query by the
// button's accessibility label so the assertion sees the Pressable itself
// rather than the nested Text node.
const isDisabled = (node) => node.props.accessibilityState.disabled === true;

async function renderReview(overrides = {}) {
  const props = {
    pendingScan: { student: { name: 'Asha' }, pages, replaceExisting: false },
    onCancel: jest.fn(),
    onAddPages: jest.fn(),
    onConfirm: jest.fn(),
    onRemovePage: jest.fn(),
    onRetakePage: jest.fn(),
    ...overrides,
  };
  const view = await render(<ScanReviewModal {...props} />);
  return { ...props, view };
}

// Minimal stand-in for the intake screen: it owns the page list so a removal
// flows back into the modal as new props, exactly as it does in App.js.
function ScanReviewHost({ onConfirm, onRemovePage }) {
  const [scanPages, setScanPages] = useState(pages);
  return <ScanReviewModal
    pendingScan={{ student: { name: 'Asha' }, pages: scanPages, replaceExisting: false }}
    onCancel={jest.fn()}
    onAddPages={jest.fn()}
    onConfirm={onConfirm}
    onRetakePage={jest.fn()}
    onRemovePage={(index) => {
      onRemovePage(index);
      setScanPages((current) => removeScanPage(current, index));
    }}
  />;
}

describe('ScanReviewModal', () => {
  test('shows page and warning totals with accessible quality states', async () => {
    const { view } = await renderReview();
    expect(view.getByText('3 pages scanned')).toBeTruthy();
    expect(view.getByText(/2 of 3 pages need attention/)).toBeTruthy();
    expect(view.getByLabelText('Page 1, ready for OCR')).toBeTruthy();
    expect(view.getByLabelText('Page 2, needs attention')).toBeTruthy();
  });

  test('selecting a warning opens its page and supports next issue navigation', async () => {
    const { view } = await renderReview();
    await fireEvent.press(view.getByLabelText('Low resolution, 1 pages'));
    expect(view.getByText('Page 2 of 3')).toBeTruthy();
    await fireEvent.press(view.getByText('Next issue'));
    expect(view.getByText('Page 3 of 3')).toBeTruthy();
  });

  test('retake and removal target the selected page index', async () => {
    const props = await renderReview();
    await fireEvent.press(props.view.getByLabelText('Page 2, needs attention'));
    await fireEvent.press(props.view.getByText('Retake page'));
    await fireEvent.press(props.view.getByText('Remove page'));
    expect(props.onRetakePage).toHaveBeenCalledWith(1);
    expect(props.onRemovePage).toHaveBeenCalledWith(1);
  });

  test('clean pages upload directly through the single confirmation action', async () => {
    const onConfirm = jest.fn();
    const { view } = await renderReview({ pendingScan: { student: { name: 'Asha' }, pages: pages.slice(0, 1), replaceExisting: false }, onConfirm });
    expect(view.getByText(/All 1 pages ready for OCR/)).toBeTruthy();
    await fireEvent.press(view.getByText('Use 1 page(s)'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // FLKRM-110: a clean scan needs no per-page or extra confirmation, so the
  // acknowledgement control must not appear at all.
  test('clean scans never ask for a warning acknowledgement', async () => {
    const { view } = await renderReview({ pendingScan: { student: { name: 'Asha' }, pages: [pages[0]], replaceExisting: false } });
    expect(view.queryByText(/I have reviewed the/)).toBeNull();
    expect(isDisabled(view.getByLabelText('Use 1 pages'))).toBe(false);
  });

  // FLKRM-110: unresolved warnings require an explicit acknowledgement before
  // upload; the confirm action stays disabled until it is checked.
  test('upload stays blocked until unresolved warnings are explicitly acknowledged', async () => {
    const onConfirm = jest.fn();
    const { view } = await renderReview({ onConfirm });
    const confirm = () => view.getByLabelText('Use 3 pages');
    expect(isDisabled(confirm())).toBe(true);
    await fireEvent.press(confirm());
    expect(onConfirm).not.toHaveBeenCalled();

    await fireEvent.press(view.getByText('I have reviewed the 2 pages that need attention'));
    expect(isDisabled(confirm())).toBe(false);
    await fireEvent.press(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // FLKRM-110: the acknowledgement is bound to the exact flagged-page set — a
  // later removal cannot reuse a stale "use anyway" for a different set. A small
  // host exercises the real screen contract: removal updates the pending scan
  // and re-renders the modal with the new page list.
  test('removing a page revokes a previously acknowledged warning', async () => {
    const onConfirm = jest.fn();
    const onRemovePage = jest.fn();
    const { getByText, getByLabelText } = await render(<ScanReviewHost onConfirm={onConfirm} onRemovePage={onRemovePage} />);

    await fireEvent.press(getByText('I have reviewed the 2 pages that need attention'));
    expect(isDisabled(getByLabelText('Use 3 pages'))).toBe(false);

    await fireEvent.press(getByLabelText('Page 2, needs attention'));
    await fireEvent.press(getByText('Remove page'));
    await fireEvent.press(getByText('Back to all pages'));

    await waitFor(() => expect(getByText(/2 pages scanned/)).toBeTruthy());
    expect(isDisabled(getByLabelText('Use 2 pages'))).toBe(true);
    await fireEvent.press(getByLabelText('Use 2 pages'));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
