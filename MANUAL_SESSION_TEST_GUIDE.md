# ScribeShade Session Module - Manual Testing Guide

This guide provides step-by-step instructions for manually testing the ScribeShade session module with real API calls to validate memory retention, context awareness, and hallucination prevention.

## Prerequisites

1. **Backend Server Running**: Ensure backend is running at `http://localhost:3200`
   ```bash
   curl http://localhost:3200/api/health
   ```

2. **Valid Clerk User**: You need a valid Clerk user account
   - Sign in to the ScribeShade frontend app
   - Obtain your Clerk user ID from the frontend or Clerk dashboard
   - Get auth token from browser DevTools (Application → Local Storage → Clerk session)

3. **Test Resume**: Have a PDF resume ready for upload
   - Create a test resume with Data Engineer experience
   - Include Databricks, PySpark, Azure Data Factory skills
   - Save as `test-resume.pdf`

4. **API Client**: Use a tool like:
   - Postman
   - Insomnia
   - cURL
   - Or the provided TypeScript script with auth

## Authentication Setup

### Step 1: Get Clerk User ID and Auth Token

**Option A: From Frontend**
1. Sign in to ScribeShade app
2. Open browser DevTools (F12)
3. Go to Application → Local Storage
4. Copy the Clerk session token
5. Get user ID from the frontend state or Clerk dashboard

**Option B: From Clerk Dashboard**
1. Go to Clerk dashboard
2. Navigate to Users
3. Find or create a test user
4. Copy the User ID

### Step 2: Sync User to Database

```bash
curl -X GET http://localhost:3200/api/auth/me \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN"
```

This will:
- Resolve Clerk ID to internal DB user ID
- Create user in database if doesn't exist
- Return user object with internal `id` (UUID)

**Save the returned `id`** - this is your internal user ID for session creation.

## Asset Preparation

### Step 3: Upload Test Resume

```bash
curl -X POST http://localhost:3200/api/resume/upload \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -F "resume=@/path/to/test-resume.pdf"
```

**Response**:
```json
{
  "id": "resume-uuid-here",
  "filename": "test-resume.pdf",
  "path": "uploads/resumes/test-resume.pdf",
  "size": 12345,
  "uploadedAt": "2026-05-25T..."
}
```

**Save the `id`** - this is your resume ID.

### Step 4: Upload Test Document (Optional)

```bash
curl -X POST http://localhost:3200/api/document/upload \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -F "document=@/path/to/test-document.pdf"
```

**Save the `id`** - this is your document ID (optional).

## Session Creation

### Step 5: Create Session

```bash
curl -X POST http://localhost:3200/api/session/create-session \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "YOUR_INTERNAL_USER_ID",
    "companyName": "HiddenMind Solutions",
    "jobDescription": "Senior Data Engineer with experience in Databricks, PySpark, Azure Data Factory, performance optimization, and modern data architecture.",
    "resumeId": "YOUR_RESUME_ID",
    "documentId": "",
    "language": "English",
    "simpleLanguage": false,
    "autoGenerateAI": true,
    "saveTranscript": true,
    "mode": "manual",
    "free": true,
    "projectIds": []
  }'
```

**Response**:
```json
{
  "success": true,
  "sessionId": "session-uuid-here",
  "data": {
    "id": "session-uuid-here",
    "status": "PRE_CHECK",
    "creditsHeld": 0,
    "maxAllowedMinutes": null,
    ...
  }
}
```

**Save the `sessionId`** - you'll need this for all subsequent calls.

### Step 6: Activate Session

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/activate \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "language": "English",
    "simpleLanguage": false
  }'
```

**Response**:
```json
{
  "success": true,
  "sessionId": "session-uuid-here",
  "startedAt": "2026-05-25T...",
  "creditsHeld": 0,
  "maxAllowedMinutes": null,
  "timer": 0
}
```

## Interview Simulation

### Step 7: Subscribe to SSE Events (Optional - Keep in Separate Terminal)

```bash
curl -N http://localhost:3200/api/session/YOUR_SESSION_ID/events \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN"
```

This will keep the connection open and stream real-time events.

### Step 8: Send Heartbeat (Every 60 Seconds During Session)

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/heartbeat \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "elapsedMinutes": 1
  }'
```

**Response**:
```json
{
  "action": "NONE",
  "remainingMinutes": 59,
  "elapsedMinutes": 1
}
```

Repeat this every 60 seconds while the session is active.

## Question 1: Introduction (Resume Context Test)

### Step 9: Ask First Question

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/ai-answer \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "Hi, I'\''m the interviewer. Can you tell me about your total years of experience and your relevant experience in Databricks, PySpark, and Azure Data Factory? What is your current role?",
    "currentQuestion": "Hi, I'\''m the interviewer. Can you tell me about your total years of experience and your relevant experience in Databricks, PySpark, and Azure Data Factory? What is your current role?",
    "isCustomQuery": false,
    "isRegenerate": false,
    "liveContextMetadata": {
      "sourcePlatform": "manual",
      "answerMode": "auto"
    }
  }'
```

**Expected Behavior**:
- AI should use resume context to answer
- Should mention specific experience from resume
- Should reference current role

**Save the AI response** for documentation.

### Step 10: Save Message

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/save-message \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "role": "interviewer",
    "question": "Hi, I'\''m the interviewer. Can you tell me about your total years of experience and your relevant experience in Databricks, PySpark, and Azure Data Factory? What is your current role?",
    "answer": "AI_RESPONSE_FROM_STEP_9",
    "time": "2026-05-25T09:30:00.000Z",
    "messageId": "msg-1"
  }'
```

## Question 2: Follow-up (Context Retention Test)

### Step 11: Ask Follow-up Question

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/ai-answer \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "Can you elaborate on the Databricks migration you mentioned and the performance improvements you achieved?",
    "currentQuestion": "Can you elaborate on the Databricks migration you mentioned and the performance improvements you achieved?",
    "isCustomQuery": false,
    "isRegenerate": false,
    "liveContextMetadata": {
      "sourcePlatform": "manual",
      "answerMode": "auto",
      "previousAiAnswer": "AI_RESPONSE_FROM_STEP_9",
      "selectedAnswerQuestion": "Hi, I'\''m the interviewer. Can you tell me about your total years of experience and your relevant experience in Databricks, PySpark, and Azure Data Factory? What is your current role?"
    }
  }'
```

**Expected Behavior**:
- AI should understand reference to "Databricks migration"
- Should provide specific details about performance improvements
- Should not hallucinate - should use context from previous answer

**Test**: Does AI correctly reference the previous answer?

## Question 3: Code Generation

### Step 12: Ask for Code

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/ai-answer \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "Write PySpark code to read a CSV file with a column called \"date_of_joining\". The date column should be converted to proper date type.",
    "currentQuestion": "Write PySpark code to read a CSV file with a column called \"date_of_joining\". The date column should be converted to proper date type.",
    "isCustomQuery": false,
    "isRegenerate": false,
    "liveContextMetadata": {
      "sourcePlatform": "manual",
      "answerMode": "auto"
    }
  }'
```

**Expected Behavior**:
- AI should generate syntactically correct PySpark code
- Should include proper imports
- Should handle date conversion correctly

**Test**: Is the code valid PySpark?

## Question 4: Code Explanation Follow-up

### Step 13: Ask for Code Explanation

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/ai-answer \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "Explain why you used to_date() instead of direct date parsing in your code.",
    "currentQuestion": "Explain why you used to_date() instead of direct date parsing in your code.",
    "isCustomQuery": false,
    "isRegenerate": false,
    "liveContextMetadata": {
      "sourcePlatform": "manual",
      "answerMode": "auto",
      "previousAiAnswer": "AI_RESPONSE_FROM_STEP_12",
      "selectedAnswerQuestion": "Write PySpark code to read a CSV file with a column called \"date_of_joining\". The date column should be converted to proper date type."
    }
  }'
```

**Expected Behavior**:
- AI should explain the code it just generated
- Should reference specific functions used
- Should provide reasoning for implementation choices

**Test**: Does AI explain its own code correctly?

## Question 5: "Next Question" Directive

### Step 14: Test Context Switch

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/ai-answer \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "Next question - tell me about your experience with cloud platforms like AWS and Azure.",
    "currentQuestion": "Next question - tell me about your experience with cloud platforms like AWS and Azure.",
    "isCustomQuery": false,
    "isRegenerate": false,
    "liveContextMetadata": {
      "sourcePlatform": "manual",
      "answerMode": "auto"
    }
  }'
```

**Expected Behavior**:
- AI should acknowledge "Next question" directive
- Should switch to new topic (cloud platforms)
- Should not continue discussing PySpark

**Test**: Does AI switch context appropriately?

## Question 6: "New Topic" Directive

### Step 15: Test Complete Context Switch

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/ai-answer \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "New topic - let'\''s discuss your experience with CI/CD pipelines.",
    "currentQuestion": "New topic - let'\''s discuss your experience with CI/CD pipelines.",
    "isCustomQuery": false,
    "isRegenerate": false,
    "liveContextMetadata": {
      "sourcePlatform": "manual",
      "answerMode": "auto"
    }
  }'
```

**Expected Behavior**:
- AI should completely switch context
- Should discuss CI/CD, not cloud platforms or PySpark
- Should treat as fresh topic

**Test**: Does AI reset context completely?

## Question 7: Hallucination Prevention

### Step 16: Test Missing Context

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/ai-answer \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "Explain this code",
    "currentQuestion": "Explain this code",
    "isCustomQuery": false,
    "isRegenerate": false,
    "liveContextMetadata": {
      "sourcePlatform": "manual",
      "answerMode": "auto"
    }
  }'
```

**Expected Behavior**:
- AI should ask for the code
- Should NOT make assumptions or generate random code
- Should request clarification

**Test**: Does AI ask for missing context instead of hallucinating?

## Question 8: Long-term Memory Test

### Step 19: Test Memory Retention (After 5+ Questions)

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/ai-answer \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "What was the performance improvement percentage you mentioned in your first answer about the Databricks migration?",
    "currentQuestion": "What was the performance improvement percentage you mentioned in your first answer about the Databricks migration?",
    "isCustomQuery": false,
    "isRegenerate": false,
    "liveContextMetadata": {
      "sourcePlatform": "manual",
      "answerMode": "auto"
    }
  }'
```

**Expected Behavior**:
- AI should recall the specific percentage from first answer
- Should reference the Databricks migration context
- Should NOT hallucinate a random percentage

**Test**: Does AI correctly recall information from 5+ questions ago?

## Session Conclusion

### Step 20: Deactivate Session

```bash
curl -X POST http://localhost:3200/api/session/YOUR_SESSION_ID/deactivate \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "aiUsage": 10,
    "transcript": "FULL_TRANSCRIPT_ARRAY"
  }'
```

**Response**:
```json
{
  "success": true,
  "sessionId": "session-uuid-here",
  "status": "COMPLETED"
}
```

### Step 21: Get Session Analytics

```bash
curl -X GET http://localhost:3200/api/session/YOUR_SESSION_ID/analytics \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN"
```

**Response**:
```json
{
  "id": "feedback-uuid",
  "sessionId": "session-uuid",
  "score": 85,
  "confidence": 90,
  "sessionQuality": "Good",
  "verdict": "Recommended",
  ...
}
```

## Test Validation Checklist

### Functional Requirements
- [ ] Session created successfully
- [ ] Session activated and timer started
- [ ] Heartbeat maintains session
- [ ] AI answers generated for all questions
- [ ] Messages saved to session history
- [ ] Session deactivated cleanly
- [ ] Analytics generated

### Memory & Context Requirements
- [ ] **TC1**: Follow-up question references previous answer correctly
- [ ] **TC2**: AI explains its own code when asked
- [ ] **TC3**: "Next question" switches topics appropriately
- [ ] **TC4**: "New topic" resets context completely
- [ ] **TC5**: Long-term memory retained across 5+ questions
- [ ] **TC6**: AI asks for clarification when context is missing
- [ ] **TC7**: Resume data integrated into answers

### Quality Requirements
- [ ] No hallucinations or incorrect assumptions
- [ ] Answers are relevant and accurate
- [ ] Code examples are syntactically correct
- [ ] Response times are acceptable (< 30s)
- [ ] No duplicate or repeated answers
- [ ] Context switches are smooth

## Documentation

For each question, document:

1. **API Request**: Full request body
2. **API Response**: Full AI response
3. **Timestamp**: When the request was made
4. **Response Time**: How long the AI took to respond
5. **Test Result**: Pass/Fail for the specific test case
6. **Observations**: Any notable behavior or issues

## Troubleshooting

### Session Creation Fails (500 Error)
- Check that userId is the internal DB UUID, not Clerk ID
- Verify resumeId exists in database
- Ensure all required fields are present

### AI Answer Returns Error
- Check that OPENROUTER_API_KEY is set in .env
- Verify session is in ACTIVE status
- Check credit balance (should be free session)

### Heartbeat Returns CREDIT_EXHAUSTED
- Check maxAllowedMinutes setting
- Verify elapsed time calculation
- Ensure free: true is set for test session

### SSE Events Not Received
- Verify session is active
- Check firewall/network settings
- Ensure Authorization header is correct

## Next Steps

After completing manual testing:

1. **Compile Results**: Document all test results in markdown
2. **Identify Issues**: List any bugs or unexpected behavior
3. **Compare with Expected**: Create expected vs actual comparison table
4. **Generate Report**: Use the automated script or manual compilation
5. **Provide Recommendations**: Suggest improvements based on findings

## Automated Script Alternative

If you have valid authentication, you can run the automated script:

```bash
API_BASE_URL=http://localhost:3200/api npx tsx test-session-integration.ts
```

The script will:
- Handle authentication (if configured)
- Upload test assets
- Create and activate session
- Run all interview questions
- Validate memory and context
- Generate markdown report automatically
