#!/bin/bash

# ScribeShade Session Module - Manual Test Script
# Run this script step-by-step with a fresh Clerk auth token

echo "=== ScribeShade Session Module Manual Test ==="
echo ""
echo "IMPORTANT: You need a FRESH Clerk auth token"
echo "1. Sign in to ScribeShade app in browser"
echo "2. Open DevTools (F12) → Application → Local Storage"
echo "3. Copy the __session token value"
echo "4. Paste it when prompted below"
echo ""

read -p "Enter your Clerk auth token: " AUTH_TOKEN
read -p "Enter your Resume ID (press Enter to use 08252877-5c53-4cb3-9938-9db090806c6f): " RESUME_ID

RESUME_ID=${RESUME_ID:-"08252877-5c53-4cb3-9938-9db090806c6f"}
API_BASE="http://localhost:3200/api"
COMPANY="HiddenMind Solutions"

echo ""
echo "=== Step 1: Sync User to Database ==="
USER_RESPONSE=$(curl -s -X GET "$API_BASE/auth/me" \
  -H "Authorization: Bearer $AUTH_TOKEN")
echo "Response: $USER_RESPONSE"

if echo "$USER_RESPONSE" | grep -q "id"; then
  USER_ID=$(echo "$USER_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
  echo "✅ User ID: $USER_ID"
else
  echo "❌ User sync failed. Token may be invalid or expired."
  exit 1
fi

echo ""
echo "=== Step 2: Create Session ==="
SESSION_RESPONSE=$(curl -s -X POST "$API_BASE/session/create-session" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"companyName\": \"$COMPANY\",
    \"jobDescription\": \"Senior Data Engineer with experience in Databricks, PySpark, Azure Data Factory, performance optimization, and modern data architecture.\",
    \"resumeId\": \"$RESUME_ID\",
    \"language\": \"English\",
    \"simpleLanguage\": false,
    \"autoGenerateAI\": true,
    \"saveTranscript\": true,
    \"mode\": \"manual\",
    \"free\": true,
    \"documentId\": \"\",
    \"projectIds\": []
  }")
echo "Response: $SESSION_RESPONSE"

if echo "$SESSION_RESPONSE" | grep -q "sessionId"; then
  SESSION_ID=$(echo "$SESSION_RESPONSE" | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4)
  echo "✅ Session ID: $SESSION_ID"
else
  echo "❌ Session creation failed"
  exit 1
fi

echo ""
echo "=== Step 3: Activate Session ==="
ACTIVATE_RESPONSE=$(curl -s -X POST "$API_BASE/session/$SESSION_ID/activate" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"language\": \"English\",
    \"simpleLanguage\": false
  }")
echo "Response: $ACTIVATE_RESPONSE"

echo ""
echo "=== Step 4: Test AI Answer (Question 1) ==="
AI_RESPONSE=$(curl -s -X POST "$API_BASE/session/$SESSION_ID/ai-answer" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"transcript\": \"Hi, I'm the interviewer. Can you tell me about your total years of experience and your relevant experience in Databricks, PySpark, and Azure Data Factory? What is your current role?\",
    \"currentQuestion\": \"Hi, I'm the interviewer. Can you tell me about your total years of experience and your relevant experience in Databricks, PySpark, and Azure Data Factory? What is your current role?\",
    \"isCustomQuery\": false,
    \"isRegenerate\": false,
    \"liveContextMetadata\": {
      \"sourcePlatform\": \"manual\",
      \"answerMode\": \"auto\"
    }
  }")
echo "Response: $AI_RESPONSE"

echo ""
echo "=== Step 5: Save Message ==="
SAVE_RESPONSE=$(curl -s -X POST "$API_BASE/session/$SESSION_ID/save-message" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"role\": \"interviewer\",
    \"question\": \"Hi, I'm the interviewer. Can you tell me about your total years of experience and your relevant experience in Databricks, PySpark, and Azure Data Factory? What is your current role?\",
    \"answer\": \"$AI_RESPONSE\",
    \"time\": \"$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")\",
    \"messageId\": \"msg-1\"
  }")
echo "Response: $SAVE_RESPONSE"

echo ""
echo "=== Step 6: Deactivate Session ==="
DEACTIVATE_RESPONSE=$(curl -s -X POST "$API_BASE/session/$SESSION_ID/deactivate" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"aiUsage\": 1,
    \"transcript\": []
  }")
echo "Response: $DEACTIVATE_RESPONSE"

echo ""
echo "=== Step 7: Get Session Analytics ==="
ANALYTICS_RESPONSE=$(curl -s -X GET "$API_BASE/session/$SESSION_ID/analytics" \
  -H "Authorization: Bearer $AUTH_TOKEN")
echo "Response: $ANALYTICS_RESPONSE"

echo ""
echo "=== Test Complete ==="
echo "Session ID: $SESSION_ID"
echo "User ID: $USER_ID"
echo "Resume ID: $RESUME_ID"
echo ""
echo "All results have been logged above."
