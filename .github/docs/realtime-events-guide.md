# Frontend Integration: Real-Time Session Events (SSE)

This guide explains how to use the newly implemented Server-Sent Events (SSE) to handle credit exhaustion and session status updates in real-time.

## Endpoint
`GET /api/session/:sessionId/events`

## 1. Implementation Pattern (React Hook)

The best way to handle this in the frontend is via a `useEffect` inside your `ActiveSession` component or a custom hook.

```typescript
import { useEffect } from 'react';
import { toast } from 'react-hot-toast'; // or your preferred toast library

export function useSessionEvents(sessionId: string, onExhausted: () => void) {
  useEffect(() => {
    if (!sessionId) return;

    // 1. Initialize EventSource
    const eventSource = new EventSource(
      `${process.env.NEXT_PUBLIC_API_URL}/session/${sessionId}/events`,
      { withCredentials: true } // Important if using Clerk/Cookies
    );

    // 2. Listen for Credit Warnings
    eventSource.addEventListener('CREDIT_WARNING', (event) => {
      const data = JSON.parse(event.data);
      toast.error(`Only ${data.remainingMinutes} minute(s) of credit remaining!`, {
        duration: 5000,
        icon: '⚠️',
      });
    });

    // 3. Listen for Automatic Closure
    eventSource.addEventListener('SESSION_CLOSED', (event) => {
      const data = JSON.parse(event.data);
      if (data.reason === 'CREDIT_EXHAUSTED') {
        toast.error('Session ended automatically due to insufficient credits.');
        onExhausted(); // Trigger cleanup/navigation logic
      }
    });

    // 4. Handle errors/reconnections
    eventSource.onerror = (err) => {
      console.error('SSE Connection failed:', err);
      // EventSource automatically tries to reconnect by default
    };

    // 5. Cleanup on unmount
    return () => {
      eventSource.close();
    };
  }, [sessionId, onExhausted]);
}
```

## 2. Integration in ActiveSession Page

Add the hook to your `ActiveSession/page.tsx`:

```tsx
export default function ActiveSessionPage() {
  const { sessionId } = useParams();
  const router = useRouter();

  useSessionEvents(sessionId, () => {
    // Logic to run when credits run out
    // e.g., stop recording, show a modal, and redirect
    router.push(`/sessions/${sessionId}/summary?exhausted=true`);
  });

  return (
    <div>
      {/* Your Session UI */}
    </div>
  );
}
```

## 3. Why Use This?

| Feature | Polling / Heartbeat | SSE (Real-Time) |
| :--- | :--- | :--- |
| **Latency** | Up to 60 seconds (delay) | Instant (< 100ms) |
| **Resource Usage** | High (frequent HTTP requests) | Low (single persistent connection) |
| **Reliability** | Depends on frontend timer | Triggered by backend watchdog |

## 4. Event Types Reference

### `CREDIT_WARNING`
Triggered when the user has exactly 1 minute of paid time remaining (based on backend calculation).
- **Payload:** `{ remainingMinutes: number, sessionId: string }`

### `SESSION_CLOSED`
Triggered when the backend watchdog or heartbeat terminates the session due to reaching the credit limit.
- **Payload:** `{ reason: "CREDIT_EXHAUSTED", sessionId: string }`

---

> [!TIP]
> Ensure your backend `CORS` settings allow the `EventSource` connection if your frontend is on a different domain. The current backend configuration is set to `origin: "*"` which supports this.
