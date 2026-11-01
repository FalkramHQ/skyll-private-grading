import { act, render, screen } from '@testing-library/react-native';
import NotebookLoader from '../src/NotebookLoader';

// The loader replaces ActivityIndicator on loading screens; it must render at
// any size and stay announced to screen readers.
describe('NotebookLoader', () => {
  test('renders an accessible progress indicator', async () => {
    await act(async () => { render(<NotebookLoader />); });
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });

  test('sizes the sticker from the size prop', async () => {
    await act(async () => { render(<NotebookLoader size={72} accessibilityLabel="Loading your report" />); });
    const loader = screen.getByLabelText('Loading your report');
    expect(loader.props.style).toEqual(expect.arrayContaining([{ width: 72, height: 72 }]));
  });
});
