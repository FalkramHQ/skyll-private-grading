import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles } from 'lucide-react';
import Loader from '../components/Loader';

/**
 * Reusable evidence-bound tutor chat widget.
 */
export default function TutorChat({
  username = null,
  initialSessionId = null,
  askTutor,
  loadHistory,
  starterPrompts = [
    'What are my weakest topics from recent exams?',
    'Why did I lose marks recently?',
    'Explain my growth edge in a simple way.',
  ],
}) {
  const [sessionId, setSessionId] = useState(initialSessionId || '');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (!initialSessionId || !loadHistory) return;
    let cancelled = false;
    (async () => {
      try {
        const payload = await loadHistory(initialSessionId);
        if (!cancelled) {
          setSessionId(payload.sessionId || initialSessionId);
          setMessages((payload.messages || []).map((row) => ({
            role: row.message_role,
            content: row.content,
          })));
        }
      } catch {
        /* empty session is fine */
      }
    })();
    return () => { cancelled = true; };
  }, [initialSessionId, loadHistory]);

  async function send(question) {
    const q = String(question || '').trim();
    if (!q || busy) return;
    setBusy(true);
    setError('');
    setMessages((prev) => [...prev, { role: 'user', content: q }]);
    setInput('');
    try {
      const result = await askTutor({
        question: q,
        sessionId: sessionId || undefined,
        username: username || undefined,
      });
      setSessionId(result.sessionId);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: result.reply,
          citations: result.citations || [],
          suggestedNext: result.suggestedNext || null,
        },
      ]);
    } catch (err) {
      setError(err.message || 'Tutor could not respond');
      setMessages((prev) => prev.slice(0, -1));
      setInput(q);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-[420px] flex-col overflow-hidden rounded-[20px] border-2 border-ink bg-card">
      <div className="border-b-[1.5px] border-ink px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 rotate-[-4deg] items-center justify-center rounded-xl border-[1.5px] border-ink bg-lime" aria-hidden="true">
            <Sparkles className="h-4 w-4 text-ink" strokeWidth={2.4} />
          </span>
          <div>
            <p className="font-display text-lg font-bold leading-tight text-foreground">Skyll Tutor</p>
            <p className="text-[13px] text-foreground-secondary">Answers use your reports and Learning DNA only.</p>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground-secondary">Try one of these:</p>
            {starterPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => send(prompt)}
                className="block min-h-11 w-full rounded-xl border-[1.5px] border-ink bg-card px-3.5 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed ${
              message.role === 'user'
                ? 'ml-auto rounded-br-md bg-ink text-white'
                : 'rounded-bl-md border border-border bg-paper-soft text-foreground'
            }`}
          >
            <p className="whitespace-pre-wrap">{message.content}</p>
            {message.citations?.length > 0 && (
              <p className="mt-2 text-xs text-foreground-secondary">Evidence: {message.citations.join(', ')}</p>
            )}
            {message.suggestedNext && (
              <button
                type="button"
                className="mt-2 rounded text-[13px] font-semibold text-action underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => send(message.suggestedNext)}
              >
                Next: {message.suggestedNext}
              </button>
            )}
          </div>
        ))}
        {busy && (
          <div className="inline-flex items-center gap-2 rounded-2xl border border-border bg-paper-soft px-3 py-2 text-[13px] text-foreground-secondary">
            <Loader size="inline" className="text-action" />
            Thinking with your evidence…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="px-4 pb-2 text-[13px] font-medium text-destructive">{error}</p>}

      <form
        className="flex items-end gap-2 border-t-[1.5px] border-ink p-3"
        onSubmit={(event) => {
          event.preventDefault();
          send(input);
        }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={2}
          placeholder="Ask about a topic, question number, or exam…"
          aria-label="Ask the tutor"
          className="min-h-11 flex-1 resize-none rounded-xl border-[1.5px] border-ink bg-card px-3 py-2 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="press inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-[1.5px] border-ink bg-action text-white shadow-hard transition-colors hover:bg-action-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
