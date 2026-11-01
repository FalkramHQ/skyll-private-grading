// React 19 requires this flag for act()-based testing; jest-expo does not set it.
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('../src/analytics', () => ({
  trackIntakeEvent: jest.fn(),
}));

import { SchoolProfileScreen, StudentProfileScreen } from '../src/ProfileScreens';

function mockApi(handlers) {
  return jest.fn(async (path, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const key = `${method} ${path}`;
    if (!handlers[key]) throw new Error(`Unexpected request ${key}`);
    const result = handlers[key];
    return typeof result === 'function' ? result(options) : result;
  });
}

describe('ProfileScreens', () => {
  afterEach(() => {
    cleanup();
  });

  test('student profile shows academic details and no password form', async () => {
    const api = mockApi({
      'GET /api/auth/profile': {
        profile: {
          name: 'Asha',
          username: 'as12ha',
          class: '10',
          school: 'Example School',
          batches: ['10A'],
          board: 'CBSE',
        },
      },
    });

    await act(async () => {
      render(<StudentProfileScreen api={api} accessToken="token" onBack={jest.fn()} onLogout={jest.fn()} />);
    });

    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy());
    expect(screen.getByText('Username · as12ha')).toBeTruthy();
    expect(screen.getByText('Batches · 10A')).toBeTruthy();

    // Student password self-service is disabled — no password form or button should render.
    expect(screen.queryByText('Account security')).toBeNull();
    expect(screen.queryByText('Change password')).toBeNull();
    expect(screen.queryByPlaceholderText('Current password')).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
  });

  test('school profile loads roster and opens the batch editor', async () => {
    const api = mockApi({
      'GET /api/auth/teacher-profile': { profile: { name: 'Admin', username: 'admin', school: 'Example School' } },
      'GET /api/auth/teacher-roster': {
        batches: [{ id: 'b1', name: '10A', grade: '10', board: 'CBSE', stream: null, academicYear: null, studentCount: 1 }],
        students: [{ id: 's1', name: 'Asha', username: 'as12ha', batchIds: ['b1'], batches: ['10A'] }],
      },
    });

    await act(async () => {
      render(<SchoolProfileScreen api={api} accessToken="token" onBack={jest.fn()} onLogout={jest.fn()} />);
    });

    await waitFor(() => expect(screen.getByText('Admin')).toBeTruthy());
    expect(screen.getByText('Example School · admin')).toBeTruthy();
    expect(screen.getByText('10A')).toBeTruthy();
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(screen.getByText('Batches')).toBeTruthy();
    expect(screen.getByText('Students')).toBeTruthy();
    expect(screen.getByText('Account security')).toBeTruthy();
  });
});
