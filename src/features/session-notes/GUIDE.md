# Session Notes Feature Guide

This guide covers how to test the **Session Notes** feature and how to integrate it into the frontend.

## 1. Feature Overview

The Session Notes feature automatically generates a professional summary (3-5 lines) and extracts all questions asked during an interview session using AI (OpenRouter/Gemini). It also merges questions recorded in the `QA` table for that session.

---

## 2. Backend Endpoints

### Generate/Update Notes

- **Endpoint**: `POST /api/session-notes/:sessionId/generate`
- **Description**: Triggers AI analysis of the session transcript. If notes already exist, they are updated.
- **Response**:

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "sessionId": "uuid",
    "companyName": "Google",
    "jobDescription": "Software Engineer",
    "summary": "The candidate discussed their experience with distributed systems...",
    "questions": ["How do you handle race conditions?", "What is CAP theorem?"],
    "updatedAt": "2026-05-01T12:00:00Z"
  }
}
```

### Retrieve Notes

- **Endpoint**: `GET /api/session-notes/:sessionId`
- **Description**: Fetches existing notes for a session. Returns 404 if not yet generated.
- **Response**: Same as above.

---

## 3. How to Test

### Prerequisites

1. Ensure you have a session in the database with a `transcript` (an array of message objects).
2. Ensure `OPENROUTER_API_KEY` is set in your `.env`.

### Testing with `curl`

Replace `<SESSION_ID>` with your actual session ID.

**Generate Notes:**

```bash
curl -X POST http://localhost:3000/api/session-notes/<SESSION_ID>/generate
```

**Get Notes:**

```bash
curl -X GET http://localhost:3000/api/session-notes/<SESSION_ID>
```

---

## 4. Frontend Integration Guide

### API Service (React/TypeScript)

```typescript
import axios from "axios";

const api = axios.create({ baseURL: "/api" });

export const SessionNotesService = {
  generate: async (sessionId: string) => {
    const { data } = await api.post(`/session-notes/${sessionId}/generate`);
    return data.data;
  },
  get: async (sessionId: string) => {
    const { data } = await api.get(`/session-notes/${sessionId}`);
    return data.data;
  },
};
```

### React Component Implementation

Ideally, you should trigger generation when the user lands on the "Session Summary" page or after clicking "End Session".

```tsx
import React, { useEffect, useState } from "react";
import { SessionNotesService } from "./services/session-notes";

const SessionNotesView = ({ sessionId }: { sessionId: string }) => {
  const [notes, setNotes] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchNotes = async () => {
      try {
        // Try to get existing notes first
        const existing = await SessionNotesService.get(sessionId);
        setNotes(existing);
      } catch (err) {
        // If 404, generate them
        const generated = await SessionNotesService.generate(sessionId);
        setNotes(generated);
      } finally {
        setLoading(false);
      }
    };
    fetchNotes();
  }, [sessionId]);

  if (loading) return <div>Analyzing session...</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">
        {notes.companyName} - Interview Notes
      </h1>

      <section className="mb-6">
        <h2 className="text-xl font-semibold">Summary</h2>
        <p className="mt-2 text-gray-700 leading-relaxed">{notes.summary}</p>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Questions Asked</h2>
        <ul className="mt-2 list-disc pl-5">
          {notes.questions.map((q: string, i: number) => (
            <li key={i} className="mb-1 text-gray-800">
              {q}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};
```

### Best Practices

- **Loading State**: AI generation can take 2-5 seconds. Show a "Brain is working..." animation.
- **Error Handling**: If AI generation fails (e.g., API quota), show a fallback message or allow the user to retry.
- **Empty State**: If the transcript is empty, the AI summary might be generic. Ensure the session was actually active before allowing note generation.
