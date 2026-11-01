import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Button } from '../components/ui/Button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/Card.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Input } from '../components/ui/Input.jsx';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/Alert.jsx';
import { Select } from '../components/ui/Select.jsx';

afterEach(() => {
  cleanup();
});

describe('UI components design system primitives', () => {
  it('renders Button with variants and handles click events', () => {
    const handleClick = vi.fn();
    render(<Button variant="outline" onClick={handleClick}>Click me</Button>);

    const button = screen.getByRole('button', { name: /click me/i });
    expect(button).toBeInTheDocument();
    expect(button.className).toContain('border');
    
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('renders Card with header, title, description, and content', () => {
    render(
      <Card data-testid="test-card">
        <CardHeader>
          <CardTitle>Test Title</CardTitle>
          <CardDescription>Test Description</CardDescription>
        </CardHeader>
        <CardContent>Content Area</CardContent>
      </Card>
    );

    expect(screen.getByTestId('test-card')).toBeInTheDocument();
    expect(screen.getByText('Test Title')).toBeInTheDocument();
    expect(screen.getByText('Test Description')).toBeInTheDocument();
    expect(screen.getByText('Content Area')).toBeInTheDocument();
  });

  it('renders Badge and Alert with proper roles and classes', () => {
    render(
      <div>
        <Badge variant="success">Active</Badge>
        <Alert variant="destructive">
          <AlertTitle>Error occurred</AlertTitle>
          <AlertDescription>Please check your inputs.</AlertDescription>
        </Alert>
      </div>
    );

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Error occurred')).toBeInTheDocument();
    expect(screen.getByText('Please check your inputs.')).toBeInTheDocument();
  });

  it('renders Input and Select controls properly', () => {
    render(
      <div>
        <Input placeholder="Enter username" />
        <Select aria-label="Role select" defaultValue="teacher">
          <option value="teacher">Teacher</option>
          <option value="student">Student</option>
        </Select>
      </div>
    );

    expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /role select/i })).toHaveValue('teacher');
  });
});
