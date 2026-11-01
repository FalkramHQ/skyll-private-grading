import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StudentSubjectDashboard } from '../src/RoleDashboards';

describe('StudentSubjectDashboard', () => {
  const longAnswer = 'The correct answer explains the full mechanism step by step. '.repeat(8);
  const longReason = 'The student missed the activation energy step and misapplied the rate law, which caused the partial credit. '.repeat(6);
  const subject = {
    name: 'Chemistry',
    score: 7,
    total: 20,
    questions: [
      {
        id: 'q1',
        number: 'Q1',
        marks_obtained: 2,
        marks_total: 4,
        question: 'Balance the reaction. (short, shown inline)',
        correct_answer: 'C + O2 → CO2', // short → shown inline
        student_answer: 'C + O → CO', // short → shown inline
        what_went_correct: 'Oxygen atoms balanced.',
      },
      {
        id: 'q2',
        number: 'Q2',
        marks_obtained: 0,
        marks_total: 4,
        question: 'Derive the rate law. (long answer, collapsed)',
        correct_answer: longAnswer, // long → collapsed by default
        student_answer: 'Failed to write anything.', // short → shown inline
        grading_reason: longReason, // long → collapsed by default
      },
    ],
  };

  it('shows a concise initial view: number, marks and text result first', async () => {
    await act(async () => {
      render(
        <StudentSubjectDashboard
          subject={subject}
          studentName="Ada"
          school="Academy"
          onBack={jest.fn()}
          onLogout={jest.fn()}
        />,
      );
    });

    expect(screen.getByText('Q1')).toBeTruthy();
    expect(screen.getByText('2/4')).toBeTruthy();
    expect(screen.getAllByText(/Partial/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Incorrect/)).toBeTruthy();
    // Short sections are inline; long ones are collapsed behind a "Show reasoning" control.
    expect(screen.getByText('Show reasoning')).toBeTruthy();
    expect(screen.getByText('Show answer')).toBeTruthy();
    expect(screen.queryByText(longAnswer)).toBeNull();
    expect(screen.queryByText(longReason)).toBeNull();
  });

  it('expands long sections independently per question on demand', async () => {
    await act(async () => {
      render(
        <StudentSubjectDashboard
          subject={subject}
          studentName="Ada"
          school="Academy"
          onBack={jest.fn()}
          onLogout={jest.fn()}
        />,
      );
    });

    // Expand the long answer.
    await act(async () => {
      fireEvent.press(screen.getByText('Show answer'));
    });
    expect(screen.getByText(longAnswer)).toBeTruthy();
    // Reasoning is still collapsed — independent expansion.
    expect(screen.queryByText(longReason)).toBeNull();

    // Toggle back to "Show less" collapses it again.
    await act(async () => {
      fireEvent.press(screen.getByText('Show less'));
    });
    expect(screen.queryByText(longAnswer)).toBeNull();
  });

  it('renders concise result text for an unmarked question without colour alone', async () => {
    const unmarked = { ...subject, questions: [{ id: 'qm', number: 'Q9', marks: 0, marks_total: 0, question: 'Not graded yet.' }] };
    await act(async () => {
      render(
        <StudentSubjectDashboard subject={unmarked} studentName="Ada" school="Academy" onBack={jest.fn()} onLogout={jest.fn()} />,
      );
    });
    expect(screen.getByText(/Not marked/)).toBeTruthy();
  });

  it('shows recheck status instead of the submit form once a request exists', async () => {
    const rechecks = {
      Q1: { status: 'resolved', reason: 'Please recheck the balancing.', resolutionNote: 'Marks updated after review.' },
    };
    await act(async () => {
      render(
        <StudentSubjectDashboard
          subject={subject}
          studentName="Ada"
          school="Academy"
          onBack={jest.fn()}
          onLogout={jest.fn()}
          onRequestRecheck={jest.fn()}
          rechecks={rechecks}
        />,
      );
    });

    // Q1 has a resolved recheck: canonical status label + reviewer note, no form.
    expect(screen.getByText(/Recheck Updated/)).toBeTruthy();
    expect(screen.getByText(/Marks updated after review\./)).toBeTruthy();
    // Q2 has no recheck, so only Q2 keeps the submit form (exactly one of each).
    expect(screen.getAllByText('Need a recheck?').length).toBe(1);
    expect(screen.getAllByText('Send recheck request').length).toBe(1);
  });

  it('gates the recheck note on the live character rule and sends the draft', async () => {
    const onRequestRecheck = jest.fn(async () => {});
    const oneQuestion = { ...subject, questions: [{ id: 'q1', number: 'Q1', marks_obtained: 2, marks_total: 4, question: 'Balance the reaction.' }] };
    await act(async () => {
      render(
        <StudentSubjectDashboard
          subject={oneQuestion}
          studentName="Ada"
          school="Academy"
          onBack={jest.fn()}
          onLogout={jest.fn()}
          onRequestRecheck={onRequestRecheck}
        />,
      );
    });

    const input = screen.getByPlaceholderText('Explain what should be rechecked');
    expect(input.props.maxLength).toBe(800);

    // Under the minimum: the counter says so and Send does nothing.
    await act(async () => { fireEvent.changeText(input, 'too short'); });
    expect(screen.getByText('9/12 characters minimum')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('Send recheck request')); });
    expect(onRequestRecheck).not.toHaveBeenCalled();

    // A valid note flips the counter to the max and sends the raw draft.
    const note = 'The balancing step was marked wrong but my working is correct.';
    await act(async () => { fireEvent.changeText(input, note); });
    expect(screen.getByText(`${note.length}/800 characters`)).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('Send recheck request')); });
    expect(onRequestRecheck).toHaveBeenCalledTimes(1);
    expect(onRequestRecheck.mock.calls[0][1]).toBe(note);
  });
});
