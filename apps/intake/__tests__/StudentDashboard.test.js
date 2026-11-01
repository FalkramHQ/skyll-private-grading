import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StudentDashboard } from '../src/RoleDashboards';

describe('StudentDashboard', () => {
  const context = {
    report: {
      student: { name: 'Ada Lovelace', school: "Partner Academy A" },
      exams: [
        { id: 'exam-a', name: 'Chemistry Unit Test', date: '2026-08-01' },
        { id: 'exam-b', name: 'Physics Midterm', date: '2026-07-10' },
      ],
      term1: {
        subjects: [{ name: 'Chemistry', score: 14, total: 25, questions: [{ number: 'Q1' }] }],
        overall_insights: { strongest_area: 'Organic naming', focus_needed: ['Mechanisms'] },
      },
      'exam-a': {
        subjects: [{ name: 'Chemistry', score: 14, total: 25, questions: [{ number: 'Q1' }] }],
        overall_insights: { strongest_area: 'Organic naming', focus_needed: ['Mechanisms'] },
      },
      'exam-b': {
        subjects: [{ name: 'Physics', score: 18, total: 40, questions: [] }],
        overall_insights: { strongest_area: 'Optics', focus_needed: ['Vectors'] },
      },
      learner_dna: {
        primary_mode: {
          mode_id: 'architect',
          title: 'The Architect - Concept building',
          description: 'You build concepts carefully before jumping to method.',
        },
        growth_edge: {
          mode_id: 'calibrator',
          title: 'Strengthen The Calibrator',
          action: 'Check one finished solution against the marking points before moving on.',
        },
        next_move: {
          title: 'Practise verification',
          action: 'Re-work one missed question and verify each step.',
        },
        dimensions: [
          { id: 'architect', state: 'secure', evidence_count: 3 },
          { id: 'calibrator', state: 'needs_practice', evidence_count: 2 },
        ],
      },
    },
  };

  it('lists assessment history and switches subject views', async () => {
    const onOpenSubject = jest.fn();
    await act(async () => {
      render(<StudentDashboard context={context} onLogout={jest.fn()} onOpenSubject={onOpenSubject} />);
    });

    expect(screen.getByText('2 published assessments')).toBeTruthy();
    expect(screen.getAllByText('Chemistry Unit Test').length).toBeGreaterThan(0);
    expect(screen.getByText('Physics Midterm')).toBeTruthy();
    expect(screen.getAllByText(/Architect/).length).toBeGreaterThan(0);
    expect(screen.getByText('Working strength: Organic naming')).toBeTruthy();
    expect(screen.getByText(/Re-work one missed question/)).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Physics Midterm'));
    });
    expect(screen.getByText('Working strength: Optics')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Physics'));
    });
    expect(onOpenSubject).toHaveBeenCalled();
    expect(onOpenSubject.mock.calls[0][0].name).toBe('Physics');
    expect(onOpenSubject.mock.calls[0][1].id).toBe('exam-b');
  });
});
