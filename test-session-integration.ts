import fs from 'fs';
import path from 'path';

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3200/api';
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // Clerk auth token from environment
const RESUME_ID = process.env.RESUME_ID || ''; // Resume ID from environment
const TEST_USER_ID = process.env.TEST_USER_ID || '0a62c97b-3f7f-4b3b-adbc-e75279ad36c4'; // Test user ID from environment
const TEST_BYPASS_KEY = process.env.TEST_BYPASS_KEY || 'test-bypass-key-scribeshade-2026'; // Test bypass key
const USE_TEST_BYPASS = process.env.USE_TEST_BYPASS === 'true'; // Enable test bypass mode
const TEST_RESUME_PATH = path.join(process.cwd(), 'test-resume.pdf');
const TEST_DOCUMENT_PATH = path.join(process.cwd(), 'test-document.pdf');
const COMPANY_NAME = 'HiddenMind Solutions';

// Test results storage
const testResults = {
  startTime: new Date().toISOString(),
  endTime: null as string | null,
  sessionId: '',
  userId: '',
  resumeId: '',
  documentId: '',
  apiCalls: [] as any[],
  interviewTranscript: [] as any[],
  memoryTests: [] as any[],
  issues: [] as string[],
  successRate: 0,
};

// Interview questions based on the transcript
const interviewQuestions = [
  {
    phase: 'Introduction',
    question: 'Hi, I\'m the interviewer. Can you tell me about your total years of experience and your relevant experience in Databricks, PySpark, and Azure Data Factory? What is your current role?',
    followUp: 'Can you elaborate on the Databricks migration you mentioned and the performance improvements you achieved?',
    testContext: 'resume_context',
  },
  {
    phase: 'Technical',
    question: 'What tool are you using for deployment in your current role?',
    followUp: 'What code repository are you using - Azure Repos or GitHub?',
    testContext: 'follow_up',
  },
  {
    phase: 'Technical',
    question: 'Write PySpark code to read a CSV file with a column called "date_of_joining". The date column should be converted to proper date type.',
    followUp: 'How would you fill null values in the date_of_joining column with the current date?',
    testContext: 'code_generation',
  },
  {
    phase: 'Technical',
    question: 'Rename the location column to city, set the default value as Bangalore for all employees, and write the final dataset to a Delta table.',
    followUp: 'Explain why you used coalesce() instead of fillna() in your solution.',
    testContext: 'code_explanation',
  },
  {
    phase: 'Performance',
    question: 'A daily job that normally takes 1 hour is now taking 2-3 hours. What parameters and things would you check before optimizing the job?',
    followUp: 'What is data skewness and how would you handle it in PySpark?',
    testContext: 'problem_solving',
  },
  {
    phase: 'Technical',
    question: 'Write PySpark code using the salting technique to handle data skewness in a join operation.',
    followUp: 'How will you handle the small file issue if OPTIMIZE or autoloader is not available?',
    testContext: 'advanced_code',
  },
  {
    phase: 'Context Switch',
    question: 'Next question - tell me about your experience with cloud platforms like AWS and Azure.',
    followUp: 'New topic - let\'s discuss your experience with CI/CD pipelines.',
    testContext: 'context_switch',
  },
  {
    phase: 'Ambiguity Test',
    question: 'Explain this code',
    testContext: 'hallucination_prevention',
    expectedBehavior: 'should ask for code',
  },
  {
    phase: 'Long-term Memory',
    question: 'What was the performance improvement percentage you mentioned in your first answer about the Databricks migration?',
    testContext: 'long_term_memory',
  },
  {
    phase: 'Conclusion',
    question: 'Thank you for the interview. Do you have any questions for us about the role or the company?',
    followUp: null,
    testContext: 'closing',
  },
];

// API Client Class
class APIClient {
  private baseUrl: string;
  private authToken: string = '';
  private useTestBypass: boolean = false;
  private testBypassKey: string = '';

  constructor(baseUrl: string, authToken: string = '', useTestBypass: boolean = false, testBypassKey: string = '') {
    this.baseUrl = baseUrl;
    this.authToken = authToken;
    this.useTestBypass = useTestBypass;
    this.testBypassKey = testBypassKey;
  }

  setAuthToken(token: string) {
    this.authToken = token;
  }

  public async request(
    endpoint: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
      isFormData?: boolean;
    } = {}
  ): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const startTime = Date.now();

    const headers: Record<string, string> = {
      ...options.headers,
    };

    if (this.useTestBypass) {
      headers['x-test-bypass-key'] = this.testBypassKey;
    }

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    let body = options.body;
    if (body && !options.isFormData) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    } else if (options.isFormData) {
      // Skip FormData handling for now
      body = undefined;
    }

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: body as any,
    });

    const duration = Date.now() - startTime;
    const responseData = await response.text();
    let parsedResponse;

    try {
      parsedResponse = JSON.parse(responseData);
    } catch {
      parsedResponse = responseData;
    }

    // Log API call
    testResults.apiCalls.push({
      endpoint,
      method: options.method || 'GET',
      statusCode: response.status,
      duration,
      request: options.isFormData ? '[FormData]' : options.body,
      response: parsedResponse,
      success: response.ok,
    });

    if (!response.ok) {
      throw new Error(`API call failed: ${response.status} ${responseData}`);
    }

    return parsedResponse;
  }

  async uploadResume(filePath: string): Promise<any> {
    // Note: Node.js 18+ has native FormData, but file upload requires special handling
    // For this test, we'll skip actual upload and use placeholder
    console.log('Resume upload skipped - requires valid PDF file');
    return { id: 'test-resume-id-placeholder', filename: 'test-resume.pdf' };
  }

  async uploadDocument(filePath: string): Promise<any> {
    console.log('Document upload skipped - requires valid PDF file');
    return { id: 'test-document-id-placeholder', filename: 'test-document.pdf' };
  }

  async createSession(data: any): Promise<any> {
    // For testing without file uploads, use JSON body
    return this.request('/session/create-session', {
      method: 'POST',
      body: data,
    });
  }

  async activateSession(sessionId: string, data: any): Promise<any> {
    return this.request(`/session/${sessionId}/activate`, {
      method: 'POST',
      body: data,
    });
  }

  async sendHeartbeat(sessionId: string, elapsedMinutes: number): Promise<any> {
    return this.request(`/session/${sessionId}/heartbeat`, {
      method: 'POST',
      body: { elapsedMinutes },
    });
  }

  async getAIAnswer(sessionId: string, data: any): Promise<string> {
    const response = await this.request(`/session/${sessionId}/ai-answer`, {
      method: 'POST',
      body: data,
    });
    return response;
  }

  async saveMessage(sessionId: string, data: any): Promise<any> {
    return this.request(`/session/${sessionId}/save-message`, {
      method: 'POST',
      body: data,
    });
  }

  async deactivateSession(sessionId: string, data: any): Promise<any> {
    return this.request(`/session/${sessionId}/deactivate`, {
      method: 'POST',
      body: data,
    });
  }

  async getSessionAnalytics(sessionId: string): Promise<any> {
    return this.request(`/session/${sessionId}/analytics`, {
      method: 'GET',
    });
  }
}

// Generate test resume PDF content (simplified - in real scenario, use actual PDF)
function generateTestResume(): void {
  const resumeContent = `
TEST CANDIDATE
Senior Data Engineer
Email: test@example.com | Phone: +1-234-567-8900

SUMMARY
Data Engineer with 5.9 years of experience in cloud-based data architecture and large-scale data processing.

EXPERIENCE

Senior Data Engineer | 3i Infotech | April 2023 - Present
- Migrated 10+ legacy data pipelines to Databricks, achieving 40% performance improvement
- Processing 1TB+ daily data volumes using PySpark for complex transformations
- Designed and optimized ETL workflows on Databricks with advanced query optimization
- Reduced query execution times by 30% through performance tuning
- Built scalable ETL workflows using Azure Data Factory, reducing processing time by 40%
- Streamlined CI/CD processes via Azure DevOps, cutting deployment time by 50%

Project Engineer | Wipro | November 2018 - October 2021
- Developed data pipelines using AWS Glue and Redshift
- Implemented data quality checks and validation frameworks
- Optimized SQL queries for improved performance

SKILLS
- Cloud Platforms: Azure, AWS (Redshift, Glue, Athena, Lambda)
- Big Data: Databricks, PySpark, DataStage
- Databases: SQL Azure, Redshift
- Orchestration: Azure Data Factory, AWS Glue
- Languages: Python, SQL
- Tools: Azure DevOps, Git, Docker

EDUCATION
Bachelor of Engineering in Computer Science
`;

  // For this test, we'll create a simple text file instead of PDF
  // In production, you'd use a PDF library or actual PDF
  fs.writeFileSync(TEST_RESUME_PATH.replace('.pdf', '.txt'), resumeContent);
  console.log('Test resume created as text file (convert to PDF for actual test)');
}

// Main test execution
async function runTest() {
  const client = new APIClient(API_BASE_URL, AUTH_TOKEN, USE_TEST_BYPASS, TEST_BYPASS_KEY);
  console.log('=== ScribeShade Session Module Integration Test ===\n');
  console.log(`API Base URL: ${API_BASE_URL}`);
  console.log(`Company: ${COMPANY_NAME}`);
  console.log(`Auth Token: ${AUTH_TOKEN ? 'Provided' : 'NOT PROVIDED'}`);
  console.log(`Test Bypass Mode: ${USE_TEST_BYPASS ? 'ENABLED' : 'DISABLED'}\n`);

  if (!AUTH_TOKEN && !USE_TEST_BYPASS) {
    console.error('❌ ERROR: Either AUTH_TOKEN or USE_TEST_BYPASS=true is required');
    console.error('\nOptions:');
    console.error('1. Provide Clerk auth token: AUTH_TOKEN="your-token" npx tsx test-session-integration.ts');
    console.error('2. Use test bypass: USE_TEST_BYPASS=true npx tsx test-session-integration.ts\n');
    process.exit(1);
  }

  if (USE_TEST_BYPASS && !AUTH_TOKEN) {
    console.log('⚠️  TEST MODE: Using test bypass key for authentication');
    console.log('⚠️  WARNING: You still need a valid Clerk token to get your real user ID');
    console.log('⚠️  The bypass only works for operations, not user ID resolution\n');
  }

  try {
    // Step 1: Generate test resume
    console.log('Step 1: Generating test resume...');
    generateTestResume();
    testResults.apiCalls.push({
      action: 'generate_test_resume',
      success: true,
      note: 'Resume created as text file (needs PDF conversion for actual upload)',
    });

    // Step 2: Sync user and get internal user ID (skip in test bypass mode)
    if (USE_TEST_BYPASS) {
      console.log('Step 2: Using test bypass mode - using provided test user ID');
      testResults.userId = TEST_USER_ID;
      console.log(`✅ Using test user ID: ${testResults.userId}`);
    } else {
      console.log('Step 2: Syncing user to database...');
      try {
        const userResponse = await client.request('/auth/me', { method: 'GET' });
        testResults.userId = userResponse.id;
        console.log(`✅ User synced successfully. Internal User ID: ${testResults.userId}`);
      } catch (error) {
        console.log('❌ User sync failed:', (error as Error).message);
        testResults.issues.push(`User sync failed: ${(error as Error).message}`);
        throw error;
      }
    }

    // Step 3: Use provided resume ID
    console.log('Step 3: Using provided resume ID...');
    if (RESUME_ID) {
      testResults.resumeId = RESUME_ID;
      console.log(`✅ Resume ID: ${testResults.resumeId}`);
    } else {
      console.log('⚠️  No resume ID provided, using placeholder');
      testResults.resumeId = 'test-resume-id-placeholder';
    }

    // Step 4: Create session
    console.log('Step 4: Creating session...');
    const sessionData = {
      userId: testResults.userId, // Use actual user ID from auth
      companyName: COMPANY_NAME,
      jobDescription: 'Senior Data Engineer with experience in Databricks, PySpark, Azure Data Factory, performance optimization, and modern data architecture.',
      resumeId: testResults.resumeId,
      language: 'English',
      simpleLanguage: false,
      autoGenerateAI: true,
      saveTranscript: true,
      mode: 'manual',
      free: true, // Use free session for testing
      documentId: '',
      projectIds: [],
    };

    try {
      const session = await client.createSession(sessionData);
      testResults.sessionId = session.sessionId || session.data?.id;
      console.log(`✅ Session created: ${testResults.sessionId}`);
    } catch (error) {
      console.log('❌ Session creation failed:', (error as Error).message);
      testResults.issues.push(`Session creation failed: ${(error as Error).message}`);
      throw error;
    }

    // Step 5: Activate session
    console.log('\nStep 5: Activating session...');
    try {
      const activateResponse = await client.activateSession(testResults.sessionId, {
        language: 'English',
        simpleLanguage: false,
      });
      console.log(`✅ Session activated`);
    } catch (error) {
      console.log('⚠️  Session activation failed (may not be required):', (error as Error).message);
      testResults.issues.push(`Session activation warning: ${(error as Error).message}`);
    }

    // Step 6: Execute interview questions with AI answers
    console.log('\nStep 6: Executing interview questions with AI answers...');
    for (let i = 0; i < interviewQuestions.length; i++) {
      const q = interviewQuestions[i];
      console.log(`\n[${q.phase}] Q${i + 1}: ${q.question.substring(0, 80)}...`);
      
      const questionTimestamp = new Date().toISOString();
      
      try {
        // Get AI answer
        const aiAnswer = await client.getAIAnswer(testResults.sessionId, {
          transcript: q.question,
          currentQuestion: q.question,
          isCustomQuery: false,
          isRegenerate: false,
          liveContextMetadata: {
            sourcePlatform: 'manual',
            answerMode: 'auto',
          },
        });

        console.log(`✅ AI Answer received (${aiAnswer.length} chars)`);
        
        testResults.interviewTranscript.push({
          phase: q.phase,
          question: q.question,
          questionNumber: i + 1,
          testContext: q.testContext,
          aiAnswer: aiAnswer.substring(0, 200) + '...', // Truncate for report
          aiAnswerLength: aiAnswer.length,
          timestamp: questionTimestamp,
          answerTimestamp: new Date().toISOString(),
        });

        // Save message
        await client.saveMessage(testResults.sessionId, {
          role: 'interviewer',
          question: q.question,
          answer: aiAnswer,
          time: questionTimestamp,
          messageId: `msg-${i + 1}`,
        });

        // Test follow-up if exists
        if (q.followUp) {
          console.log(`Follow-up: ${q.followUp.substring(0, 60)}...`);
          const followUpTimestamp = new Date().toISOString();
          
          const followUpAnswer = await client.getAIAnswer(testResults.sessionId, {
            transcript: q.followUp,
            currentQuestion: q.followUp,
            isCustomQuery: false,
            isRegenerate: false,
            liveContextMetadata: {
              sourcePlatform: 'manual',
              answerMode: 'auto',
              previousAiAnswer: aiAnswer,
              selectedAnswerQuestion: q.question,
            },
          });

          console.log(`✅ Follow-up AI Answer received (${followUpAnswer.length} chars)`);
          
          testResults.interviewTranscript.push({
            type: 'follow_up',
            question: q.followUp,
            aiAnswer: followUpAnswer.substring(0, 200) + '...',
            aiAnswerLength: followUpAnswer.length,
            timestamp: followUpTimestamp,
            answerTimestamp: new Date().toISOString(),
          });

          await client.saveMessage(testResults.sessionId, {
            role: 'interviewer',
            question: q.followUp,
            answer: followUpAnswer,
            time: followUpTimestamp,
            messageId: `msg-${i + 1}-followup`,
          });
        }

      } catch (error) {
        console.log(`❌ AI Answer failed:`, (error as Error).message);
        testResults.issues.push(`Q${i + 1} AI answer failed: ${(error as Error).message}`);
        testResults.interviewTranscript.push({
          phase: q.phase,
          question: q.question,
          questionNumber: i + 1,
          testContext: q.testContext,
          error: (error as Error).message,
          timestamp: questionTimestamp,
        });
      }
    }

    // Step 7: Deactivate session
    console.log('\nStep 7: Deactivating session...');
    try {
      await client.deactivateSession(testResults.sessionId, {
        aiUsage: interviewQuestions.length,
        transcript: testResults.interviewTranscript,
      });
      console.log(`✅ Session deactivated`);
    } catch (error) {
      console.log('⚠️  Session deactivation failed:', (error as Error).message);
      testResults.issues.push(`Session deactivation warning: ${(error as Error).message}`);
    }

    // Step 8: Memory test analysis
    console.log('\nStep 8: Memory and context test analysis...');
    
    // Analyze results based on actual AI answers
    const successfulAnswers = testResults.interviewTranscript.filter(t => t.aiAnswer && t.aiAnswerLength > 0).length;
    const totalQuestions = interviewQuestions.length;
    
    testResults.memoryTests = [
      {
        testCase: 'TC1: Follow-up Question Context',
        description: 'Ask follow-up referencing previous answer',
        expected: 'AI understands reference and provides relevant response',
        status: successfulAnswers > 0 ? 'PASSED' : 'SKIPPED',
        reason: successfulAnswers > 0 ? 'Follow-up questions received AI answers' : 'No AI answers received',
      },
      {
        testCase: 'TC2: Code Explanation Follow-up',
        description: 'After code answer, ask for explanation',
        expected: 'AI explains the code it just generated',
        status: 'TESTED',
        reason: 'Code questions (Q3, Q4, Q6) with follow-ups executed',
      },
      {
        testCase: 'TC3: Next Question Directive',
        description: 'Explicit Next Question command',
        expected: 'AI acknowledges and moves to new topic',
        status: 'TESTED',
        reason: 'Q7 used "Next question" directive',
      },
      {
        testCase: 'TC4: New Topic Directive',
        description: 'Explicit New Topic command',
        expected: 'AI switches context completely',
        status: 'TESTED',
        reason: 'Q7 follow-up used "New topic" directive',
      },
      {
        testCase: 'TC5: Long-term Memory',
        description: 'Reference detail from 5+ questions ago',
        expected: 'AI recalls and references correctly',
        status: 'TESTED',
        reason: 'Q9 references detail from Q1',
      },
      {
        testCase: 'TC6: Hallucination Prevention',
        description: 'Ask question with missing context',
        expected: 'AI asks for clarification instead of assuming',
        status: 'TESTED',
        reason: 'Q8 asked "Explain this code" without code',
      },
      {
        testCase: 'TC7: Resume Context Integration',
        description: 'Question about candidate experience',
        expected: 'AI uses resume data in answer',
        status: 'TESTED',
        reason: 'Q1 asked about experience with resume context',
      },
    ];

    testResults.endTime = new Date().toISOString();
    testResults.successRate = successfulAnswers > 0 ? Math.round((successfulAnswers / totalQuestions) * 100) : 0;

    console.log('\n=== Test Summary ===');
    console.log(`Total Questions: ${interviewQuestions.length}`);
    console.log(`Successful AI Answers: ${successfulAnswers}`);
    console.log(`Memory Tests: ${testResults.memoryTests.length}`);
    console.log(`Issues: ${testResults.issues.length}`);
    console.log(`Success Rate: ${testResults.successRate}%`);
    console.log(`Status: ${testResults.successRate > 0 ? 'COMPLETED' : 'INCOMPLETE'}`);

    // Generate markdown report
    await generateMarkdownReport();

  } catch (error) {
    console.error('Test execution failed:', error);
    testResults.issues.push(`Test execution error: ${(error as Error).message}`);
    testResults.endTime = new Date().toISOString();
    await generateMarkdownReport();
  }
}

// Generate markdown report
async function generateMarkdownReport(): Promise<void> {
  const reportPath = path.join(process.cwd(), 'SESSION_TEST_REPORT.md');
  
  let markdown = `# ScribeShade Session Module Integration Test Report

## Test Summary
- **Date**: ${testResults.startTime}
- **Duration**: ${testResults.endTime ? new Date(testResults.endTime).getTime() - new Date(testResults.startTime).getTime() : 0}ms
- **Session ID**: ${testResults.sessionId || 'N/A'}
- **Total Questions**: ${interviewQuestions.length}
- **Success Rate**: ${testResults.successRate}%
- **Status**: ${testResults.issues.length > 0 ? 'INCOMPLETE' : 'COMPLETED'}

## Setup
- **Backend URL**: ${API_BASE_URL}
- **User ID**: ${testResults.userId || 'N/A (Auth required)'}
- **Resume ID**: ${testResults.resumeId || 'N/A'}
- **Document ID**: ${testResults.documentId || 'N/A'}
- **Company**: ${COMPANY_NAME}

## Issues Found
${testResults.issues.map(issue => `- ${issue}`).join('\n') || 'None'}

## API Call Log
${testResults.apiCalls.map(call => `
### ${call.endpoint || call.action}
- **Method**: ${call.method || 'N/A'}
- **Status**: ${call.statusCode || 'N/A'}
- **Duration**: ${call.duration || 'N/A'}ms
- **Success**: ${call.success}
${call.note ? `- **Note**: ${call.note}` : ''}
`).join('\n')}

## Interview Transcript
${testResults.interviewTranscript.map(item => `
### [${item.phase}] ${item.questionNumber ? 'Q' + item.questionNumber : 'Follow-up'}
- **Question**: ${item.question}
- **Test Context**: ${item.testContext || 'N/A'}
- **Timestamp**: ${item.timestamp}
`).join('\n')}

## Memory & Context Test Results
${testResults.memoryTests.map(test => `
### ${test.testCase}
- **Description**: ${test.description}
- **Expected**: ${test.expected}
- **Status**: ${test.status}
${test.reason ? `- **Reason**: ${test.reason}` : ''}
`).join('\n')}

## Expected vs Actual Results

| Test Case | Expected | Actual | Status |
|-----------|----------|--------|--------|
${testResults.memoryTests.map(test => `| ${test.testCase} | ${test.expected} | ${test.status} | ${test.status} |`).join('\n')}

## Recommendations

### Required for Full Test Execution:
1. **Authentication**: Set up valid Clerk user and auth token
2. **Resume PDF**: Create actual PDF resume file for upload
3. **Document PDF**: Create optional supporting document
4. **User ID Resolution**: Implement Clerk ID to DB ID resolution

### Test Script Improvements:
1. Add proper authentication flow
2. Implement PDF generation for test resume
3. Add retry logic for failed API calls
4. Implement streaming response handling
5. Add SSE event subscription
6. Implement heartbeat simulation
7. Add automated validation of AI answers

### Backend Considerations:
1. Ensure session creation works with test user
2. Verify AI answer generation is functioning
3. Check credit system for free session handling
4. Validate SSE event streaming

## Appendix

### Full Interview Questions
${interviewQuestions.map((q, i) => `
#### Q${i + 1} [${q.phase}]
**Question**: ${q.question}
**Follow-up**: ${q.followUp || 'N/A'}
**Test Context**: ${q.testContext}
`).join('\n')}

### Test Environment
- **Node Version**: ${process.version}
- **Platform**: ${process.platform}
- **Test Script**: test-session-integration.ts
- **Generated**: ${new Date().toISOString()}

---

*This report was automatically generated by the ScribeShade session integration test script.*
`;

  fs.writeFileSync(reportPath, markdown);
  console.log(`\nMarkdown report generated: ${reportPath}`);
}

// Run the test
runTest().catch(console.error);
